// mcp.ts — Model Context Protocol over Streamable HTTP at /mcp.
//
// JSON-RPC 2.0, revision 2026-07-28 via server/discover, with the legacy
// initialize handshake for older revisions. Plain application/json answers.
// Rules (checks-mcp.ts): tools/list is byte-identical across calls; unknown tools
// answer -32601/-32602, never HTTP 500; a body that is not JSON is HTTP 400 with
// -32700; a tools/call missing a required argument is -32602 or isError:true;
// a call with no Authorization header is 401, decided before tool existence.

import type { ForgeRes } from './app.ts';
import { VIEWER, type ForgeStore, type Repo } from './store.ts';
import { mergePullSquash, sendJson } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'forge-session-1';

export interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login (the authenticated user).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find a tool by the suite's rule: exact canonical/alias match, then suffix match. */
function findTool(name: string): ToolDef | undefined {
  const wanted = normalize(name);
  for (const tool of TOOLS) {
    const candidates = [tool.name, ...(ALIASES[tool.name] ?? [])].map(normalize);
    if (candidates.includes(wanted)) return tool;
  }
  for (const tool of TOOLS) {
    const candidates = [tool.name, ...(ALIASES[tool.name] ?? [])].map(normalize);
    for (const candidate of candidates) {
      if (wanted.length > candidate.length && wanted.endsWith(candidate)) return tool;
    }
  }
  return undefined;
}

/** The tools/list payload, built once so two calls are byte-identical. */
const TOOLS_LIST_PAYLOAD = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveOwnerRepo(args: JsonObject): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const [o, r] = (args.full_name as string).split('/');
    if (owner === '' && o !== undefined) owner = o;
    if (repo === '' && r !== undefined) repo = r;
  }
  return { owner, repo };
}

function repoJson(store: ForgeStore, repo: Repo): JsonObject {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

function callTool(store: ForgeStore, tool: ToolDef, args: JsonObject): { ok: boolean; result: JsonObject; error?: string } {
  // Required arguments: a missing one is an invalid-params error.
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, result: {}, error: `Missing required argument: ${required}` };
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const name = String(args.name ?? '');
      const existing = store.getRepo(VIEWER.login, name);
      if (existing !== undefined) return { ok: true, result: repoJson(store, existing) };
      const repo = store.createRepo(VIEWER.login, name, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { ok: true, result: repoJson(store, repo) };
    }
    case 'get_repo': {
      const { owner, repo: name } = resolveOwnerRepo(args);
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { ok: false, result: {}, error: `Repository ${owner}/${name} not found` };
      return { ok: true, result: repoJson(store, repo) };
    }
    case 'create_issue': {
      const { owner, repo: name } = resolveOwnerRepo(args);
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { ok: false, result: {}, error: `Repository ${owner}/${name} not found` };
      const issue = {
        id: repo.id * 100000 + repo.nextIssue,
        number: repo.nextIssue,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as never[],
        seq: repo.nextIssue,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return { ok: true, result: { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: 'open' } };
    }
    case 'list_issues': {
      const { owner, repo: name } = resolveOwnerRepo(args);
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { ok: false, result: {}, error: `Repository ${owner}/${name} not found` };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return { ok: true, result: { issues: list } };
    }
    case 'create_pull_request': {
      const { owner, repo: name } = resolveOwnerRepo(args);
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { ok: false, result: {}, error: `Repository ${owner}/${name} not found` };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (headSha === null || baseSha === null) return { ok: false, result: {}, error: `Head or base branch does not exist` };
      const pull = {
        id: repo.id * 100000 + repo.nextPull,
        number: repo.nextPull,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        createdBaseSha: baseSha,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        seq: repo.nextPull,
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return { ok: true, result: { id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: 'open', head, base } };
    }
    case 'merge_pull_request': {
      const { owner, repo: name } = resolveOwnerRepo(args);
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { ok: false, result: {}, error: `Repository ${owner}/${name} not found` };
      const number = Number(args.pull_number ?? args.number ?? NaN);
      const pull = repo.pulls.find((item) => item.number === number);
      if (pull === undefined) return { ok: false, result: {}, error: `Pull request ${number} not found` };
      const mergeSha = mergePullSquash(store, repo, pull);
      if (mergeSha === null) return { ok: false, result: {}, error: 'Merge conflict: the pull request cannot be merged cleanly' };
      return { ok: true, result: { number: pull.number, merged: true, sha: mergeSha, state: 'closed' } };
    }
    default:
      return { ok: false, result: {}, error: `Unknown tool ${tool.name}` };
  }
}

export async function handleMcp(ctx: { store: ForgeStore; token: string }, req: { headers: Record<string, string | string[] | undefined>; method?: string }, res: ForgeRes, bodyText: string): Promise<void> {
  const { store } = ctx;

  if (req.method === 'DELETE') {
    res.writeHead(204, { 'mcp-session-id': SESSION_ID });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return;
  }

  // Auth is decided before tool existence.
  const header = req.headers.authorization ?? '';
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (presented.length === 0 || (ctx.token !== '' && presented !== ctx.token)) {
    sendJson(res, store, 401, { message: 'Requires authentication' });
    return;
  }

  let rpc: unknown;
  try {
    rpc = JSON.parse(bodyText);
  } catch {
    sendJson(res, store, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON.' } });
    return;
  }
  if (!isObject(rpc) || typeof rpc.method !== 'string') {
    sendJson(res, store, 400, { jsonrpc: '2.0', id: isObject(rpc) ? (rpc.id ?? null) : null, error: { code: -32700, message: 'Parse error: not a JSON-RPC request object.' } });
    return;
  }

  const id = rpc.id ?? null;
  const method = rpc.method as string;
  const params = isObject(rpc.params) ? rpc.params : {};
  const sessionHeaders = { 'mcp-session-id': SESSION_ID };

  const result = (value: unknown): void => {
    sendJson(res, store, 200, { jsonrpc: '2.0', id, result: value }, sessionHeaders);
  };
  const error = (code: number, message: string): void => {
    sendJson(res, store, 200, { jsonrpc: '2.0', id, error: { code, message } }, sessionHeaders);
  };

  // Notifications carry no id and expect no result.
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'mcp-session-id': SESSION_ID });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    result({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = supported.includes(offered) ? offered : '2026-07-28';
    result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'ping') {
    result({});
    return;
  }

  if (method === 'tools/list') {
    result(TOOLS_LIST_PAYLOAD);
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(name);
    if (tool === undefined) {
      error(-32601, `Method not found: tool ${name} does not exist`);
      return;
    }
    const args = isObject(params.arguments) ? params.arguments : {};
    const outcome = callTool(store, tool, args);
    if (!outcome.ok) {
      // A missing required argument is -32602; anything else is a tool error.
      if ((outcome.error ?? '').startsWith('Missing required argument')) {
        error(-32602, outcome.error as string);
        return;
      }
      result({ content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }], structuredContent: { error: outcome.error }, isError: true });
      return;
    }
    result({
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: false,
    });
    return;
  }

  error(-32601, `Method not found: ${method}`);
}

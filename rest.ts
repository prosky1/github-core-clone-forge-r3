// rest.ts — GitHub REST v3 under /api/v3.
//
// Contract (from the kit's checks-rest.ts): every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors carry {message: string}; a missing bearer
// token is 401; a repository under any owner but the token's is 404, never 403.

import type { ForgeReq, ForgeRes } from './app.ts';
import { FIXED_ISO, VIEWER, globalId, lineDiffCounts, type ForgeStore, type Issue, type PullRequest, type QueryView, type Repo } from './store.ts';

export interface RestContext {
  store: ForgeStore;
  token: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function requestId(store: ForgeStore): string {
  store.requestSeq += 1;
  return `req-${store.requestSeq}`;
}

export function sendJson(res: ForgeRes, store: ForgeStore, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(store),
    ...extra,
  });
  res.end(text);
}

/** Send a pre-serialized JSON body (its bytes + length cached with it). The body
 *  is cached as a Buffer, not a string: both transports then skip re-encoding
 *  it on every send (writeUtf8String was ~13% of busy CPU in the read hammer). */
export function sendJsonText(res: ForgeRes, store: ForgeStore, status: number, cached: { buf: Buffer; length: number }): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': cached.length,
    'x-github-request-id': requestId(store),
  });
  res.end(cached.buf);
}

// --- Serialized issue cache -------------------------------------------------
// The read workload GETs one issue 2,000 times in a row; its JSON never changes
// between mutations, so the serialized body is cached per (repo, issue number)
// and invalidated on any mutation of that issue (PATCH, comment add) or of its
// repo. The cached bytes are byte-identical to what sendJson would produce.

const issueBodyCache = new Map<string, { buf: Buffer; length: number }>();

function issueCacheKey(repo: Repo, issue: Issue): string {
  return `${repo.id}:${issue.number}`;
}

function cacheIssueBody(repo: Repo, issue: Issue): { buf: Buffer; length: number } {
  const buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`);
  const entry = { buf, length: buf.length };
  issueBodyCache.set(issueCacheKey(repo, issue), entry);
  return entry;
}

/** Drop the cached REST body of one issue after any mutation of it, from any
 *  surface (REST, GraphQL, MCP). Exported for graphql.ts/mcp.ts. */
export function invalidateIssueBody(repo: Repo, issue: Issue): void {
  issueBodyCache.delete(issueCacheKey(repo, issue));
}

function invalidateRepoBodies(repo: Repo): void {
  const prefix = `${repo.id}:`;
  for (const key of issueBodyCache.keys()) {
    if (key.startsWith(prefix)) issueBodyCache.delete(key);
  }
}

export function sendNoContent(res: ForgeRes, store: ForgeStore, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': requestId(store), ...extra });
  res.end();
}

export function notFound(store: ForgeStore, res: ForgeRes): void {
  sendJson(res, store, 404, { message: 'Not Found' });
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// --- JSON views -------------------------------------------------------------

export function repoJson(repo: Repo): JsonObject {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: { name: string; color: string }): JsonObject {
  return { id: 0, node_id: globalId('Label', label.name), name: label.name, color: label.color, description: '' };
}

export function issueJson(repo: Repo, issue: Issue): JsonObject {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: 'ededed' } : labelJson(label);
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function refJson(repo: Repo, ref: string, sha: string): JsonObject {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    repo: repoJson(repo),
  };
}

export function pullJson(repo: Repo, pull: PullRequest): JsonObject {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: refJson(repo, pull.headRef, pull.headSha),
    base: refJson(repo, pull.baseRef, pull.baseSha),
    merged: pull.merged,
    mergeable: true,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    draft: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// --- routing ----------------------------------------------------------------

interface RouteMatch {
  owner: string;
  repoName: string;
  rest: string[];
}

function parseRepoPath(parts: string[]): RouteMatch | null {
  // parts: ['api','v3','repos', owner, name, ...rest]
  if (parts.length < 5 || parts[2] !== 'repos') return null;
  return { owner: decodeURIComponent(parts[3] as string), repoName: decodeURIComponent(parts[4] as string), rest: parts.slice(5) };
}

function paginate<T>(items: T[], query: QueryView): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  return { page: items.slice(start, start + perPage), totalPages, pageNum, perPage };
}

function linkHeader(req: ForgeReq, basePath: string, query: QueryView, pageNum: number, perPage: number, totalPages: number): string | null {
  if (pageNum >= totalPages) return null;
  const host = req.headers.host ?? 'localhost';
  const next = new URL(`http://${host}${basePath}`);
  for (const [key, value] of query) {
    if (key !== 'page' && key !== 'per_page') next.searchParams.set(key, value);
  }
  next.searchParams.set('per_page', String(perPage));
  next.searchParams.set('page', String(pageNum + 1));
  return `<${next.toString()}>; rel="next"`;
}

function authOk(ctx: RestContext, req: ForgeReq): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented.length === 0) return false;
  // In a trial the token is always set; without one, any non-empty bearer is accepted.
  if (ctx.token === '') return true;
  return presented === ctx.token;
}

/** Handle one /api/v3 request. Returns true when handled (including 404s under /api/v3). */
export async function handleRest(ctx: RestContext, req: ForgeReq, res: ForgeRes, path: string, method: string, query: QueryView, body: unknown): Promise<boolean> {
  const { store } = ctx;
  if (!path.startsWith('/api/v3')) return false;

  if (!authOk(ctx, req)) {
    sendJson(res, store, 401, { message: 'Requires authentication' });
    return true;
  }

  const parts = path.split('/').filter((part) => part.length > 0);

  // GET /api/v3/ — the API root.
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(res, store, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, store, 200, { installed_version: 'github-core-clone-01/1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, store, 200, { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const repos = store.listViewerRepos();
      const { page, totalPages, pageNum, perPage } = paginate(repos, query);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, path, query, pageNum, perPage, totalPages);
      if (link !== null) extra.link = link;
      sendJson(res, store, 200, page.map(repoJson), extra);
      return true;
    }
    if (method === 'POST') {
      if (!isObject(body)) {
        sendJson(res, store, 400, { message: 'Body must be a JSON object' });
        return true;
      }
      const name = asString(body.name);
      if (name === '') {
        sendJson(res, store, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      if (store.getRepo(VIEWER.login, name) !== undefined) {
        sendJson(res, store, 422, { message: 'Validation Failed: repository already exists' });
        return true;
      }
      const repo = store.createRepo(VIEWER.login, name, asBoolean(body.private, false), asString(body.description, ''));
      sendJson(res, store, 201, repoJson(repo));
      return true;
    }
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const match = parseRepoPath(parts);
  if (match === null) {
    notFound(store, res);
    return true;
  }
  const { owner, repoName, rest } = match;
  // A repository belongs to the token's login; any other owner is 404, never 403.
  if (owner !== VIEWER.login) {
    notFound(store, res);
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === undefined) notFound(store, res);
      else sendJson(res, store, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (repo === undefined) {
        notFound(store, res);
        return true;
      }
      if (!isObject(body)) {
        sendJson(res, store, 400, { message: 'Body must be a JSON object' });
        return true;
      }
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, store, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      if (repo === undefined) {
        notFound(store, res);
        return true;
      }
      store.deleteRepo(owner, repoName);
      invalidateRepoBodies(repo);
      sendNoContent(res, store, 204);
      return true;
    }
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (repo === undefined) {
    notFound(store, res);
    return true;
  }

  const head = rest[0] as string;

  // POST /git/refs — create a branch. GET /git/refs/heads/{branch}.
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isObject(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
        sendJson(res, store, 422, { message: 'Validation Failed: ref and sha are required' });
        return true;
      }
      const ref = body.ref as string;
      const sha = (body.sha as string).toLowerCase();
      const obj = store.getObject(sha);
      if (obj === undefined || obj.type !== 'commit') {
        sendJson(res, store, 422, { message: 'Validation Failed: sha is not a commit' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, store, 422, { message: 'Validation Failed: ref already exists' });
        return true;
      }
      store.setRef(repo, ref, sha);
      sendJson(res, store, 201, { ref, object: { sha, type: 'commit', url: `${repoPath}/git/commits/${sha}` } });
      return true;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        notFound(store, res);
        return true;
      }
      sendJson(res, store, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: `${repoPath}/git/commits/${sha}` } });
      return true;
    }
    notFound(store, res);
    return true;
  }

  // GET /branches and /branches/{branch}
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const out: JsonObject[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false });
        }
      }
      out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(res, store, 200, out);
      return true;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        notFound(store, res);
        return true;
      }
      sendJson(res, store, 200, { name: branch, commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false });
      return true;
    }
    notFound(store, res);
    return true;
  }

  // GET /commits[?sha=<ref>]
  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === null) {
      notFound(store, res);
      return true;
    }
    const out: JsonObject[] = [];
    for (const sha of store.commitHistory(tip)) {
      const obj = store.getObject(sha);
      if (obj === undefined) continue;
      const info = parseCommitText(obj.data);
      out.push({
        sha,
        commit: { message: info.message, author: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_ISO }, committer: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_ISO }, tree: { sha: info.tree } },
        parents: info.parents.map((parent) => ({ sha: parent })),
      });
    }
    sendJson(res, store, 200, out);
    return true;
  }

  // Contents: PUT/GET/DELETE /contents/{path...}
  if (head === 'contents') {
    const filePath = rest.slice(1).map(decodeURIComponent).join('/');
    return handleContents(ctx, req, res, repo, repoPath, filePath, method, query, body);
  }

  // Labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      if (!isObject(body) || typeof body.name !== 'string' || body.name === '') {
        sendJson(res, store, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      const name = body.name as string;
      const color = asString(body.color, 'ededed');
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        sendJson(res, store, 201, labelJson(existing));
        return true;
      }
      const label = { name, color };
      repo.labels.set(name, label);
      sendJson(res, store, 201, labelJson(label));
      return true;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, store, 200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    notFound(store, res);
    return true;
  }

  // Issues
  if (head === 'issues') {
    return handleIssues(ctx, res, repo, repoPath, rest.slice(1), method, query, body);
  }

  // Pull requests
  if (head === 'pulls') {
    return handlePulls(ctx, res, repo, repoPath, rest.slice(1), method, query, body);
  }

  notFound(store, res);
  return true;
}

function parseCommitText(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const parents: string[] = [];
  let tree = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

// --- contents ---------------------------------------------------------------

function commitFileChange(store: ForgeStore, repo: Repo, branch: string, filePath: string, content: Buffer | null, message: string): { commitSha: string; contentSha: string | null } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip === undefined ? store.emptyTreeSha() : parseCommitText((store.getObject(tip) as { data: Buffer }).data).tree;
  const flat = store.flattenTree(baseTree);
  let contentSha: string | null = null;
  if (content === null) {
    flat.delete(filePath);
  } else {
    contentSha = store.putBlob(content);
    flat.set(filePath, { mode: '100644', sha: contentSha });
  }
  const tree = store.buildTreeFromFlat(flat);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = store.commitObject(tree, parents, message);
  store.setRef(repo, ref, commitSha);
  return { commitSha, contentSha };
}

async function handleContents(ctx: RestContext, req: ForgeReq, res: ForgeRes, repo: Repo, repoPath: string, filePath: string, method: string, query: QueryView, body: unknown): Promise<boolean> {
  const { store } = ctx;
  const branch = isObject(body) && typeof body.branch === 'string'
    ? (body.branch as string)
    : (query.get('ref') ?? repo.defaultBranch);

  if (method === 'PUT') {
    if (!isObject(body) || typeof body.message !== 'string' || typeof body.content !== 'string') {
      sendJson(res, store, 422, { message: 'Validation Failed: message and content are required' });
      return true;
    }
    if (branch !== repo.defaultBranch && !repo.refs.has(`refs/heads/${branch}`)) {
      notFound(store, res);
      return true;
    }
    const content = Buffer.from(body.content as string, 'base64');
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const existing = tip === undefined ? undefined : store.flattenTree(parseCommitText((store.getObject(tip) as { data: Buffer }).data).tree).get(filePath);
    const givenSha = typeof body.sha === 'string' ? (body.sha as string).toLowerCase() : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined || givenSha !== existing.sha.toLowerCase()) {
        sendJson(res, store, 409, { message: 'Conflict: sha does not match the current file' });
        return true;
      }
      const { commitSha, contentSha } = commitFileChange(store, repo, branch, filePath, content, body.message as string);
      sendJson(res, store, 200, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message: body.message as string },
      });
      return true;
    }
    if (givenSha !== undefined) {
      sendJson(res, store, 409, { message: 'Conflict: file does not exist' });
      return true;
    }
    const { commitSha, contentSha } = commitFileChange(store, repo, branch, filePath, content, body.message as string);
    sendJson(res, store, 201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message: body.message as string },
    });
    return true;
  }

  if (method === 'GET') {
    const tip = store.resolveRef(repo, branch);
    if (tip === null) {
      notFound(store, res);
      return true;
    }
    const tree = parseCommitText((store.getObject(tip) as { data: Buffer }).data).tree;
    const flat = store.flattenTree(tree);
    if (filePath === '') {
      // Root directory listing.
      const entries = dirListing(store, tree, '');
      sendJson(res, store, 200, entries);
      return true;
    }
    const file = flat.get(filePath);
    if (file !== undefined) {
      const obj = store.getObject(file.sha);
      const data = obj === undefined ? Buffer.alloc(0) : obj.data;
      sendJson(res, store, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: data.toString('base64'),
        sha: file.sha,
      });
      return true;
    }
    // A directory: immediate children of filePath.
    const prefix = `${filePath}/`;
    const childNames = new Set<string>();
    let isDir = false;
    for (const key of flat.keys()) {
      if (key.startsWith(prefix)) {
        isDir = true;
        childNames.add(key.slice(prefix.length).split('/')[0] as string);
      }
    }
    if (!isDir) {
      notFound(store, res);
      return true;
    }
    const entries: JsonObject[] = [];
    for (const name of [...childNames].sort()) {
      const childPath = `${filePath}/${name}`;
      const childFile = flat.get(childPath);
      if (childFile !== undefined) {
        entries.push({ type: 'file', name, path: childPath, sha: childFile.sha, size: (store.getObject(childFile.sha)?.data.length ?? 0) });
      } else {
        entries.push({ type: 'dir', name, path: childPath, sha: dirSha(store, tree, filePath, name) });
      }
    }
    sendJson(res, store, 200, entries);
    return true;
  }

  if (method === 'DELETE') {
    if (!isObject(body)) {
      sendJson(res, store, 400, { message: 'Body must be a JSON object' });
      return true;
    }
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      notFound(store, res);
      return true;
    }
    const flat = store.flattenTree(parseCommitText((store.getObject(tip) as { data: Buffer }).data).tree);
    const existing = flat.get(filePath);
    if (existing === undefined) {
      notFound(store, res);
      return true;
    }
    const givenSha = typeof body.sha === 'string' ? (body.sha as string).toLowerCase() : undefined;
    if (givenSha !== undefined && givenSha !== existing.sha.toLowerCase()) {
      sendJson(res, store, 409, { message: 'Conflict: sha does not match the current file' });
      return true;
    }
    const { commitSha } = commitFileChange(store, repo, branch, filePath, null, asString(body.message, `Delete ${filePath}`));
    sendJson(res, store, 200, { commit: { sha: commitSha, message: asString(body.message, `Delete ${filePath}`) } });
    return true;
  }

  sendJson(res, store, 405, { message: 'Method Not Allowed' });
  return true;
}

function dirListing(store: ForgeStore, treeSha: string, dirPath: string): JsonObject[] {
  const obj = store.getObject(treeSha);
  if (obj === undefined) return [];
  const entries: JsonObject[] = [];
  // parseTree is in store.ts but not exported; re-derive via flatten for the root only.
  void dirPath;
  const flat = store.flattenTree(treeSha);
  const names = new Set<string>();
  for (const key of flat.keys()) names.add(key.split('/')[0] as string);
  for (const name of [...names].sort()) {
    const file = flat.get(name);
    if (file !== undefined) {
      entries.push({ type: 'file', name, path: name, sha: file.sha, size: store.getObject(file.sha)?.data.length ?? 0 });
    } else {
      entries.push({ type: 'dir', name, path: name, sha: dirSha(store, treeSha, '', name) });
    }
  }
  return entries;
}

function dirSha(store: ForgeStore, treeSha: string, dirPath: string, name: string): string {
  // Walk the tree to the named subdirectory and return its sha.
  const parts = dirPath === '' ? [name] : [...dirPath.split('/'), name];
  let current = treeSha;
  for (const part of parts) {
    const obj = store.getObject(current);
    if (obj === undefined) return store.emptyTreeSha();
    const found = parseTreeData(obj.data).find((entry) => entry.name === part && entry.mode === '40000');
    if (found === undefined) return store.emptyTreeSha();
    current = found.sha;
  }
  return current;
}

function parseTreeData(data: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

// --- issues -----------------------------------------------------------------

async function handleIssues(ctx: RestContext, res: ForgeRes, repo: Repo, repoPath: string, rest: string[], method: string, query: QueryView, body: unknown): Promise<boolean> {
  const { store } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      if (!isObject(body) || typeof body.title !== 'string') {
        sendJson(res, store, 422, { message: 'Validation Failed: title is required' });
        return true;
      }
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendJson(res, store, 422, { message: `Validation Failed: label "${label}" does not exist` });
          return true;
        }
      }
      const issue: Issue = {
        id: repo.id * 100000 + repo.nextIssue,
        number: repo.nextIssue,
        title: body.title as string,
        body: asString(body.body, ''),
        state: 'open',
        labels,
        comments: [],
        seq: repo.nextIssue,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      sendJsonText(res, store, 201, cacheIssueBody(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page } = paginate(list, query);
      sendJson(res, store, 200, page.map((issue) => issueJson(repo, issue)));
      return true;
    }
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const number = Number(rest[0]);
  const issue = repo.issues.find((item) => item.number === number);
  if (issue === undefined || !Number.isInteger(number)) {
    notFound(store, res);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      const cached = issueBodyCache.get(issueCacheKey(repo, issue));
      sendJsonText(res, store, 200, cached ?? cacheIssueBody(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (!isObject(body)) {
        sendJson(res, store, 400, { message: 'Body must be a JSON object' });
        return true;
      }
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      invalidateIssueBody(repo, issue);
      sendJson(res, store, 200, issueJson(repo, issue));
      return true;
    }
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (rest[0] !== undefined && rest[1] === 'comments') {
    if (method === 'POST') {
      if (!isObject(body) || typeof body.body !== 'string') {
        sendJson(res, store, 422, { message: 'Validation Failed: body is required' });
        return true;
      }
      const comment = { id: repo.nextCommentId, body: body.body as string };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      invalidateIssueBody(repo, issue);
      sendJson(res, store, 201, { id: comment.id, node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`), body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, store, 200, issue.comments.map((comment) => ({ id: comment.id, node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`), body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
      return true;
    }
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }

  notFound(store, res);
  return true;
}

/** Squash-merge a pull request. Returns the merge commit sha, or null on conflict. Shared with GraphQL. */
export function mergePullSquash(store: ForgeStore, repo: Repo, pull: PullRequest): string | null {
  if (pull.merged || pull.state === 'closed') return null;
  const baseTip = store.resolveRef(repo, pull.baseRef);
  const headTip = store.resolveRef(repo, pull.headSha);
  if (baseTip === null || headTip === null) return null;
  const mergeBaseSha = store.mergeBase(pull.createdBaseSha, headTip) ?? pull.createdBaseSha;
  const baseObj = store.getObject(mergeBaseSha);
  const headObj = store.getObject(headTip);
  const tipObj = store.getObject(baseTip);
  if (baseObj === undefined || headObj === undefined || tipObj === undefined) return null;
  const baseFlat = store.flattenTree(parseCommitText(baseObj.data).tree);
  const headFlat = store.flattenTree(parseCommitText(headObj.data).tree);
  const tipFlat = store.flattenTree(parseCommitText(tipObj.data).tree);
  // Conflict: a path changed on the head since the merge base AND changed on the
  // base tip since the merge base, to a different value.
  const allPaths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of allPaths) {
    const baseSha = baseFlat.get(path)?.sha ?? null;
    const headSha = headFlat.get(path)?.sha ?? null;
    const tipSha = tipFlat.get(path)?.sha ?? null;
    if (baseSha !== headSha && baseSha !== tipSha && headSha !== tipSha) return null;
  }
  // Squash: the head's tree overlaid on the base tip's tree.
  const merged = new Map(tipFlat);
  for (const [path, entry] of headFlat) merged.set(path, entry);
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path)) merged.delete(path);
  }
  const tree = store.buildTreeFromFlat(merged);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const mergeSha = store.commitObject(tree, [baseTip], message);
  store.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  return mergeSha;
}

// --- pull requests ----------------------------------------------------------

function pullDiff(store: ForgeStore, repo: Repo, pull: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const base = store.mergeBase(pull.createdBaseSha, pull.headSha) ?? pull.createdBaseSha;
  const baseObj = store.getObject(base);
  const headObj = store.getObject(pull.headSha);
  if (baseObj === undefined || headObj === undefined) return [];
  const baseTree = parseCommitText(baseObj.data).tree;
  const headTree = parseCommitText(headObj.data).tree;
  const baseFlat = store.flattenTree(baseTree);
  const headFlat = store.flattenTree(headTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before === undefined && after !== undefined) {
      const text = (store.getObject(after.sha)?.data.toString('utf8') ?? '');
      const counts = lineDiffCounts('', text);
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (before !== undefined && after === undefined) {
      const text = (store.getObject(before.sha)?.data.toString('utf8') ?? '');
      const counts = lineDiffCounts(text, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (before !== undefined && after !== undefined && before.sha !== after.sha) {
      const oldText = (store.getObject(before.sha)?.data.toString('utf8') ?? '');
      const newText = (store.getObject(after.sha)?.data.toString('utf8') ?? '');
      const counts = lineDiffCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return out;
}

async function handlePulls(ctx: RestContext, res: ForgeRes, repo: Repo, repoPath: string, rest: string[], method: string, query: QueryView, body: unknown): Promise<boolean> {
  const { store } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      if (!isObject(body) || typeof body.head !== 'string' || typeof body.base !== 'string') {
        sendJson(res, store, 422, { message: 'Validation Failed: head and base are required' });
        return true;
      }
      const headRef = body.head as string;
      const baseRef = body.base as string;
      const headSha = store.resolveRef(repo, headRef);
      const baseSha = store.resolveRef(repo, baseRef);
      if (headSha === null || baseSha === null) {
        sendJson(res, store, 422, { message: 'Validation Failed: head or base branch does not exist' });
        return true;
      }
      const pull: PullRequest = {
        id: repo.id * 100000 + repo.nextPull,
        number: repo.nextPull,
        title: asString(body.title, ''),
        body: asString(body.body, ''),
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        createdBaseSha: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repo.nextPull,
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      sendJson(res, store, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const { page } = paginate(list, query);
      sendJson(res, store, 200, page.map((pull) => pullJson(repo, pull)));
      return true;
    }
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const number = Number(rest[0]);
  const pull = repo.pulls.find((item) => item.number === number);
  if (pull === undefined || !Number.isInteger(number)) {
    notFound(store, res);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, store, 200, pullJson(repo, pull));
      return true;
    }
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (rest[1] === 'files' && method === 'GET') {
    sendJson(res, store, 200, pullDiff(store, repo, pull));
    return true;
  }

  if (rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged || pull.state === 'closed') {
      sendJson(res, store, 405, { message: 'Validation Failed: pull request is already merged or closed' });
      return true;
    }
    const baseTip = store.resolveRef(repo, pull.baseRef);
    const headTip = store.resolveRef(repo, pull.headSha);
    if (baseTip === null || headTip === null) {
      notFound(store, res);
      return true;
    }
    const mergeSha = mergePullSquash(store, repo, pull);
    if (mergeSha === null) {
      sendJson(res, store, 405, { message: 'Merge conflict: the pull request cannot be merged cleanly' });
      return true;
    }
    sendJson(res, store, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    return true;
  }

  notFound(store, res);
  return true;
}

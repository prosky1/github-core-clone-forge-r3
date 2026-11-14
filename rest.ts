// rest.ts — the GitHub REST v3 surface, served under /api/v3.
//
// Behaviour the kit's checks pin down (checks-rest.ts): every response is
// application/json and carries a non-empty X-GitHub-Request-Id; error bodies
// have the shape {message: string}; a request with no bearer token gets 401;
// a repository owned by anyone but the token's login answers 404, never 403.

import type { ForgeReq, ForgeRes } from './app.ts';
import {
  FIXED_ISO,
  VIEWER,
  globalId,
  lineDiffCounts,
  type ForgeStore,
  type Issue,
  type PullRequest,
  type QueryView,
  type Repo,
} from './store.ts';

export interface RestContext { store: ForgeStore; token: string }

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function requestId(db: ForgeStore): string {
  db.requestSeq += 1;
  return `req-${db.requestSeq}`;
}

export function sendJson(reply: ForgeRes, db: ForgeStore, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(payload)}\n`;
  reply.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(text, 'utf8'),
    'x-github-request-id': requestId(db),
    ...headers,
  });
  reply.end(text);
}

/** Send a body that was already serialized (its bytes and length travel with
 *  it). Bodies are cached as Buffers rather than strings so both transports
 *  skip re-encoding them on every send — re-encoding (writeUtf8String) was
 *  about 13% of busy CPU in the read hammer. */
export function sendJsonText(reply: ForgeRes, db: ForgeStore, status: number, sealed: { buf: Buffer; length: number }): void {
  reply.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': sealed.length,
    'x-github-request-id': requestId(db),
  });
  reply.end(sealed.buf);
}

// --- Serialized issue cache -------------------------------------------------
// The read workload GETs a single issue 2,000 times running; its JSON does
// not change between mutations, so the serialized body is cached per
// (repository, issue number) and dropped whenever that issue mutates
// (PATCH, a new comment) or its repository goes away. The cached bytes are
// byte-identical to what sendJson would emit.

const cachedIssueBodies = new Map<string, { buf: Buffer; length: number }>();

function issueBodyKey(repository: Repo, item: Issue): string {
  return `${repository.id}:${item.number}`;
}

function serializeIssueBody(repository: Repo, item: Issue): { buf: Buffer; length: number } {
  const buf = Buffer.from(`${JSON.stringify(issueJson(repository, item))}\n`);
  const entry = { buf, length: buf.length };
  cachedIssueBodies.set(issueBodyKey(repository, item), entry);
  return entry;
}

/** Drop one issue's cached REST body after any mutation of it, from any
 *  surface (REST, GraphQL, MCP). Exported for graphql.ts and mcp.ts. */
export function invalidateIssueBody(repository: Repo, item: Issue): void {
  cachedIssueBodies.delete(issueBodyKey(repository, item));
}

function dropRepoIssueBodies(repository: Repo): void {
  const prefix = `${repository.id}:`;
  for (const key of cachedIssueBodies.keys()) {
    if (key.startsWith(prefix)) cachedIssueBodies.delete(key);
  }
}

export function sendNoContent(reply: ForgeRes, db: ForgeStore, status: number, headers: Record<string, string> = {}): void {
  reply.writeHead(status, { 'x-github-request-id': requestId(db), ...headers });
  reply.end();
}

export function notFound(db: ForgeStore, reply: ForgeRes): void {
  sendJson(reply, db, 404, { message: 'Not Found' });
}

type JsonMap = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The viewer object every view embeds for the acting user. */
function viewerJson(): JsonMap {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User' };
}

// --- JSON views -------------------------------------------------------------

export function repoJson(repository: Repo): JsonMap {
  const stamp = FIXED_ISO;
  const fullName = `${repository.owner}/${repository.name}`;
  let openCount = 0;
  for (const item of repository.issues) {
    if (item.state === 'open') openCount += 1;
  }
  return {
    id: repository.id,
    node_id: globalId('Repository', fullName),
    name: repository.name,
    full_name: fullName,
    owner: { login: repository.owner, id: VIEWER.id, type: 'User' },
    private: repository.isPrivate,
    description: repository.description,
    default_branch: repository.defaultBranch,
    html_url: `https://example.invalid/${fullName}`,
    url: `/api/v3/repos/${fullName}`,
    clone_url: `https://example.invalid/${fullName}.git`,
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    has_issues: true, has_projects: true, has_wiki: true,
    forks_count: 0, stargazers_count: 0, watchers_count: 0,
    open_issues_count: openCount,
  };
}

function labelView(tag: { name: string; color: string }): JsonMap {
  return { id: 0, node_id: globalId('Label', tag.name), name: tag.name, color: tag.color, description: '' };
}

export function issueJson(repository: Repo, item: Issue): JsonMap {
  const stamp = FIXED_ISO;
  const fullName = `${repository.owner}/${repository.name}`;
  return {
    id: item.id,
    node_id: globalId('Issue', `${fullName}#${item.number}`),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => {
      const found = repository.labels.get(name);
      return found === undefined ? { name, color: 'ededed' } : labelView(found);
    }),
    user: viewerJson(), assignee: null,
    created_at: stamp,
    updated_at: stamp,
    closed_at: item.state === 'closed' ? stamp : null,
    comments: item.comments.length,
    html_url: `https://example.invalid/${fullName}/issues/${item.number}`,
    url: `/api/v3/repos/${fullName}/issues/${item.number}`,
  };
}

function refView(repository: Repo, ref: string, sha: string): JsonMap {
  return {
    label: `${repository.owner}:${ref}`,
    ref: ref,
    sha: sha,
    user: { login: repository.owner, id: VIEWER.id, type: 'User' },
    repo: repoJson(repository),
  };
}

export function pullJson(repository: Repo, pr: PullRequest): JsonMap {
  const stamp = FIXED_ISO;
  const fullName = `${repository.owner}/${repository.name}`;
  const mergeable = true;
  const draft = false;
  return {
    id: pr.id,
    node_id: globalId('PullRequest', `${fullName}#${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: refView(repository, pr.headRef, pr.headSha),
    base: refView(repository, pr.baseRef, pr.baseSha),
    merged: pr.merged,
    mergeable,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    created_at: stamp,
    updated_at: stamp,
    closed_at: pr.state === 'closed' ? stamp : null,
    draft,
    html_url: `https://example.invalid/${fullName}/pull/${pr.number}`,
    url: `/api/v3/repos/${fullName}/pulls/${pr.number}`,
  };
}

// --- routing ----------------------------------------------------------------

interface RepoRoute { owner: string; repoName: string; rest: string[] }

function matchRepoPath(parts: string[]): RepoRoute | null {
  // Path segments: ['api', 'v3', 'repos', owner, name, ...rest]
  if (parts.length < 5 || parts[2] !== 'repos') return null;
  const owner = decodeURIComponent(parts[3] as string);
  const repoName = decodeURIComponent(parts[4] as string);
  return { owner, repoName, rest: parts.slice(5) };
}

function pageSlice<T>(entries: T[], params: QueryView): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const rawPerPage = Number(params.get('per_page') ?? '30');
  const perPage = Math.max(1, Math.min(100, rawPerPage || 30));
  const rawPage = Number(params.get('page') ?? '1');
  const pageNum = Math.max(1, rawPage || 1);
  const start = (pageNum - 1) * perPage;
  const totalPages = Math.max(1, Math.ceil(entries.length / perPage));
  return { page: entries.slice(start, start + perPage), totalPages, pageNum, perPage };
}

function nextLink(request: ForgeReq, basePath: string, params: QueryView, pageNum: number, perPage: number, totalPages: number): string | null {
  if (pageNum >= totalPages) return null;
  const host = request.headers.host ?? 'localhost';
  const next = new URL(`http://${host}${basePath}`);
  for (const [key, value] of params) {
    if (key !== 'page' && key !== 'per_page') {
      next.searchParams.set(key, value);
    }
  }
  next.searchParams.set('per_page', String(perPage));
  next.searchParams.set('page', String(pageNum + 1));
  return `<${next.toString()}>; rel="next"`;
}

function bearerValid(context: RestContext, request: ForgeReq): boolean {
  const header = request.headers.authorization ?? '';
  if (header.startsWith('Bearer ') === false) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented.length === 0) return false;
  // A trial always sets the token; with none set, any non-empty bearer passes.
  if (context.token === '') return true;
  return presented === context.token;
}

/** Handle one /api/v3 request. Returns true when handled (including 404s under /api/v3). */
export async function handleRest(context: RestContext, request: ForgeReq, reply: ForgeRes, urlPath: string, verb: string, params: QueryView, payload: unknown): Promise<boolean> {
  const db = context.store;
  if (urlPath.startsWith('/api/v3') === false) return false;

  if (bearerValid(context, request) === false) {
    sendJson(reply, db, 401, { message: 'Requires authentication' });
    return true;
  }

  const segments = urlPath.split('/').filter((part) => part.length > 0);

  // GET /api/v3/ — the API root.
  if ((urlPath === '/api/v3' || urlPath === '/api/v3/') && verb === 'GET') {
    sendJson(reply, db, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (urlPath === '/api/v3/meta' && verb === 'GET') {
    sendJson(reply, db, 200, { installed_version: 'github-core-clone-01/1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (urlPath === '/api/v3/user' && verb === 'GET') {
    sendJson(reply, db, 200, { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (urlPath === '/api/v3/user/repos') {
    if (verb === 'GET') {
      const repos = db.listViewerRepos();
      const { page, totalPages, pageNum, perPage } = pageSlice(repos, params);
      const headers: Record<string, string> = {};
      const link = nextLink(request, urlPath, params, pageNum, perPage, totalPages);
      if (link !== null) headers.link = link;
      sendJson(reply, db, 200, page.map(repoJson), headers);
      return true;
    }
    if (verb === 'POST') {
      if (isJsonObject(payload) === false) {
        sendJson(reply, db, 400, { message: 'Body must be a JSON object' });
        return true;
      }
      const name = stringOr(payload.name);
      if (name === '') {
        sendJson(reply, db, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      if (db.getRepo(VIEWER.login, name) !== undefined) {
        sendJson(reply, db, 422, { message: 'Validation Failed: repository already exists' });
        return true;
      }
      const repository = db.createRepo(VIEWER.login, name, booleanOr(payload.private, false), stringOr(payload.description, ''));
      sendJson(reply, db, 201, repoJson(repository));
      return true;
    }
    sendJson(reply, db, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const route = matchRepoPath(segments);
  if (route === null) {
    notFound(db, reply);
    return true;
  }
  const { owner, repoName, rest: tail } = route;
  // Only the token owner's repositories exist here; any other owner is 404, never 403.
  if (owner !== VIEWER.login) {
    notFound(db, reply);
    return true;
  }
  const repository = db.getRepo(owner, repoName);
  const repoUrl = `/api/v3/repos/${owner}/${repoName}`;

  // The repository itself.
  if (tail.length === 0) {
    if (verb === 'GET') {
      if (repository === undefined) notFound(db, reply);
      else sendJson(reply, db, 200, repoJson(repository));
      return true;
    }
    if (verb === 'PATCH') {
      if (repository === undefined) {
        notFound(db, reply);
        return true;
      }
      if (isJsonObject(payload) === false) {
        sendJson(reply, db, 400, { message: 'Body must be a JSON object' });
        return true;
      }
      if (typeof payload.description === 'string') repository.description = payload.description;
      if (typeof payload.private === 'boolean') repository.isPrivate = payload.private;
      sendJson(reply, db, 200, repoJson(repository));
      return true;
    }
    if (verb === 'DELETE') {
      if (repository === undefined) {
        notFound(db, reply);
        return true;
      }
      db.deleteRepo(owner, repoName);
      dropRepoIssueBodies(repository);
      sendNoContent(reply, db, 204);
      return true;
    }
    sendJson(reply, db, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (repository === undefined) {
    notFound(db, reply);
    return true;
  }

  const segment = tail[0] as string;

  // POST /git/refs — create a branch. GET /git/refs/heads/{branch}.
  if (segment === 'git' && tail[1] === 'refs') {
    if (verb === 'POST' && tail.length === 2) {
      if (isJsonObject(payload) === false || typeof payload.ref !== 'string' || typeof payload.sha !== 'string') {
        sendJson(reply, db, 422, { message: 'Validation Failed: ref and sha are required' });
        return true;
      }
      const ref = payload.ref as string;
      const sha = (payload.sha as string).toLowerCase();
      const obj = db.getObject(sha);
      if (obj === undefined || obj.type !== 'commit') {
        sendJson(reply, db, 422, { message: 'Validation Failed: sha is not a commit' });
        return true;
      }
      if (repository.refs.has(ref)) {
        sendJson(reply, db, 422, { message: 'Validation Failed: ref already exists' });
        return true;
      }
      db.setRef(repository, ref, sha);
      sendJson(reply, db, 201, { ref, object: { sha, type: 'commit', url: `${repoUrl}/git/commits/${sha}` } });
      return true;
    }
    if (verb === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
      const branch = tail.slice(3).map(decodeURIComponent).join('/');
      const sha = repository.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        notFound(db, reply);
        return true;
      }
      sendJson(reply, db, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: `${repoUrl}/git/commits/${sha}` } });
      return true;
    }
    notFound(db, reply);
    return true;
  }

  // GET /branches and /branches/{branch}
  if (segment === 'branches') {
    if (verb === 'GET' && tail.length === 1) {
      const out: JsonMap[] = [];
      for (const [ref, sha] of repository.refs) {
        if (ref.startsWith('refs/heads/')) {
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${repoUrl}/commits/${sha}` }, protected: false });
        }
      }
      out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(reply, db, 200, out);
      return true;
    }
    if (verb === 'GET' && tail.length >= 2) {
      const branch = tail.slice(1).map(decodeURIComponent).join('/');
      const sha = repository.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        notFound(db, reply);
        return true;
      }
      sendJson(reply, db, 200, { name: branch, commit: { sha, url: `${repoUrl}/commits/${sha}` }, protected: false });
      return true;
    }
    notFound(db, reply);
    return true;
  }

  // GET /commits[?sha=<ref>]
  if (segment === 'commits' && verb === 'GET' && tail.length === 1) {
    const ref = params.get('sha') ?? repository.defaultBranch;
    const tip = db.resolveRef(repository, ref);
    if (tip === null) {
      notFound(db, reply);
      return true;
    }
    const out: JsonMap[] = [];
    for (const sha of db.commitHistory(tip)) {
      const obj = db.getObject(sha);
      if (obj === undefined) continue;
      const meta = readCommitText(obj.data);
      out.push({
        sha: sha,
        commit: { message: meta.message, author: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_ISO }, committer: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_ISO }, tree: { sha: meta.tree } },
        parents: meta.parents.map((parent) => ({ sha: parent })),
      });
    }
    sendJson(reply, db, 200, out);
    return true;
  }

  // Contents: PUT/GET/DELETE /contents/{path...}
  if (segment === 'contents') {
    const filePath = tail.slice(1).map(decodeURIComponent).join('/');
    return serveContents(context, request, reply, repository, repoUrl, filePath, verb, params, payload);
  }

  // Labels
  if (segment === 'labels') {
    if (verb === 'POST' && tail.length === 1) {
      if (isJsonObject(payload) === false || typeof payload.name !== 'string' || payload.name === '') {
        sendJson(reply, db, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      const name = payload.name as string;
      const color = stringOr(payload.color, 'ededed');
      const existing = repository.labels.get(name);
      if (existing !== undefined) {
        sendJson(reply, db, 201, labelView(existing));
        return true;
      }
      const label = { name, color };
      repository.labels.set(name, label);
      sendJson(reply, db, 201, labelView(label));
      return true;
    }
    if (verb === 'GET' && tail.length === 1) {
      sendJson(reply, db, 200, [...repository.labels.values()].map(labelView));
      return true;
    }
    notFound(db, reply);
    return true;
  }

  // Issues
  if (segment === 'issues') {
    return serveIssues(context, reply, repository, repoUrl, tail.slice(1), verb, params, payload);
  }

  // Pull requests
  if (segment === 'pulls') {
    return servePulls(context, reply, repository, repoUrl, tail.slice(1), verb, params, payload);
  }

  notFound(db, reply);
  return true;
}

function readCommitText(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const blankAt = text.indexOf('\n\n');
  const header = blankAt === -1 ? text : text.slice(0, blankAt);
  const message = blankAt === -1 ? '' : text.slice(blankAt + 2).replace(/\n$/, '');
  const parents: string[] = [];
  let tree: string = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree: tree, parents: parents, message: message };
}

// --- contents ---------------------------------------------------------------

function commitFileEdit(db: ForgeStore, repository: Repo, branchName: string, path: string, bytes: Buffer | null, note: string): { commitSha: string; contentSha: string | null } {
  const ref = `refs/heads/${branchName}`;
  const tip = repository.refs.get(ref);
  const baseTree = tip === undefined ? db.emptyTreeSha() : readCommitText((db.getObject(tip) as { data: Buffer }).data).tree;
  const flat = db.flattenTree(baseTree);
  let contentSha: string | null = null;
  if (bytes === null) {
    flat.delete(path);
  } else {
    contentSha = db.putBlob(bytes);
    flat.set(path, { mode: '100644', sha: contentSha });
  }
  const tree = db.buildTreeFromFlat(flat);
  const parents: string[] = tip === undefined ? [] : [tip];
  const commitSha = db.commitObject(tree, parents, note);
  db.setRef(repository, ref, commitSha);
  return { commitSha: commitSha, contentSha: contentSha };
}

async function serveContents(context: RestContext, request: ForgeReq, reply: ForgeRes, repository: Repo, repoUrl: string, path: string, verb: string, params: QueryView, payload: unknown): Promise<boolean> {
  const db = context.store;
  void request;
  const branchName = isJsonObject(payload) && typeof payload.branch === 'string'
    ? (payload.branch as string)
    : (params.get('ref') ?? repository.defaultBranch);

  if (verb === 'PUT') {
    if (isJsonObject(payload) === false || typeof payload.message !== 'string' || typeof payload.content !== 'string') {
      sendJson(reply, db, 422, { message: 'Validation Failed: message and content are required' });
      return true;
    }
    if (branchName !== repository.defaultBranch && repository.refs.has(`refs/heads/${branchName}`) === false) {
      notFound(db, reply);
      return true;
    }
    const bytes = Buffer.from(payload.content as string, 'base64');
    const tip = repository.refs.get(`refs/heads/${branchName}`);
    const existing = tip === undefined ? undefined : db.flattenTree(readCommitText((db.getObject(tip) as { data: Buffer }).data).tree).get(path);
    const givenSha = typeof payload.sha === 'string' ? (payload.sha as string).toLowerCase() : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined || givenSha !== existing.sha.toLowerCase()) {
        sendJson(reply, db, 409, { message: 'Conflict: sha does not match the current file' });
        return true;
      }
      const { commitSha, contentSha } = commitFileEdit(db, repository, branchName, path, bytes, payload.message as string);
      sendJson(reply, db, 200, {
        content: { name: path.split('/').pop(), path: path, sha: contentSha, size: bytes.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message: payload.message as string },
      });
      return true;
    }
    if (givenSha !== undefined) {
      sendJson(reply, db, 409, { message: 'Conflict: file does not exist' });
      return true;
    }
    const { commitSha, contentSha } = commitFileEdit(db, repository, branchName, path, bytes, payload.message as string);
    sendJson(reply, db, 201, {
      content: { name: path.split('/').pop(), path: path, sha: contentSha, size: bytes.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message: payload.message as string },
    });
    return true;
  }

  if (verb === 'GET') {
    const tip = db.resolveRef(repository, branchName);
    if (tip === null) {
      notFound(db, reply);
      return true;
    }
    const tree = readCommitText((db.getObject(tip) as { data: Buffer }).data).tree;
    const flat = db.flattenTree(tree);
    if (path === '') {
      // Root directory listing.
      const entries = listDirectory(db, tree, '');
      sendJson(reply, db, 200, entries);
      return true;
    }
    const file = flat.get(path);
    if (file !== undefined) {
      const obj = db.getObject(file.sha);
      const data = obj === undefined ? Buffer.alloc(0) : obj.data;
      sendJson(reply, db, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path: path,
        content: data.toString('base64'),
        sha: file.sha,
      });
      return true;
    }
    // A directory: immediate children of path.
    const prefix = `${path}/`;
    const childNames = new Set<string>();
    let isDir = false;
    for (const key of flat.keys()) {
      if (key.startsWith(prefix)) {
        isDir = true;
        childNames.add(key.slice(prefix.length).split('/')[0] as string);
      }
    }
    if (isDir === false) {
      notFound(db, reply);
      return true;
    }
    const entries: JsonMap[] = [];
    for (const name of [...childNames].sort()) {
      const childPath = `${path}/${name}`;
      const childFile = flat.get(childPath);
      if (childFile !== undefined) {
        entries.push({ type: 'file', name, path: childPath, sha: childFile.sha, size: (db.getObject(childFile.sha)?.data.length ?? 0) });
      } else {
        entries.push({ type: 'dir', name, path: childPath, sha: directorySha(db, tree, path, name) });
      }
    }
    sendJson(reply, db, 200, entries);
    return true;
  }

  if (verb === 'DELETE') {
    if (isJsonObject(payload) === false) {
      sendJson(reply, db, 400, { message: 'Body must be a JSON object' });
      return true;
    }
    const tip = repository.refs.get(`refs/heads/${branchName}`);
    if (tip === undefined) {
      notFound(db, reply);
      return true;
    }
    const flat = db.flattenTree(readCommitText((db.getObject(tip) as { data: Buffer }).data).tree);
    const existing = flat.get(path);
    if (existing === undefined) {
      notFound(db, reply);
      return true;
    }
    const givenSha = typeof payload.sha === 'string' ? (payload.sha as string).toLowerCase() : undefined;
    if (givenSha !== undefined && givenSha !== existing.sha.toLowerCase()) {
      sendJson(reply, db, 409, { message: 'Conflict: sha does not match the current file' });
      return true;
    }
    const { commitSha } = commitFileEdit(db, repository, branchName, path, null, stringOr(payload.message, `Delete ${path}`));
    sendJson(reply, db, 200, { commit: { sha: commitSha, message: stringOr(payload.message, `Delete ${path}`) } });
    return true;
  }

  sendJson(reply, db, 405, { message: 'Method Not Allowed' });
  return true;
}

function listDirectory(db: ForgeStore, treeSha: string, dirPath: string): JsonMap[] {
  const obj = db.getObject(treeSha);
  if (obj === undefined) {
    return [];
  }
  const entries: JsonMap[] = [];
  // parseTree lives in store.ts but is not exported; re-derive via flatten for the root only.
  void (dirPath);
  const flat = db.flattenTree(treeSha);
  const names = new Set<string>();
  for (const key of flat.keys()) names.add(key.split('/')[0] as string);
  for (const name of [...names].sort()) {
    const file = flat.get(name);
    if (file !== undefined) {
      entries.push({ type: 'file', name, path: name, sha: file.sha, size: db.getObject(file.sha)?.data.length ?? 0 });
    } else {
      entries.push({ type: 'dir', name, path: name, sha: directorySha(db, treeSha, '', name) });
    }
  }
  return entries;
}

function directorySha(db: ForgeStore, tree: string, dir: string, child: string): string {
  // Walk the tree down to the named subdirectory and return its sha.
  const parts = dir === '' ? [child] : [...dir.split('/'), child];
  let cursor = tree;
  for (const part of parts) {
    const obj = db.getObject(cursor);
    if (obj === undefined) return db.emptyTreeSha();
    const found = readTreeEntries(obj.data).find((entry) => entry.name === part && entry.mode === '40000');
    if (found === undefined) return db.emptyTreeSha();
    cursor = found.sha;
  }
  return cursor;
}

function readTreeEntries(data: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let offset: number = 0;
  while (data.length > offset) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 0x15;
  }
  return entries;
}

// --- issues -----------------------------------------------------------------

async function serveIssues(context: RestContext, reply: ForgeRes, repository: Repo, repoUrl: string, tail: string[], verb: string, params: QueryView, payload: unknown): Promise<boolean> {
  const db = context.store;
  void repoUrl;
  if (tail.length === 0) {
    if (verb === 'POST') {
      if (isJsonObject(payload) === false || typeof payload.title !== 'string') {
        sendJson(reply, db, 422, { message: 'Validation Failed: title is required' });
        return true;
      }
      const labels = Array.isArray(payload.labels) ? (payload.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
      for (const entry of labels) {
        if (repository.labels.has(entry) === false) {
          sendJson(reply, db, 422, { message: `Validation Failed: label "${entry}" does not exist` });
          return true;
        }
      }
      const item: Issue = {
        id: repository.id * 100000 + repository.nextIssue,
        number: repository.nextIssue,
        title: payload.title as string,
        body: stringOr(payload.body, ''),
        state: 'open',
        labels,
        comments: [],
        seq: repository.nextIssue,
      };
      repository.nextIssue += 1;
      repository.issues.push(item);
      sendJsonText(reply, db, 201, serializeIssueBody(repository, item));
      return true;
    }
    if (verb === 'GET') {
      const wanted = params.get('state') ?? 'open';
      const sortKey = params.get('sort') ?? 'created';
      const dir = params.get('direction') ?? 'desc';
      let items = repository.issues.filter((item) => wanted === 'all' || item.state === wanted);
      if (sortKey === 'created') {
        items = [...items].sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page } = pageSlice(items, params);
      sendJson(reply, db, 200, page.map((item) => issueJson(repository, item)));
      return true;
    }
    sendJson(reply, db, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const issueNumber = Number(tail[0]);
  const item = repository.issues.find((entry) => entry.number === issueNumber);
  if (item === undefined || Number.isInteger(issueNumber) === false) {
    notFound(db, reply);
    return true;
  }

  if (tail.length === 1) {
    if (verb === 'GET') {
      const sealed = cachedIssueBodies.get(issueBodyKey(repository, item));
      sendJsonText(reply, db, 200, sealed ?? serializeIssueBody(repository, item));
      return true;
    }
    if (verb === 'PATCH') {
      if (isJsonObject(payload) === false) {
        sendJson(reply, db, 400, { message: 'Body must be a JSON object' });
        return true;
      }
      if (payload.state === 'open' || payload.state === 'closed') item.state = payload.state;
      if (typeof payload.title === 'string') item.title = payload.title;
      if (typeof payload.body === 'string') item.body = payload.body;
      invalidateIssueBody(repository, item);
      sendJson(reply, db, 200, issueJson(repository, item));
      return true;
    }
    sendJson(reply, db, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (tail[0] !== undefined && tail[1] === 'comments') {
    if (verb === 'POST') {
      if (isJsonObject(payload) === false || typeof payload.body !== 'string') {
        sendJson(reply, db, 422, { message: 'Validation Failed: body is required' });
        return true;
      }
      const note = { id: repository.nextCommentId, body: payload.body as string };
      repository.nextCommentId += 1;
      item.comments.push(note);
      invalidateIssueBody(repository, item);
      sendJson(reply, db, 201, {
        id: note.id,
        node_id: globalId('IssueComment', `${repository.owner}/${repository.name}#${item.number}:${note.id}`),
        body: note.body,
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: FIXED_ISO,
        updated_at: FIXED_ISO,
      });
      return true;
    }
    if (verb === 'GET') {
      sendJson(reply, db, 200, item.comments.map((note) => ({
        id: note.id,
        node_id: globalId('IssueComment', `${repository.owner}/${repository.name}#${item.number}:${note.id}`),
        body: note.body,
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: FIXED_ISO,
        updated_at: FIXED_ISO,
      })));
      return true;
    }
    sendJson(reply, db, 405, { message: 'Method Not Allowed' });
    return true;
  }

  notFound(db, reply);
  return true;
}

/** Squash-merge a pull request. Returns the merge commit sha, or null on conflict. Shared with GraphQL. */
export function mergePullSquash(db: ForgeStore, repository: Repo, pr: PullRequest): string | null {
  if (pr.merged || pr.state === 'closed') return null;
  const base = db.resolveRef(repository, pr.baseRef);
  const head = db.resolveRef(repository, pr.headSha);
  if (base === null || head === null) return null;
  const ancestor = db.mergeBase(pr.createdBaseSha, head) ?? pr.createdBaseSha;
  const ancestorObj = db.getObject(ancestor);
  const headObj = db.getObject(head);
  const tipObj = db.getObject(base);
  if (ancestorObj === undefined || headObj === undefined || tipObj === undefined) return null;
  const ancestorFiles = db.flattenTree(readCommitText(ancestorObj.data).tree);
  const headFiles = db.flattenTree(readCommitText(headObj.data).tree);
  const tipFiles = db.flattenTree(readCommitText(tipObj.data).tree);
  // Conflict: a path changed on the head since the merge base AND changed on the
  // base tip since the merge base, to a different value.
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const fromAncestor = ancestorFiles.get(path)?.sha ?? null;
    const fromHead = headFiles.get(path)?.sha ?? null;
    const fromTip = tipFiles.get(path)?.sha ?? null;
    if (fromAncestor !== fromHead && fromAncestor !== fromTip && fromHead !== fromTip) return null;
  }
  // Squash: lay the head's tree over the base tip's tree.
  const result = new Map(tipFiles);
  for (const [path, entry] of headFiles) result.set(path, entry);
  for (const path of ancestorFiles.keys()) {
    if (headFiles.has(path) === false) result.delete(path);
  }
  const treeSha = db.buildTreeFromFlat(result);
  const note = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`;
  const sha = db.commitObject(treeSha, [base], note);
  db.setRef(repository, `refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = FIXED_ISO;
  pr.mergeCommitSha = sha;
  pr.baseSha = sha;
  return sha;
}

// --- pull requests ----------------------------------------------------------

function pullFileDiff(db: ForgeStore, repository: Repo, pr: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const ancestor = db.mergeBase(pr.createdBaseSha, pr.headSha) ?? pr.createdBaseSha;
  const ancestorObj = db.getObject(ancestor);
  const headObj = db.getObject(pr.headSha);
  if (ancestorObj === undefined || headObj === undefined) return [];
  const ancestorTree = readCommitText(ancestorObj.data).tree;
  const headTree = readCommitText(headObj.data).tree;
  const ancestorFiles = db.flattenTree(ancestorTree);
  const headFiles = db.flattenTree(headTree);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = ancestorFiles.get(path);
    const newEntry = headFiles.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const content = (db.getObject(newEntry.sha)?.data.toString('utf8') ?? '');
      const delta = lineDiffCounts('', content);
      out.push({ filename: path, status: 'added', additions: delta.additions, deletions: 0, changes: delta.additions });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const content = (db.getObject(oldEntry.sha)?.data.toString('utf8') ?? '');
      const delta = lineDiffCounts(content, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: delta.deletions, changes: delta.deletions });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha !== newEntry.sha) {
      const beforeText = (db.getObject(oldEntry.sha)?.data.toString('utf8') ?? '');
      const afterText = (db.getObject(newEntry.sha)?.data.toString('utf8') ?? '');
      const delta = lineDiffCounts(beforeText, afterText);
      out.push({ filename: path, status: 'modified', additions: delta.additions, deletions: delta.deletions, changes: delta.additions + delta.deletions });
    }
  }
  return out;
}

async function servePulls(context: RestContext, reply: ForgeRes, repository: Repo, repoUrl: string, tail: string[], verb: string, params: QueryView, payload: unknown): Promise<boolean> {
  const db = context.store;
  void repoUrl;
  if (tail.length === 0) {
    if (verb === 'POST') {
      if (isJsonObject(payload) === false || typeof payload.head !== 'string' || typeof payload.base !== 'string') {
        sendJson(reply, db, 422, { message: 'Validation Failed: head and base are required' });
        return true;
      }
      const head = payload.head as string;
      const base = payload.base as string;
      const headSha = db.resolveRef(repository, head);
      const baseSha = db.resolveRef(repository, base);
      if (headSha === null || baseSha === null) {
        sendJson(reply, db, 422, { message: 'Validation Failed: head or base branch does not exist' });
        return true;
      }
      const pr: PullRequest = {
        id: repository.id * 100000 + repository.nextPull,
        number: repository.nextPull,
        title: stringOr(payload.title, ''),
        body: stringOr(payload.body, ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        createdBaseSha: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repository.nextPull,
      };
      repository.nextPull += 1;
      repository.pulls.push(pr);
      sendJson(reply, db, 201, pullJson(repository, pr));
      return true;
    }
    if (verb === 'GET') {
      const wanted = params.get('state') ?? 'open';
      const list = repository.pulls.filter((pr) => wanted === 'all' || pr.state === wanted);
      const { page } = pageSlice(list, params);
      sendJson(reply, db, 200, page.map((pr) => pullJson(repository, pr)));
      return true;
    }
    sendJson(reply, db, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const pullNumber = Number(tail[0]);
  const pr = repository.pulls.find((entry) => entry.number === pullNumber);
  if (pr === undefined || Number.isInteger(pullNumber) === false) {
    notFound(db, reply);
    return true;
  }

  if (tail.length === 1) {
    if (verb === 'GET') {
      sendJson(reply, db, 200, pullJson(repository, pr));
      return true;
    }
    sendJson(reply, db, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (tail[1] === 'files' && verb === 'GET') {
    sendJson(reply, db, 200, pullFileDiff(db, repository, pr));
    return true;
  }

  if (tail[1] === 'merge' && verb === 'PUT') {
    if (pr.merged || pr.state === 'closed') {
      sendJson(reply, db, 405, { message: 'Validation Failed: pull request is already merged or closed' });
      return true;
    }
    const baseTip = db.resolveRef(repository, pr.baseRef);
    const headTip = db.resolveRef(repository, pr.headSha);
    if (baseTip === null || headTip === null) {
      notFound(db, reply);
      return true;
    }
    const mergeSha = mergePullSquash(db, repository, pr);
    if (mergeSha === null) {
      sendJson(reply, db, 405, { message: 'Merge conflict: the pull request cannot be merged cleanly' });
      return true;
    }
    sendJson(reply, db, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    return true;
  }

  notFound(db, reply);
  return true;
}

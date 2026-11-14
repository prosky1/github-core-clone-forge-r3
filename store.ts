// store.ts — the forge's whole state: a deterministic scenario derivation, a real git
// object store (sha1 blobs/trees/commits), and the REST/GraphQL/MCP resource store.
//
// Everything lives in memory: a trial is one process and the suite is its only client.
// No wall clock and no Math.random anywhere in here, so two runs on the same instance
// build byte-identical state.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Query strings: the hot paths read at most one parameter, and most requests
// carry no query string at all, so parsing is lazy — a QueryView parses the raw
// string only on first use, and never when it is empty.
// ---------------------------------------------------------------------------

/** The slice of URLSearchParams the handlers actually use. */
export interface QueryView {
  get(name: string): string | null;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

/** Lazy URLSearchParams: parses the raw query string only on first access. */
export class LazyQuery implements QueryView {
  #raw: string;
  #parsed: URLSearchParams | null = null;

  constructor(raw: string) {
    this.#raw = raw;
  }

  #ensure(): URLSearchParams {
    if (this.#parsed === null) this.#parsed = new URLSearchParams(this.#raw);
    return this.#parsed;
  }

  get(name: string): string | null {
    if (this.#raw === '') return null;
    return this.#ensure().get(name);
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.#ensure()[Symbol.iterator]();
  }
}

// ---------------------------------------------------------------------------
// The scenario: the suite derives every name it sends from one constant seed
// (SCENARIO_SEED, published in the kit's wire contract). The viewer login the
// bearer token names is users[0] of that derivation, so the forge re-derives it
// the same way instead of guessing: the same label, the same numbers.
// ---------------------------------------------------------------------------

const U64_MASK = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
class SeededRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function deriveUsers(count: number): ScenarioUser[] {
  const seed = mix64(SCENARIO_SEED ^ fnv1a64('users'));
  const rng = new SeededRng(seed);
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = deriveUsers(12);
/** The login the trial's bearer token names. */
export const VIEWER: ScenarioUser = SCENARIO_USERS[0] as ScenarioUser;
/** Another user's login, with no rights on the viewer's repositories. */
export const STRANGER: ScenarioUser = SCENARIO_USERS[2] as ScenarioUser;

/** A fixed timestamp, so every SHA the forge mints is identical across runs. */
export const FIXED_EPOCH = 0;
export const FIXED_ISO = '1970-01-01T00:00:00Z';
const COMMIT_IDENT = 'Forge <forge@example.invalid> 0 +0000';

// ---------------------------------------------------------------------------
// Git objects: sha1 over "<type> <len>\0<content>", stored raw in memory.
// ---------------------------------------------------------------------------

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function sha1Of(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '40000'
  name: string;
  sha: string;
  type: 'blob' | 'tree';
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha, type: mode === '40000' ? 'tree' : 'blob' });
    offset = nul + 21;
  }
  return entries;
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.type === 'tree' ? `${a.name}/` : a.name;
    const kb = b.type === 'tree' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Parse a commit's tree + parents without the message (hot path: graph walks). */
export function parseCommitHeaders(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const parents: string[] = [];
  let tree = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

export function encodeCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${COMMIT_IDENT}`, `committer ${COMMIT_IDENT}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The base tip at creation, for conflict detection. */
  createdBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  /** Bumped on every refs mutation; caches keyed on ref state validate against it. */
  refsVersion: number;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  nextResourceId: number;
  seq: number;
}

export class ForgeStore {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextRepoSeq = 0;
  requestSeq = 0;
  /** Commit sha -> {tree, parents, message}, parsed once at store time. */
  commitInfo = new Map<string, CommitInfo>();
  /** Bumped whenever a NEW object is stored (not on duplicate stores).
   *  Fetch responses depend only on the object set + the request, so this
   *  versions the whole-fetch-response cache in git.ts. */
  objectsVersion = 0;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Cached commit info, or null when the sha is not a stored commit. */
  commitInfoOf(sha: string): CommitInfo | null {
    const info = this.commitInfo.get(sha.toLowerCase());
    return info === undefined ? null : info;
  }

  /** Set a ref and bump the repo's refs version (invalidates advert caches). */
  setRef(repo: Repo, ref: string, sha: string): void {
    repo.refs.set(ref, sha);
    repo.refsVersion += 1;
  }

  /** Delete a ref and bump the repo's refs version (invalidates advert caches). */
  deleteRef(repo: Repo, ref: string): boolean {
    const deleted = repo.refs.delete(ref);
    if (deleted) repo.refsVersion += 1;
    return deleted;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      refsVersion: 0,
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      nextResourceId: 1,
      seq: this.nextRepoSeq,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER.login) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // --- git objects ---------------------------------------------------------

  putObject(type: GitObjectType, data: Buffer): string {
    const sha = sha1Of(type, data);
    if (!this.objects.has(sha)) {
      this.objects.set(sha, { type, data });
      this.objectsVersion += 1;
      if (type === 'commit') this.commitInfo.set(sha, parseCommit(data));
    }
    return sha;
  }

  /** Store an object whose sha is already known (e.g. computed while parsing a pack):
   *  skips the second SHA-1. The sha must be the object's true sha1. */
  putObjectKnown(sha: string, type: GitObjectType, data: Buffer): void {
    const key = sha.toLowerCase();
    if (!this.objects.has(key)) {
      this.objects.set(key, { type, data });
      this.objectsVersion += 1;
      if (type === 'commit') this.commitInfo.set(key, parseCommit(data));
    }
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha.toLowerCase());
  }

  hasObject(sha: string): boolean {
    return this.objects.has(sha.toLowerCase());
  }

  putBlob(content: Buffer): string {
    return this.putObject('blob', content);
  }

  commitObject(tree: string, parents: readonly string[], message: string): string {
    return this.putObject('commit', encodeCommit(tree, parents, message));
  }

  /** The empty tree's sha, computed once. */
  emptyTreeSha(): string {
    return this.putObject('tree', Buffer.alloc(0));
  }

  /** Flat path -> {mode, sha} for the tree at `treeSha` (recursive). */
  flattenTree(treeSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const walk = (sha: string, prefix: string): void => {
      const obj = this.getObject(sha);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.type === 'tree') walk(entry.sha, path);
        else out.set(path, { mode: entry.mode, sha: entry.sha });
      }
    };
    walk(treeSha, '');
    return out;
  }

  /** Build a tree object from a flat path map; returns the tree sha. */
  buildTreeFromFlat(flat: Map<string, { mode: string; sha: string }>): string {
    type Node = Map<string, { mode: string; sha: string } | Node>;
    const root: Node = new Map();
    for (const [path, value] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.get(part);
        if (child === undefined || !('get' in (child as object))) {
          child = new Map();
          node.set(part, child);
        }
        node = child as Node;
      }
      node.set(parts[parts.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node) {
        if (value instanceof Map) {
          entries.push({ mode: '40000', name, sha: build(value as Node), type: 'tree' });
        } else {
          const leaf = value as { mode: string; sha: string };
          entries.push({ mode: leaf.mode, name, sha: leaf.sha, type: 'blob' });
        }
      }
      return this.putObject('tree', encodeTree(entries));
    };
    return build(root);
  }

  /** All commits reachable from `tip`, tip first (parents after their child). */
  commitHistory(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip.toLowerCase()];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = this.commitInfoOf(sha);
      if (info === null) continue;
      out.push(sha);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
    }
    return out;
  }

  isAncestor(ancestor: string, tip: string): boolean {
    const target = ancestor.toLowerCase();
    const seen = new Set<string>();
    const stack = [tip.toLowerCase()];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === target) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = this.commitInfoOf(sha);
      if (info === null) continue;
      for (const parent of info.parents) stack.push(parent.toLowerCase());
    }
    return false;
  }

  /** The first common ancestor of a and b (best-effort BFS from b over a's ancestors). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set(this.commitHistory(a));
    const queue = [b.toLowerCase()];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (ancestorsA.has(sha)) return sha;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = this.commitInfoOf(sha);
      if (info === null) continue;
      for (const parent of info.parents) queue.push(parent.toLowerCase());
    }
    return null;
  }

  /** Resolve a ref name or a raw sha to a commit sha, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const obj = this.getObject(ref);
      return obj !== undefined && obj.type === 'commit' ? ref.toLowerCase() : null;
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const sha = repo.refs.get(full);
    return sha === undefined ? null : sha;
  }
}

/** Opaque GraphQL global ids: base64url of a typed key, never the bare numeric id. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** A tiny line diff (LCS) for pull-request file change counts. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS lengths, two rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

// graphql.ts — a small GraphQL v4 engine for exactly the documents gh and
// github-mcp-server send. No schema library: a hand-written parser for the fixed
// document shapes plus resolvers over the same store REST uses.
//
// Rules the suite enforces (checks-graphql.ts):
// - unauthenticated POST is exactly 401; unknown field is HTTP 200 with an errors
//   array naming it; an unknown repository is data.repository = null with no errors.
// - global ids are opaque (never the bare numeric id) and stable across reads.
// - issues orderBy CREATED_AT DESC, ties by number DESC; states: [OPEN] omits closed.
// - batched operations (a JSON array body) answer a JSON array, in order.

import type { ForgeRes } from './app.ts';
import { FIXED_ISO, VIEWER, globalId, parseGlobalId, type ForgeStore, type Issue, type PullRequest, type Repo } from './store.ts';
import { issueJson, invalidateIssueBody, mergePullSquash, pullJson, repoJson, sendJson } from './rest.ts';

// --- tokenizer ---------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// --- AST ---------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeName: string; selection: SelectionNode[] };

export interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: ValueNode | null }[];
  selection: SelectionNode[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }
  peek(): Token | undefined {
    return this.#tokens[this.#pos];
  }
  next(): Token {
    const token = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }
  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }
  atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek() !== undefined) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    const variables: OperationNode['variables'] = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.atPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      this.expectName('on');
      const typeName = this.expectName();
      return { kind: 'inline', typeName, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (none are sent, but skip them if present).
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const selection = this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{'
      ? this.parseSelectionSet()
      : [];
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// --- execution ---------------------------------------------------------------

interface ExecContext {
  store: ForgeStore;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function evalValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = ctx.variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => evalValue(child, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  return arg === undefined ? undefined : evalValue(arg.value, ctx);
}

type Obj = Record<string, unknown>;

function gqlState(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function gqlPullState(pull: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueCursor(seq: number): string {
  return Buffer.from(`issue-cursor:${seq}`, 'utf8').toString('base64url');
}

function parseIssueCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('issue-cursor:')) return null;
    const num = Number(text.slice('issue-cursor:'.length));
    return Number.isInteger(num) ? num : null;
  } catch {
    return null;
  }
}

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url',
];
const PULL_TYPE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
  'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author', 'url',
];
const REPO_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
  'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
];

class Executor {
  #ctx: ExecContext;
  constructor(ctx: ExecContext) {
    this.#ctx = ctx;
  }

  runOperation(op: OperationNode): Obj {
    const data: Obj = {};
    for (const selection of op.selection) {
      if (selection.kind === 'field') {
        data[selection.field.alias ?? selection.field.name] = this.resolveRoot(selection.field);
      }
    }
    return data;
  }

  resolveRoot(field: FieldNode): unknown {
    const store = this.#ctx.store;
    switch (field.name) {
      case 'viewer':
        return this.resolveUser(VIEWER, field.selection);
      case 'repository': {
        const owner = String(argValue(field, 'owner', this.#ctx) ?? '');
        const name = String(argValue(field, 'name', this.#ctx) ?? '');
        const repo = store.getRepo(owner, name);
        if (repo === undefined) return null;
        return this.resolveRepository(repo, field.selection);
      }
      case 'node': {
        const id = String(argValue(field, 'id', this.#ctx) ?? '');
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const [owner, name] = parsed.key.split('/');
          const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
          if (repo === undefined) return null;
          return this.resolveRepository(repo, field.selection, 'Repository');
        }
        if (parsed.kind === 'Issue') {
          const [ownerName, num] = parsed.key.split('#');
          const [owner, name] = (ownerName ?? '').split('/');
          const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
          const issue = repo?.issues.find((item) => item.number === Number(num));
          if (issue === undefined || repo === undefined) return null;
          return this.resolveIssue(repo, issue, field.selection, 'Issue');
        }
        return null;
      }
      case '__type': {
        const name = String(argValue(field, 'name', this.#ctx) ?? '');
        return this.resolveType(name, field.selection);
      }
      case 'createIssue':
        return this.mutateCreateIssue(field);
      case 'closeIssue':
        return this.mutateCloseIssue(field);
      case 'createPullRequest':
        return this.mutateCreatePullRequest(field);
      case 'mergePullRequest':
        return this.mutateMergePullRequest(field);
      case 'addComment':
        return this.mutateAddComment(field);
      default:
        this.#ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
        return null;
    }
  }

  resolveUser(user: { login: string; id: number }, selection: SelectionNode[]): Obj {
    const out: Obj = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'login') out[sel.field.alias ?? 'login'] = user.login;
      else if (sel.field.name === 'id') out[sel.field.alias ?? 'id'] = globalId('User', user.login);
      else this.#ctx.errors.push({ message: `Cannot query field "${sel.field.name}" on type "User".` });
    }
    return out;
  }

  resolveRepository(repo: Repo, selection: SelectionNode[], fragmentType: string | null = null): Obj {
    const out: Obj = {};
    for (const sel of selection) {
      if (sel.kind === 'inline') {
        if (sel.typeName === 'Repository' || fragmentType === 'Repository') {
          Object.assign(out, this.resolveRepository(repo, sel.selection, 'Repository'));
        }
        continue;
      }
      const field = sel.field;
      const key = field.alias ?? field.name;
      switch (field.name) {
        case 'id':
          out[key] = globalId('Repository', `${repo.owner}/${repo.name}`);
          break;
        case 'databaseId':
          out[key] = repo.id;
          break;
        case 'name':
          out[key] = repo.name;
          break;
        case 'nameWithOwner':
          out[key] = `${repo.owner}/${repo.name}`;
          break;
        case 'owner':
          out[key] = this.resolveUser({ login: repo.owner, id: VIEWER.id }, field.selection);
          break;
        case 'defaultBranchRef': {
          const ref = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          out[key] = ref === undefined ? null : this.resolveRef(repo.defaultBranch, field.selection);
          break;
        }
        case 'viewerPermission':
          out[key] = 'ADMIN';
          break;
        case 'hasIssuesEnabled':
          out[key] = true;
          break;
        case 'description':
          out[key] = repo.description;
          break;
        case 'isPrivate':
          out[key] = repo.isPrivate;
          break;
        case 'createdAt':
        case 'updatedAt':
          out[key] = FIXED_ISO;
          break;
        case 'url':
          out[key] = `https://example.invalid/${repo.owner}/${repo.name}`;
          break;
        case 'issue': {
          const number = Number(argValue(field, 'number', this.#ctx) ?? NaN);
          const issue = repo.issues.find((item) => item.number === number);
          out[key] = issue === undefined ? null : this.resolveIssue(repo, issue, field.selection);
          break;
        }
        case 'issues':
          out[key] = this.resolveIssueConnection(repo, field);
          break;
        case 'pullRequests':
          out[key] = this.resolvePullConnection(repo, field);
          break;
        case 'pullRequest': {
          const number = Number(argValue(field, 'number', this.#ctx) ?? NaN);
          const pull = repo.pulls.find((item) => item.number === number);
          out[key] = pull === undefined ? null : this.resolvePull(repo, pull, field.selection);
          break;
        }
        default:
          this.#ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
          out[key] = null;
      }
    }
    return out;
  }

  resolveRef(name: string, selection: SelectionNode[]): Obj {
    const out: Obj = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'name') out[sel.field.alias ?? 'name'] = name;
      else this.#ctx.errors.push({ message: `Cannot query field "${sel.field.name}" on type "Ref".` });
    }
    return out;
  }

  resolveIssueConnection(repo: Repo, field: FieldNode): Obj {
    const first = Number(argValue(field, 'first', this.#ctx) ?? 100);
    const states = argValue(field, 'states', this.#ctx) as string[] | undefined;
    const orderBy = argValue(field, 'orderBy', this.#ctx) as { field?: string; direction?: string } | undefined;
    const after = argValue(field, 'after', this.#ctx) as string | null | undefined;
    let list = [...repo.issues];
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      list = list.filter((issue) => wanted.has(issue.state));
    }
    const direction = orderBy?.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
    if (typeof after === 'string' && after !== '') {
      const cursorSeq = parseIssueCursor(after);
      if (cursorSeq !== null) {
        list = list.filter((issue) => (direction === 1 ? issue.seq > cursorSeq : issue.seq < cursorSeq));
      }
    }
    const page = list.slice(0, Math.max(0, first));
    const out: Obj = {};
    for (const sel of field.selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'nodes') {
        out[sel.field.alias ?? 'nodes'] = page.map((issue) => this.resolveIssue(repo, issue, sel.field.selection));
      } else if (sel.field.name === 'pageInfo') {
        const hasNext = list.length > page.length;
        const endCursor = page.length > 0 ? issueCursor((page[page.length - 1] as Issue).seq) : null;
        const info: Obj = {};
        for (const inner of sel.field.selection) {
          if (inner.kind !== 'field') continue;
          if (inner.field.name === 'hasNextPage') info[inner.field.alias ?? 'hasNextPage'] = hasNext;
          else if (inner.field.name === 'endCursor') info[inner.field.alias ?? 'endCursor'] = endCursor;
          else if (inner.field.name === 'hasPreviousPage') info[inner.field.alias ?? 'hasPreviousPage'] = false;
          else if (inner.field.name === 'startCursor') info[inner.field.alias ?? 'startCursor'] = page.length > 0 ? issueCursor((page[0] as Issue).seq) : null;
        }
        out[sel.field.alias ?? 'pageInfo'] = info;
      } else if (sel.field.name === 'totalCount') {
        out[sel.field.alias ?? 'totalCount'] = list.length;
      }
    }
    return out;
  }

  resolvePullConnection(repo: Repo, field: FieldNode): Obj {
    const first = Number(argValue(field, 'first', this.#ctx) ?? 100);
    const list = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, first));
    const out: Obj = {};
    for (const sel of field.selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'nodes') {
        out[sel.field.alias ?? 'nodes'] = list.map((pull) => this.resolvePull(repo, pull, sel.field.selection));
      } else if (sel.field.name === 'totalCount') {
        out[sel.field.alias ?? 'totalCount'] = repo.pulls.length;
      }
    }
    return out;
  }

  resolveIssue(repo: Repo, issue: Issue, selection: SelectionNode[], fragmentType: string | null = null): Obj {
    const out: Obj = {};
    for (const sel of selection) {
      if (sel.kind === 'inline') {
        if (sel.typeName === 'Issue' || fragmentType === 'Issue') Object.assign(out, this.resolveIssue(repo, issue, sel.selection, 'Issue'));
        continue;
      }
      const field = sel.field;
      const key = field.alias ?? field.name;
      switch (field.name) {
        case 'id':
          out[key] = globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
          break;
        case 'number':
          out[key] = issue.number;
          break;
        case 'title':
          out[key] = issue.title;
          break;
        case 'body':
          out[key] = issue.body;
          break;
        case 'state':
          out[key] = gqlState(issue);
          break;
        case 'createdAt':
        case 'updatedAt':
          out[key] = FIXED_ISO;
          break;
        case 'closedAt':
          out[key] = issue.state === 'closed' ? FIXED_ISO : null;
          break;
        case 'url':
          out[key] = `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
          break;
        default:
          this.#ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
          out[key] = null;
      }
    }
    return out;
  }

  resolvePull(repo: Repo, pull: PullRequest, selection: SelectionNode[]): Obj {
    const out: Obj = {};
    for (const sel of selection) {
      if (sel.kind === 'inline') {
        if (sel.typeName === 'PullRequest') Object.assign(out, this.resolvePull(repo, pull, sel.selection));
        continue;
      }
      const field = sel.field;
      const key = field.alias ?? field.name;
      switch (field.name) {
        case 'id':
          out[key] = globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
          break;
        case 'number':
          out[key] = pull.number;
          break;
        case 'title':
          out[key] = pull.title;
          break;
        case 'body':
          out[key] = pull.body;
          break;
        case 'state':
          out[key] = gqlPullState(pull);
          break;
        case 'merged':
          out[key] = pull.merged;
          break;
        case 'mergeable':
          out[key] = 'MERGEABLE';
          break;
        case 'headRefName':
          out[key] = pull.headRef;
          break;
        case 'baseRefName':
          out[key] = pull.baseRef;
          break;
        case 'headRef':
          out[key] = this.resolveRef(pull.headRef, field.selection);
          break;
        case 'baseRef':
          out[key] = this.resolveRef(pull.baseRef, field.selection);
          break;
        case 'files': {
          const first = Number(argValue(field, 'first', this.#ctx) ?? 100);
          const files = pullFiles(this.#ctx.store, pull).slice(0, Math.max(0, first));
          // The document shape is files(first: N) { nodes { path } }.
          const conn: Obj = {};
          for (const inner of field.selection) {
            if (inner.kind !== 'field') continue;
            if (inner.field.name === 'nodes') {
              conn[inner.field.alias ?? 'nodes'] = files.map((file) => {
                const nodeObj: Obj = {};
                for (const leaf of inner.field.selection) {
                  if (leaf.kind === 'field' && leaf.field.name === 'path') nodeObj[leaf.field.alias ?? 'path'] = file.filename;
                }
                return nodeObj;
              });
            }
          }
          out[key] = conn;
          break;
        }
        case 'createdAt':
        case 'updatedAt':
          out[key] = FIXED_ISO;
          break;
        case 'mergedAt':
          out[key] = pull.mergedAt;
          break;
        case 'url':
          out[key] = `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
          break;
        default:
          this.#ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
          out[key] = null;
      }
    }
    return out;
  }

  resolveType(name: string, selection: SelectionNode[]): Obj {
    const fields = name === 'Issue' ? ISSUE_TYPE_FIELDS : name === 'PullRequest' ? PULL_TYPE_FIELDS : name === 'Repository' ? REPO_TYPE_FIELDS : [];
    const enums = name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] : name === 'IssueState' ? ['OPEN', 'CLOSED'] : name === 'MergeableState' ? ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] : name === 'PullRequestState' ? ['OPEN', 'CLOSED', 'MERGED'] : name === 'RepositoryPermission' ? ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] : [];
    const out: Obj = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'fields') {
        out[sel.field.alias ?? 'fields'] = fields.map((fieldName) => {
          const entry: Obj = {};
          for (const inner of sel.field.selection) {
            if (inner.kind === 'field' && inner.field.name === 'name') entry[inner.field.alias ?? 'name'] = fieldName;
          }
          return entry;
        });
      } else if (sel.field.name === 'enumValues') {
        out[sel.field.alias ?? 'enumValues'] = enums.map((value) => {
          const entry: Obj = {};
          for (const inner of sel.field.selection) {
            if (inner.kind === 'field' && inner.field.name === 'name') entry[inner.field.alias ?? 'name'] = value;
          }
          return entry;
        });
      } else if (sel.field.name === 'name') {
        out[sel.field.alias ?? 'name'] = name;
      } else if (sel.field.name === 'kind') {
        out[sel.field.alias ?? 'kind'] = enums.length > 0 ? 'ENUM' : 'OBJECT';
      }
    }
    return out;
  }

  // --- mutations -----------------------------------------------------------

  inputObject(field: FieldNode): Record<string, unknown> {
    const raw = argValue(field, 'input', this.#ctx);
    return (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  }

  findRepoByGlobalId(id: string): Repo | null {
    const parsed = parseGlobalId(String(id));
    if (parsed === null || parsed.kind !== 'Repository') return null;
    const [owner, name] = parsed.key.split('/');
    if (owner === undefined || name === undefined) return null;
    return this.#ctx.store.getRepo(owner, name) ?? null;
  }

  findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const parsed = parseGlobalId(String(id));
    if (parsed === null || parsed.kind !== 'Issue') return null;
    const [ownerName, num] = parsed.key.split('#');
    const [owner, name] = (ownerName ?? '').split('/');
    if (owner === undefined || name === undefined) return null;
    const repo = this.#ctx.store.getRepo(owner, name);
    const issue = repo?.issues.find((item) => item.number === Number(num));
    return repo !== undefined && issue !== undefined ? { repo, issue } : null;
  }

  findPullByGlobalId(id: string): { repo: Repo; pull: PullRequest } | null {
    const parsed = parseGlobalId(String(id));
    if (parsed === null || parsed.kind !== 'PullRequest') return null;
    const [ownerName, num] = parsed.key.split('#');
    const [owner, name] = (ownerName ?? '').split('/');
    if (owner === undefined || name === undefined) return null;
    const repo = this.#ctx.store.getRepo(owner, name);
    const pull = repo?.pulls.find((item) => item.number === Number(num));
    return repo !== undefined && pull !== undefined ? { repo, pull } : null;
  }

  mutateCreateIssue(field: FieldNode): Obj {
    const input = this.inputObject(field);
    const repo = this.findRepoByGlobalId(String(input.repositoryId ?? ''));
    const out: Obj = {};
    for (const sel of field.selection) {
      if (sel.kind !== 'field' || sel.field.name !== 'issue') continue;
      if (repo === null) {
        out[sel.field.alias ?? 'issue'] = null;
        this.#ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        continue;
      }
      const issue: Issue = {
        id: repo.id * 100000 + repo.nextIssue,
        number: repo.nextIssue,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.nextIssue,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      out[sel.field.alias ?? 'issue'] = this.resolveIssue(repo, issue, sel.field.selection);
    }
    return out;
  }

  mutateCloseIssue(field: FieldNode): Obj {
    const input = this.inputObject(field);
    const found = this.findIssueByGlobalId(String(input.issueId ?? ''));
    const out: Obj = {};
    for (const sel of field.selection) {
      if (sel.kind !== 'field' || sel.field.name !== 'issue') continue;
      if (found === null) {
        out[sel.field.alias ?? 'issue'] = null;
        this.#ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        continue;
      }
      found.issue.state = 'closed';
      invalidateIssueBody(found.repo, found.issue);
      out[sel.field.alias ?? 'issue'] = this.resolveIssue(found.repo, found.issue, sel.field.selection);
    }
    return out;
  }

  mutateCreatePullRequest(field: FieldNode): Obj {
    const input = this.inputObject(field);
    const repo = this.findRepoByGlobalId(String(input.repositoryId ?? ''));
    const out: Obj = {};
    for (const sel of field.selection) {
      if (sel.kind !== 'field' || sel.field.name !== 'pullRequest') continue;
      if (repo === null) {
        out[sel.field.alias ?? 'pullRequest'] = null;
        this.#ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        continue;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = this.#ctx.store.resolveRef(repo, headRef);
      const baseSha = this.#ctx.store.resolveRef(repo, baseRef);
      if (headSha === null || baseSha === null) {
        out[sel.field.alias ?? 'pullRequest'] = null;
        this.#ctx.errors.push({ message: 'Head or base ref does not exist.' });
        continue;
      }
      const pull: PullRequest = {
        id: repo.id * 100000 + repo.nextPull,
        number: repo.nextPull,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      out[sel.field.alias ?? 'pullRequest'] = this.resolvePull(repo, pull, sel.field.selection);
    }
    return out;
  }

  mutateMergePullRequest(field: FieldNode): Obj {
    const input = this.inputObject(field);
    const found = this.findPullByGlobalId(String(input.pullRequestId ?? ''));
    const out: Obj = {};
    for (const sel of field.selection) {
      if (sel.kind !== 'field' || sel.field.name !== 'pullRequest') continue;
      if (found === null) {
        out[sel.field.alias ?? 'pullRequest'] = null;
        this.#ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
        continue;
      }
      const merged = mergePullSquash(this.#ctx.store, found.repo, found.pull);
      if (merged === null) {
        this.#ctx.errors.push({ message: 'Merge conflict: the pull request cannot be merged cleanly.' });
        out[sel.field.alias ?? 'pullRequest'] = this.resolvePull(found.repo, found.pull, sel.field.selection);
        continue;
      }
      out[sel.field.alias ?? 'pullRequest'] = this.resolvePull(found.repo, found.pull, sel.field.selection);
    }
    return out;
  }

  mutateAddComment(field: FieldNode): Obj {
    const input = this.inputObject(field);
    const found = this.findIssueByGlobalId(String(input.subjectId ?? ''));
    const out: Obj = {};
    for (const sel of field.selection) {
      if (sel.kind !== 'field' || sel.field.name !== 'commentEdge') continue;
      if (found === null) {
        out[sel.field.alias ?? 'commentEdge'] = null;
        this.#ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        continue;
      }
      const comment = { id: found.repo.nextCommentId, body: String(input.body ?? '') };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      invalidateIssueBody(found.repo, found.issue);
      const node: Obj = {};
      for (const inner of sel.field.selection) {
        if (inner.kind !== 'field' || inner.field.name !== 'node') continue;
        const commentNode: Obj = {};
        for (const leaf of inner.field.selection) {
          if (leaf.kind !== 'field') continue;
          if (leaf.field.name === 'id') commentNode[leaf.field.alias ?? 'id'] = globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`);
          else if (leaf.field.name === 'body') commentNode[leaf.field.alias ?? 'body'] = comment.body;
        }
        node[inner.field.alias ?? 'node'] = commentNode;
      }
      out[sel.field.alias ?? 'commentEdge'] = node;
    }
    return out;
  }
}

/** The files a pull request changes (merge-base tree vs head tree). */
export function pullFiles(store: ForgeStore, pull: PullRequest): { filename: string; status: string }[] {
  const base = store.mergeBase(pull.createdBaseSha, pull.headSha) ?? pull.createdBaseSha;
  const baseObj = store.getObject(base);
  const headObj = store.getObject(pull.headSha);
  if (baseObj === undefined || headObj === undefined) return [];
  const baseFlat = store.flattenTree(parseCommitData(baseObj.data).tree);
  const headFlat = store.flattenTree(parseCommitData(headObj.data).tree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: { filename: string; status: string }[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before === undefined && after !== undefined) out.push({ filename: path, status: 'added' });
    else if (before !== undefined && after === undefined) out.push({ filename: path, status: 'removed' });
    else if (before !== undefined && after !== undefined && before.sha !== after.sha) out.push({ filename: path, status: 'modified' });
  }
  return out;
}

function parseCommitData(data: Buffer): { tree: string; parents: string[]; message: string } {
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

// --- HTTP entry --------------------------------------------------------------

export async function handleGraphQL(ctx: { store: ForgeStore; token: string }, req: { headers: Record<string, string | string[] | undefined>; method?: string }, res: ForgeRes, bodyText: string): Promise<void> {
  const { store } = ctx;
  const header = req.headers.authorization ?? '';
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (presented.length === 0 || (ctx.token !== '' && presented !== ctx.token)) {
    sendJson(res, store, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendJson(res, store, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { data: null, errors: [{ message: 'Expected a GraphQL operation object.' }] };
    }
    const record = doc as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? record.variables : {}) as Record<string, unknown>;
    const execCtx: ExecContext = { store, variables, errors: [] };
    try {
      const ops = new Parser(tokenize(query)).parseDocument();
      if (ops.length === 0) return { data: null, errors: [{ message: 'No operation found.' }] };
      const executor = new Executor(execCtx);
      const data = executor.runOperation(ops[0] as OperationNode);
      if (execCtx.errors.length > 0) return { data, errors: execCtx.errors };
      return { data };
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, store, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, store, 200, runOne(parsed));
}

export { issueJson, pullJson, repoJson };

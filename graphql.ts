// graphql.ts — a small GraphQL v4 engine for exactly the documents gh and
// github-mcp-server send. No schema library: a hand-written lexer and parser
// for the fixed document shapes, plus resolvers over the same store REST uses.
//
// Rules the suite enforces (checks-graphql.ts):
// - an unauthenticated POST is exactly 401; an unknown field is HTTP 200 with
//   an errors array naming it; an unknown repository is data.repository = null
//   with no errors attached.
// - global ids are opaque (never the bare numeric id) and stable across reads.
// - issues orderBy CREATED_AT DESC, ties by number DESC; states: [OPEN] omits closed.
// - batched operations (a JSON array body) answer a JSON array, in order.

import type { ForgeRes } from './app.ts';
import {
  FIXED_ISO,
  VIEWER,
  globalId,
  parseGlobalId,
  type ForgeStore,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  invalidateIssueBody,
  issueJson,
  mergePullSquash,
  pullJson,
  repoJson,
  sendJson,
} from './rest.ts';

// --- tokenizer ---------------------------------------------------------------

type LexToken =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

const PUNCTUATION = '{}()[]:!=$@';

function lex(source: string): LexToken[] {
  const lexed: LexToken[] = [];
  let pos = 0;
  while (pos < source.length) {
    const char = source[pos] as string;
    if (' \n\r\t,'.includes(char)) {
      pos += 1;
      continue;
    }
    if (char === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (char === '.' && source.slice(pos, pos + 3) === '...') {
      lexed.push({ kind: 'spread', value: '...' });
      pos += 3;
      continue;
    }
    if (PUNCTUATION.includes(char)) {
      lexed.push({ kind: 'punct', value: char });
      pos += 1;
      continue;
    }
    if (char === '"') {
      let end = pos + 1;
      let text = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1] as string;
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          end += 2;
        } else {
          text += source[end] as string;
          end += 1;
        }
      }
      lexed.push({ kind: 'string', value: text });
      pos = end + 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = pos;
      while (end < source.length && /[0-9.]/.test(source[end] as string)) end += 1;
      lexed.push({ kind: 'int', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = pos;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1;
      lexed.push({ kind: 'name', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return lexed;
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

class QueryParser {
  #lexed: LexToken[];
  #at = 0;
  constructor(lexed: LexToken[]) {
    this.#lexed = lexed;
  }
  current(): LexToken | undefined {
    return this.#lexed[this.#at];
  }
  advance(): LexToken {
    const tok = this.#lexed[this.#at] as LexToken;
    this.#at += 1;
    return tok;
  }
  needPunct(value: string): void {
    const tok = this.advance();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(tok)}`);
  }
  needName(value?: string): string {
    const tok = this.advance();
    if (tok.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(tok)}`);
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
    return tok.value;
  }
  lookingAt(value: string): boolean {
    const tok = this.current();
    return tok !== undefined && tok.kind === 'punct' && tok.value === value;
  }

  readDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.current() !== undefined) {
      operations.push(this.readOperation());
    }
    return operations;
  }

  readOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.current();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.advance().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.current();
    if (maybeName !== undefined && maybeName.kind === 'name') name = this.advance().value;
    const variables: OperationNode['variables'] = [];
    if (this.lookingAt('(')) {
      this.advance();
      while (this.lookingAt(')') === false) {
        this.needPunct('$');
        const varName = this.needName();
        this.needPunct(':');
        this.readType();
        let defaultValue: ValueNode | null = null;
        if (this.lookingAt('=')) {
          this.advance();
          defaultValue = this.readValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.needPunct(')');
    }
    const selection = this.readSelectionSet();
    return { kind, name, variables, selection };
  }

  readType(): void {
    if (this.lookingAt('[')) {
      this.advance();
      this.readType();
      this.needPunct(']');
    } else {
      this.needName();
    }
    if (this.lookingAt('!')) this.advance();
  }

  readSelectionSet(): SelectionNode[] {
    this.needPunct('{');
    const picks: SelectionNode[] = [];
    while (this.lookingAt('}') === false) {
      picks.push(this.readSelection());
    }
    this.needPunct('}');
    return picks;
  }

  readSelection(): SelectionNode {
    const tok = this.current();
    if (tok !== undefined && tok.kind === 'spread') {
      this.advance();
      this.needName('on');
      const typeName = this.needName();
      return { kind: 'inline', typeName, selection: this.readSelectionSet() };
    }
    const head = this.needName();
    let alias: string | null = null;
    let fieldName = head;
    if (this.lookingAt(':')) {
      this.advance();
      alias = head;
      fieldName = this.needName();
    }
    const args: FieldNode['args'] = [];
    if (this.lookingAt('(')) {
      this.advance();
      while (this.lookingAt(')') === false) {
        const argName = this.needName();
        this.needPunct(':');
        args.push({ name: argName, value: this.readValue() });
      }
      this.needPunct(')');
    }
    // Directives (none are sent, but skip them if present).
    while (this.lookingAt('@')) {
      this.advance();
      this.needName();
      if (this.lookingAt('(')) {
        this.advance();
        let level = 1;
        while (level > 0) {
          const inner = this.advance();
          if (inner.kind === 'punct' && inner.value === '(') level += 1;
          if (inner.kind === 'punct' && inner.value === ')') level -= 1;
        }
      }
    }
    let selection: SelectionNode[] = [];
    const ahead = this.current();
    if (ahead !== undefined && ahead.kind === 'punct' && (ahead as { value: string }).value === '{') {
      selection = this.readSelectionSet();
    }
    return { kind: 'field', field: { alias, name: fieldName, args, selection } };
  }

  readValue(): ValueNode {
    const tok = this.advance();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.needName() };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (this.lookingAt(']') === false) items.push(this.readValue());
      this.needPunct(']');
      return { kind: 'list', values: items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const entries: { name: string; value: ValueNode }[] = [];
      while (this.lookingAt('}') === false) {
        const entryName = this.needName();
        this.needPunct(':');
        entries.push({ name: entryName, value: this.readValue() });
      }
      this.needPunct('}');
      return { kind: 'object', fields: entries };
    }
    throw new Error(`unexpected value token ${JSON.stringify(tok)}`);
  }
}

// --- execution ---------------------------------------------------------------

interface RunContext {
  db: ForgeStore;
  vars: Record<string, unknown>;
  problems: { message: string }[];
}

function evalNode(value: ValueNode, run: RunContext): unknown {
  switch (value.kind) {
    case 'variable': {
      const found = run.vars[value.name];
      return found === undefined ? null : found;
    }
    case 'int':
      return value.value;
    case 'string':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((child) => evalNode(child, run));
    case 'object': {
      const built: Record<string, unknown> = {};
      for (const entry of value.fields) built[entry.name] = evalNode(entry.value, run);
      return built;
    }
  }
}

function argumentOf(node: FieldNode, name: string, run: RunContext): unknown {
  const arg = node.args.find((entry) => entry.name === name);
  return arg === undefined ? undefined : evalNode(arg.value, run);
}

type OutMap = Record<string, unknown>;

function issueStateName(item: Issue): 'OPEN' | 'CLOSED' {
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateName(pr: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeIssueCursor(seq: number): string {
  return Buffer.from(`issue-cursor:${seq}`, 'utf8').toString('base64url');
}

function decodeIssueCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (text.startsWith('issue-cursor:') === false) return null;
    const num = Number(text.slice('issue-cursor:'.length));
    return Number.isInteger(num) ? num : null;
  } catch {
    return null;
  }
}

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url',
];
const PULL_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
  'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author', 'url',
];
const REPO_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
  'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
];

const FIELDS_BY_TYPE: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_FIELDS,
  Repository: REPO_FIELDS,
};

const ENUMS_BY_TYPE: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

class Engine {
  #run: RunContext;
  constructor(run: RunContext) {
    this.#run = run;
  }

  execute(op: OperationNode): OutMap {
    const result: OutMap = {};
    for (const choice of op.selection) {
      if (choice.kind === 'field') {
        result[choice.field.alias ?? choice.field.name] = this.resolveTop(choice.field);
      }
    }
    return result;
  }

  resolveTop(node: FieldNode): unknown {
    const db = this.#run.db;
    switch (node.name) {
      case 'viewer':
        return this.userView(VIEWER, node.selection);
      case 'repository': {
        const ownerLogin = String(argumentOf(node, 'owner', this.#run) ?? '');
        const repoName = String(argumentOf(node, 'name', this.#run) ?? '');
        const repository = db.getRepo(ownerLogin, repoName);
        if (repository === undefined) return null;
        return this.repositoryView(repository, node.selection);
      }
      case 'node': {
        const id = String(argumentOf(node, 'id', this.#run) ?? '');
        const decoded = parseGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const [login, repoName] = decoded.key.split('/');
          const repository = login !== undefined && repoName !== undefined ? db.getRepo(login, repoName) : undefined;
          if (repository === undefined) return null;
          return this.repositoryView(repository, node.selection, 'Repository');
        }
        if (decoded.kind === 'Issue') {
          const [ownerName, num] = decoded.key.split('#');
          const [login, repoName] = (ownerName ?? '').split('/');
          const repository = login !== undefined && repoName !== undefined ? db.getRepo(login, repoName) : undefined;
          const item = repository?.issues.find((entry) => entry.number === Number(num));
          if (item === undefined || repository === undefined) return null;
          return this.issueView(repository, item, node.selection, 'Issue');
        }
        return null;
      }
      case '__type': {
        const typeName = String(argumentOf(node, 'name', this.#run) ?? '');
        return this.typeView(typeName, node.selection);
      }
      case 'createIssue':
        return this.createIssue(node);
      case 'closeIssue':
        return this.closeIssue(node);
      case 'createPullRequest':
        return this.createPullRequest(node);
      case 'mergePullRequest':
        return this.mergePullRequest(node);
      case 'addComment':
        return this.addComment(node);
      default:
        this.#run.problems.push({ message: `Cannot query field "${node.name}" on type "Query".` });
        return null;
    }
  }

  userView(account: { login: string; id: number }, picks: SelectionNode[]): OutMap {
    const result: OutMap = {};
    for (const choice of picks) {
      if (choice.kind !== 'field') continue;
      if (choice.field.name === 'login') result[choice.field.alias ?? 'login'] = account.login;
      else if (choice.field.name === 'id') result[choice.field.alias ?? 'id'] = globalId('User', account.login);
      else this.#run.problems.push({ message: `Cannot query field "${choice.field.name}" on type "User".` });
    }
    return result;
  }

  repositoryView(repository: Repo, picks: SelectionNode[], fragmentType: string | null = null): OutMap {
    const result: OutMap = {};
    for (const choice of picks) {
      if (choice.kind === 'inline') {
        if (choice.typeName === 'Repository' || fragmentType === 'Repository') {
          Object.assign(result, this.repositoryView(repository, choice.selection, 'Repository'));
        }
        continue;
      }
      const node = choice.field;
      const slot = node.alias ?? node.name;
      switch (node.name) {
        case 'id':
          result[slot] = globalId('Repository', `${repository.owner}/${repository.name}`);
          break;
        case 'databaseId':
          result[slot] = repository.id;
          break;
        case 'name':
          result[slot] = repository.name;
          break;
        case 'nameWithOwner':
          result[slot] = `${repository.owner}/${repository.name}`;
          break;
        case 'owner':
          result[slot] = this.userView({ login: repository.owner, id: VIEWER.id }, node.selection);
          break;
        case 'defaultBranchRef': {
          const tip = repository.refs.get(`refs/heads/${repository.defaultBranch}`);
          result[slot] = tip === undefined ? null : this.refView(repository.defaultBranch, node.selection);
          break;
        }
        case 'viewerPermission':
          result[slot] = 'ADMIN';
          break;
        case 'hasIssuesEnabled':
          result[slot] = true;
          break;
        case 'description':
          result[slot] = repository.description;
          break;
        case 'isPrivate':
          result[slot] = repository.isPrivate;
          break;
        case 'createdAt':
        case 'updatedAt':
          result[slot] = FIXED_ISO;
          break;
        case 'url':
          result[slot] = `https://example.invalid/${repository.owner}/${repository.name}`;
          break;
        case 'issue': {
          const number = Number(argumentOf(node, 'number', this.#run) ?? NaN);
          const item = repository.issues.find((entry) => entry.number === number);
          result[slot] = item === undefined ? null : this.issueView(repository, item, node.selection);
          break;
        }
        case 'issues':
          result[slot] = this.issueConnection(repository, node);
          break;
        case 'pullRequests':
          result[slot] = this.pullConnection(repository, node);
          break;
        case 'pullRequest': {
          const number = Number(argumentOf(node, 'number', this.#run) ?? NaN);
          const pr = repository.pulls.find((entry) => entry.number === number);
          result[slot] = pr === undefined ? null : this.pullView(repository, pr, node.selection);
          break;
        }
        default:
          this.#run.problems.push({ message: `Cannot query field "${node.name}" on type "Repository".` });
          result[slot] = null;
      }
    }
    return result;
  }

  refView(refName: string, picks: SelectionNode[]): OutMap {
    const result: OutMap = {};
    for (const choice of picks) {
      if (choice.kind !== 'field') continue;
      if (choice.field.name === 'name') result[choice.field.alias ?? 'name'] = refName;
      else this.#run.problems.push({ message: `Cannot query field "${choice.field.name}" on type "Ref".` });
    }
    return result;
  }

  issueConnection(repository: Repo, node: FieldNode): OutMap {
    const limit = Number(argumentOf(node, 'first', this.#run) ?? 100);
    const wanted = argumentOf(node, 'states', this.#run) as string[] | undefined;
    const ordering = argumentOf(node, 'orderBy', this.#run) as { field?: string; direction?: string } | undefined;
    const cursor = argumentOf(node, 'after', this.#run) as string | null | undefined;
    let items = [...repository.issues];
    if (Array.isArray(wanted) && wanted.length > 0) {
      const states = new Set(wanted.map((state) => String(state).toLowerCase()));
      items = items.filter((item) => states.has(item.state));
    }
    const dir = ordering?.direction === 'ASC' ? 1 : -1;
    items.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
    if (typeof cursor === 'string' && cursor !== '') {
      const afterSeq = decodeIssueCursor(cursor);
      if (afterSeq !== null) {
        items = items.filter((item) => (dir === 1 ? item.seq > afterSeq : item.seq < afterSeq));
      }
    }
    const slice = items.slice(0, Math.max(0, limit));
    const result: OutMap = {};
    for (const choice of node.selection) {
      if (choice.kind !== 'field') continue;
      if (choice.field.name === 'nodes') {
        result[choice.field.alias ?? 'nodes'] = slice.map((item) => this.issueView(repository, item, choice.field.selection));
      } else if (choice.field.name === 'pageInfo') {
        const more = items.length > slice.length;
        const lastCursor = slice.length > 0 ? encodeIssueCursor((slice[slice.length - 1] as Issue).seq) : null;
        const pageInfo: OutMap = {};
        for (const inner of choice.field.selection) {
          if (inner.kind !== 'field') continue;
          if (inner.field.name === 'hasNextPage') pageInfo[inner.field.alias ?? 'hasNextPage'] = more;
          else if (inner.field.name === 'endCursor') pageInfo[inner.field.alias ?? 'endCursor'] = lastCursor;
          else if (inner.field.name === 'hasPreviousPage') pageInfo[inner.field.alias ?? 'hasPreviousPage'] = false;
          else if (inner.field.name === 'startCursor') pageInfo[inner.field.alias ?? 'startCursor'] = slice.length > 0 ? encodeIssueCursor((slice[0] as Issue).seq) : null;
        }
        result[choice.field.alias ?? 'pageInfo'] = pageInfo;
      } else if (choice.field.name === 'totalCount') {
        result[choice.field.alias ?? 'totalCount'] = items.length;
      }
    }
    return result;
  }

  pullConnection(repository: Repo, node: FieldNode): OutMap {
    const limit = Number(argumentOf(node, 'first', this.#run) ?? 100);
    const slice = [...repository.pulls].sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, limit));
    const result: OutMap = {};
    for (const choice of node.selection) {
      if (choice.kind !== 'field') continue;
      if (choice.field.name === 'nodes') {
        result[choice.field.alias ?? 'nodes'] = slice.map((pr) => this.pullView(repository, pr, choice.field.selection));
      } else if (choice.field.name === 'totalCount') {
        result[choice.field.alias ?? 'totalCount'] = repository.pulls.length;
      }
    }
    return result;
  }

  issueView(repository: Repo, item: Issue, picks: SelectionNode[], fragmentType: string | null = null): OutMap {
    const result: OutMap = {};
    for (const choice of picks) {
      if (choice.kind === 'inline') {
        if (choice.typeName === 'Issue' || fragmentType === 'Issue') Object.assign(result, this.issueView(repository, item, choice.selection, 'Issue'));
        continue;
      }
      const node = choice.field;
      const slot = node.alias ?? node.name;
      switch (node.name) {
        case 'id':
          result[slot] = globalId('Issue', `${repository.owner}/${repository.name}#${item.number}`);
          break;
        case 'number':
          result[slot] = item.number;
          break;
        case 'title':
          result[slot] = item.title;
          break;
        case 'body':
          result[slot] = item.body;
          break;
        case 'state':
          result[slot] = issueStateName(item);
          break;
        case 'createdAt':
        case 'updatedAt':
          result[slot] = FIXED_ISO;
          break;
        case 'closedAt':
          result[slot] = item.state === 'closed' ? FIXED_ISO : null;
          break;
        case 'url':
          result[slot] = `https://example.invalid/${repository.owner}/${repository.name}/issues/${item.number}`;
          break;
        default:
          this.#run.problems.push({ message: `Cannot query field "${node.name}" on type "Issue".` });
          result[slot] = null;
      }
    }
    return result;
  }

  pullView(repository: Repo, pr: PullRequest, picks: SelectionNode[]): OutMap {
    const result: OutMap = {};
    for (const choice of picks) {
      if (choice.kind === 'inline') {
        if (choice.typeName === 'PullRequest') Object.assign(result, this.pullView(repository, pr, choice.selection));
        continue;
      }
      const node = choice.field;
      const slot = node.alias ?? node.name;
      switch (node.name) {
        case 'id':
          result[slot] = globalId('PullRequest', `${repository.owner}/${repository.name}#${pr.number}`);
          break;
        case 'number':
          result[slot] = pr.number;
          break;
        case 'title':
          result[slot] = pr.title;
          break;
        case 'body':
          result[slot] = pr.body;
          break;
        case 'state':
          result[slot] = pullStateName(pr);
          break;
        case 'merged':
          result[slot] = pr.merged;
          break;
        case 'mergeable':
          result[slot] = 'MERGEABLE';
          break;
        case 'headRefName':
          result[slot] = pr.headRef;
          break;
        case 'baseRefName':
          result[slot] = pr.baseRef;
          break;
        case 'headRef':
          result[slot] = this.refView(pr.headRef, node.selection);
          break;
        case 'baseRef':
          result[slot] = this.refView(pr.baseRef, node.selection);
          break;
        case 'files': {
          const limit = Number(argumentOf(node, 'first', this.#run) ?? 100);
          const files = pullFiles(this.#run.db, pr).slice(0, Math.max(0, limit));
          // The document shape is files(first: N) { nodes { path } }.
          const conn: OutMap = {};
          for (const inner of node.selection) {
            if (inner.kind !== 'field') continue;
            if (inner.field.name === 'nodes') {
              conn[inner.field.alias ?? 'nodes'] = files.map((file) => {
                const nodeObj: OutMap = {};
                for (const leaf of inner.field.selection) {
                  if (leaf.kind === 'field' && leaf.field.name === 'path') nodeObj[leaf.field.alias ?? 'path'] = file.filename;
                }
                return nodeObj;
              });
            }
          }
          result[slot] = conn;
          break;
        }
        case 'createdAt':
        case 'updatedAt':
          result[slot] = FIXED_ISO;
          break;
        case 'mergedAt':
          result[slot] = pr.mergedAt;
          break;
        case 'url':
          result[slot] = `https://example.invalid/${repository.owner}/${repository.name}/pull/${pr.number}`;
          break;
        default:
          this.#run.problems.push({ message: `Cannot query field "${node.name}" on type "PullRequest".` });
          result[slot] = null;
      }
    }
    return result;
  }

  typeView(typeName: string, picks: SelectionNode[]): OutMap {
    const fieldNames = FIELDS_BY_TYPE[typeName] ?? [];
    const enumNames = ENUMS_BY_TYPE[typeName] ?? [];
    const result: OutMap = {};
    for (const choice of picks) {
      if (choice.kind !== 'field') continue;
      if (choice.field.name === 'fields') {
        result[choice.field.alias ?? 'fields'] = fieldNames.map((fieldName) => {
          const row: OutMap = {};
          for (const inner of choice.field.selection) {
            if (inner.kind === 'field' && inner.field.name === 'name') row[inner.field.alias ?? 'name'] = fieldName;
          }
          return row;
        });
      } else if (choice.field.name === 'enumValues') {
        result[choice.field.alias ?? 'enumValues'] = enumNames.map((value) => {
          const row: OutMap = {};
          for (const inner of choice.field.selection) {
            if (inner.kind === 'field' && inner.field.name === 'name') row[inner.field.alias ?? 'name'] = value;
          }
          return row;
        });
      } else if (choice.field.name === 'name') {
        result[choice.field.alias ?? 'name'] = typeName;
      } else if (choice.field.name === 'kind') {
        result[choice.field.alias ?? 'kind'] = enumNames.length > 0 ? 'ENUM' : 'OBJECT';
      }
    }
    return result;
  }

  // --- mutations -----------------------------------------------------------

  inputOf(node: FieldNode): Record<string, unknown> {
    const given = argumentOf(node, 'input', this.#run);
    return (given !== null && typeof given === 'object' && Array.isArray(given) === false ? given : {}) as Record<string, unknown>;
  }

  repoByGlobalId(id: string): Repo | null {
    const decoded = parseGlobalId(String(id));
    if (decoded === null || decoded.kind !== 'Repository') return null;
    const [login, repoName] = decoded.key.split('/');
    if (login === undefined || repoName === undefined) return null;
    return this.#run.db.getRepo(login, repoName) ?? null;
  }

  issueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const decoded = parseGlobalId(String(id));
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const [ownerName, num] = decoded.key.split('#');
    const [login, repoName] = (ownerName ?? '').split('/');
    if (login === undefined || repoName === undefined) return null;
    const repository = this.#run.db.getRepo(login, repoName);
    const item = repository?.issues.find((entry) => entry.number === Number(num));
    return repository !== undefined && item !== undefined ? { repo: repository, issue: item } : null;
  }

  pullByGlobalId(id: string): { repo: Repo; pull: PullRequest } | null {
    const decoded = parseGlobalId(String(id));
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const [ownerName, num] = decoded.key.split('#');
    const [login, repoName] = (ownerName ?? '').split('/');
    if (login === undefined || repoName === undefined) return null;
    const repository = this.#run.db.getRepo(login, repoName);
    const pr = repository?.pulls.find((entry) => entry.number === Number(num));
    return repository !== undefined && pr !== undefined ? { repo: repository, pull: pr } : null;
  }

  createIssue(node: FieldNode): OutMap {
    const args = this.inputOf(node);
    const repository = this.repoByGlobalId(String(args.repositoryId ?? ''));
    const result: OutMap = {};
    for (const choice of node.selection) {
      if (choice.kind !== 'field' || choice.field.name !== 'issue') continue;
      if (repository === null) {
        result[choice.field.alias ?? 'issue'] = null;
        this.#run.problems.push({ message: 'Could not resolve to a Repository with the provided id.' });
        continue;
      }
      const item: Issue = {
        id: repository.id * 100000 + repository.nextIssue,
        number: repository.nextIssue,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        seq: repository.nextIssue,
      };
      repository.nextIssue += 1;
      repository.issues.push(item);
      result[choice.field.alias ?? 'issue'] = this.issueView(repository, item, choice.field.selection);
    }
    return result;
  }

  closeIssue(node: FieldNode): OutMap {
    const args = this.inputOf(node);
    const target = this.issueByGlobalId(String(args.issueId ?? ''));
    const result: OutMap = {};
    for (const choice of node.selection) {
      if (choice.kind !== 'field' || choice.field.name !== 'issue') continue;
      if (target === null) {
        result[choice.field.alias ?? 'issue'] = null;
        this.#run.problems.push({ message: 'Could not resolve to an Issue with the provided id.' });
        continue;
      }
      target.issue.state = 'closed';
      invalidateIssueBody(target.repo, target.issue);
      result[choice.field.alias ?? 'issue'] = this.issueView(target.repo, target.issue, choice.field.selection);
    }
    return result;
  }

  createPullRequest(node: FieldNode): OutMap {
    const args = this.inputOf(node);
    const repository = this.repoByGlobalId(String(args.repositoryId ?? ''));
    const result: OutMap = {};
    for (const choice of node.selection) {
      if (choice.kind !== 'field' || choice.field.name !== 'pullRequest') continue;
      if (repository === null) {
        result[choice.field.alias ?? 'pullRequest'] = null;
        this.#run.problems.push({ message: 'Could not resolve to a Repository with the provided id.' });
        continue;
      }
      const headRef = String(args.headRefName ?? '');
      const baseRef = String(args.baseRefName ?? '');
      const headSha = this.#run.db.resolveRef(repository, headRef);
      const baseSha = this.#run.db.resolveRef(repository, baseRef);
      if (headSha === null || baseSha === null) {
        result[choice.field.alias ?? 'pullRequest'] = null;
        this.#run.problems.push({ message: 'Head or base ref does not exist.' });
        continue;
      }
      const pr: PullRequest = {
        id: repository.id * 100000 + repository.nextPull,
        number: repository.nextPull,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        state: 'open',
        headRef,
        baseRef,
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
      result[choice.field.alias ?? 'pullRequest'] = this.pullView(repository, pr, choice.field.selection);
    }
    return result;
  }

  mergePullRequest(node: FieldNode): OutMap {
    const args = this.inputOf(node);
    const target = this.pullByGlobalId(String(args.pullRequestId ?? ''));
    const result: OutMap = {};
    for (const choice of node.selection) {
      if (choice.kind !== 'field' || choice.field.name !== 'pullRequest') continue;
      if (target === null) {
        result[choice.field.alias ?? 'pullRequest'] = null;
        this.#run.problems.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
        continue;
      }
      const merged = mergePullSquash(this.#run.db, target.repo, target.pull);
      if (merged === null) {
        this.#run.problems.push({ message: 'Merge conflict: the pull request cannot be merged cleanly.' });
        result[choice.field.alias ?? 'pullRequest'] = this.pullView(target.repo, target.pull, choice.field.selection);
        continue;
      }
      result[choice.field.alias ?? 'pullRequest'] = this.pullView(target.repo, target.pull, choice.field.selection);
    }
    return result;
  }

  addComment(node: FieldNode): OutMap {
    const args = this.inputOf(node);
    const target = this.issueByGlobalId(String(args.subjectId ?? ''));
    const result: OutMap = {};
    for (const choice of node.selection) {
      if (choice.kind !== 'field' || choice.field.name !== 'commentEdge') continue;
      if (target === null) {
        result[choice.field.alias ?? 'commentEdge'] = null;
        this.#run.problems.push({ message: 'Could not resolve to an Issue with the provided id.' });
        continue;
      }
      const note = { id: target.repo.nextCommentId, body: String(args.body ?? '') };
      target.repo.nextCommentId += 1;
      target.issue.comments.push(note);
      invalidateIssueBody(target.repo, target.issue);
      const edge: OutMap = {};
      for (const inner of choice.field.selection) {
        if (inner.kind !== 'field' || inner.field.name !== 'node') continue;
        const noteNode: OutMap = {};
        for (const leaf of inner.field.selection) {
          if (leaf.kind !== 'field') continue;
          if (leaf.field.name === 'id') noteNode[leaf.field.alias ?? 'id'] = globalId('IssueComment', `${target.repo.owner}/${target.repo.name}#${target.issue.number}:${note.id}`);
          else if (leaf.field.name === 'body') noteNode[leaf.field.alias ?? 'body'] = note.body;
        }
        edge[inner.field.alias ?? 'node'] = noteNode;
      }
      result[choice.field.alias ?? 'commentEdge'] = edge;
    }
    return result;
  }
}

/** The files a pull request changes (merge-base tree vs head tree). */
export function pullFiles(db: ForgeStore, pr: PullRequest): { filename: string; status: string }[] {
  const ancestor = db.mergeBase(pr.createdBaseSha, pr.headSha) ?? pr.createdBaseSha;
  const ancestorObj = db.getObject(ancestor);
  const headObj = db.getObject(pr.headSha);
  if (ancestorObj === undefined || headObj === undefined) return [];
  const ancestorFiles = db.flattenTree(readCommitData(ancestorObj.data).tree);
  const headFiles = db.flattenTree(readCommitData(headObj.data).tree);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  const out: { filename: string; status: string }[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = ancestorFiles.get(path);
    const newEntry = headFiles.get(path);
    if (oldEntry === undefined && newEntry !== undefined) out.push({ filename: path, status: 'added' });
    else if (oldEntry !== undefined && newEntry === undefined) out.push({ filename: path, status: 'removed' });
    else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha !== newEntry.sha) out.push({ filename: path, status: 'modified' });
  }
  return out;
}

function readCommitData(data: Buffer): { tree: string; parents: string[]; message: string } {
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

// --- HTTP entry --------------------------------------------------------------

export async function handleGraphQL(ctx: { store: ForgeStore; token: string }, req: { headers: Record<string, string | string[] | undefined>; method?: string }, res: ForgeRes, bodyText: string): Promise<void> {
  const db = ctx.store;
  const auth = req.headers.authorization ?? '';
  const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (presented.length === 0 || (ctx.token !== '' && presented !== ctx.token)) {
    sendJson(res, db, 401, { message: 'Requires authentication' });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, db, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return;
  }
  const executeOne = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { data: null, errors: [{ message: 'Expected a GraphQL operation object.' }] };
    }
    const record = doc as Record<string, unknown>;
    const source = typeof record.query === 'string' ? record.query : '';
    const vars = (record.variables !== null && typeof record.variables === 'object' && Array.isArray(record.variables) === false ? record.variables : {}) as Record<string, unknown>;
    const run: RunContext = { db, vars, problems: [] };
    try {
      const operations = new QueryParser(lex(source)).readDocument();
      if (operations.length === 0) return { data: null, errors: [{ message: 'No operation found.' }] };
      const engine = new Engine(run);
      const result = engine.execute(operations[0] as OperationNode);
      if (run.problems.length > 0) return { data: result, errors: run.problems };
      return { data: result };
    } catch (failure) {
      return { data: null, errors: [{ message: failure instanceof Error ? failure.message : String(failure) }] };
    }
  };
  if (Array.isArray(payload)) {
    sendJson(res, db, 200, payload.map(executeOne));
    return;
  }
  sendJson(res, db, 200, executeOne(payload));
}

export {
  issueJson,
  pullJson,
  repoJson,
};

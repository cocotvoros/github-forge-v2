// graphql.ts — github-forge-v2's GraphQL v4 surface: a small generic executor over the documented
// schema (Query, Mutation, Repository, Issue, PullRequest, connections, Relay node ids and
// introspection), written for the documents gh and github-mcp-server actually send. Global ids are
// opaque base64url strings with a type prefix (R:/I:/P:/C:) and are stable across reads.

import { Forge, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';

// ------------------------------------------------------------------ ids

export function repoGlobalId(repo: RepoRec): string {
  return Buffer.from(`R:${repo.id}`, 'utf8').toString('base64url');
}
export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return Buffer.from(`I:${repo.id}:${issue.number}`, 'utf8').toString('base64url');
}
export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return Buffer.from(`P:${repo.id}:${pull.number}`, 'utf8').toString('base64url');
}
export function commentGlobalId(repo: RepoRec, issue: IssueRec, commentId: number): string {
  return Buffer.from(`C:${repo.id}:${issue.number}:${commentId}`, 'utf8').toString('base64url');
}
export function userGlobalId(): string {
  return Buffer.from(`U:${VIEWER.id}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): string {
  try { return Buffer.from(id, 'base64url').toString('utf8'); } catch { return ''; }
}

// ------------------------------------------------------------------ schema tables (introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search', 'user', 'organization', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['login', 'id', 'name', 'email', 'databaseId', 'url', 'isViewer'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'labels', 'stargazerCount', 'forkCount'],
  Ref: ['name', 'target', 'prefix'],
  Commit: ['oid', 'message', 'committedDate', 'author'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository', 'closed'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository', 'mergeCommit', 'additions', 'deletions', 'changedFiles'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const OBJECT_TYPES = new Set(Object.keys(TYPE_FIELDS));

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field'; name: string; alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation'; name: string | null;
  variableNames: string[]; selectionSet: SelectionNode[];
}

interface DocumentNode { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> }

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '#') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (/\s|,/.test(char)) { index += 1; continue; }
    if (source.startsWith('...', index)) { tokens.push({ kind: '...', value: '...' }); index += 3; continue; }
    if (PUNCT.has(char)) { tokens.push({ kind: char, value: char }); index += 1; continue; }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        tokens.push({ kind: 'string', value: source.slice(index + 3, end < 0 ? source.length : end) });
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
        } else { value += source[index]; index += 1; }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[-0-9]/.test(char)) {
      let end = index;
      while (end < source.length && /[0-9.eE+-]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'number', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let end = index;
      while (end < source.length && /[_0-9A-Za-z]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    index += 1;
  }
  return tokens;
}

class Parser {
  private tokens: Array<{ kind: string; value: string }>;
  private pos = 0;
  constructor(source: string) { this.tokens = tokenize(source); }
  private peek(): { kind: string; value: string } { return this.tokens[this.pos] ?? { kind: 'eof', value: '' }; }
  private next(): { kind: string; value: string } { const token = this.peek(); this.pos += 1; return token; }
  private expect(kind: string): string {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, found ${token.kind} ${token.value}`);
    return token.value;
  }
  private skip(kind: string): boolean {
    if (this.peek().kind === kind) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === '{') {
        operations.push({ type: 'query', name: null, variableNames: [], selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        const name = this.peek().kind === 'name' ? this.next().value : null;
        const variableNames: string[] = [];
        if (this.skip('(')) {
          while (this.peek().kind !== ')') {
            this.expect('$');
            variableNames.push(this.expect('name'));
            this.expect(':');
            this.parseType();
            if (this.skip('=')) this.parseValue();
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({ type, name, variableNames, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragmentName = this.expect('name');
        this.expect('name'); // 'on'
        this.expect('name'); // type condition
        this.skipDirectives();
        fragments.set(fragmentName, this.parseSelectionSet());
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skip('[')) { this.parseType(); this.expect(']'); }
    else this.expect('name');
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.skip('@')) {
      this.expect('name');
      if (this.skip('(')) {
        let depth = 1;
        while (depth > 0 && this.peek().kind !== 'eof') {
          const token = this.next();
          if (token.kind === '(') depth += 1;
          else if (token.kind === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name');
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.next().value });
          this.skipDirectives();
        }
        continue;
      }
      let name = this.expect('name');
      let alias: string | null = null;
      if (this.skip(':')) { alias = name; name = this.expect('name'); }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.skip('(')) {
        while (this.peek().kind !== ')') {
          const argName = this.expect('name');
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      this.skipDirectives();
      const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === '$') { this.next(); return { kind: 'variable', name: this.expect('name') }; }
    if (token.kind === 'number') {
      this.next();
      return token.value.includes('.') || /[eE]/.test(token.value)
        ? { kind: 'float', value: Number(token.value) }
        : { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'string') { this.next(); return { kind: 'string', value: token.value }; }
    if (token.kind === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (this.peek().kind !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.kind === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek().kind !== '}') {
        const fieldName = this.expect('name');
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

// ------------------------------------------------------------------ execution

type Variables = Record<string, unknown>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

type Node =
  | { __typename: 'User' }
  | { __typename: 'Repository'; repo: RepoRec }
  | { __typename: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __typename: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __typename: 'Ref'; repo: RepoRec; name: string }
  | { __typename: 'Commit'; repo: RepoRec; oid: string }
  | { __typename: 'IssueComment'; repo: RepoRec; issue: IssueRec; commentId: number; body: string }
  | { __typename: 'Label'; name: string; color: string; description: string }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'Generic'; type: string; fields: Record<string, unknown> };

interface Connection<T> { __typename: string; items: T[]; total: number; pageInfo: PageInfoData }
interface PageInfoData { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }

function cursorOf(index: number): string { return Buffer.from(`cursor:${index}`, 'utf8').toString('base64'); }
function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : -1;
  } catch { return -1; }
}

function paginate<T>(items: readonly T[], args: Record<string, unknown>, typename: string): Connection<T> {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    __typename: typename,
    items: slice as T[],
    total: items.length,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? cursorOf(start) : null,
      endCursor: slice.length ? cursorOf(endIndex) : null,
    },
  };
}

export class GraphQLExecutor {
  private forge: Forge;
  private errors: Array<{ message: string }> = [];
  private fragments: Map<string, SelectionNode[]> = new Map();

  constructor(forge: Forge) { this.forge = forge; }

  execute(body: unknown): unknown {
    if (Array.isArray(body)) return body.map((entry) => this.executeOne(entry));
    return this.executeOne(body);
  }

  private executeOne(body: unknown): { data: unknown; errors?: Array<{ message: string }> } {
    this.errors = [];
    if (typeof body !== 'object' || body === null) return { data: null, errors: [{ message: 'request body must be an object' }] };
    const record = body as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Variables;
    let document: DocumentNode;
    try {
      document = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    this.fragments = document.fragments;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
    if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = this.executeSet(rootType, null, operation.selectionSet, variables);
    return this.errors.length ? { data, errors: this.errors } : { data };
  }

  private executeSet(typeName: string, source: unknown, selections: SelectionNode[], variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) this.applySelection(typeName, source, selection, variables, out);
    return out;
  }

  private applySelection(typeName: string, source: unknown, selection: SelectionNode, variables: Variables, out: Record<string, unknown>): void {
    if (selection.kind === 'inlineFragment') {
      const actual = (source as Node | null)?.__typename ?? typeName;
      if (selection.typeCondition === null || selection.typeCondition === actual || selection.typeCondition === 'Node') {
        for (const inner of selection.selectionSet) this.applySelection(actual, source, inner, variables, out);
      }
      return;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = this.fragments.get(selection.name);
      if (fragment) for (const inner of fragment) this.applySelection(typeName, source, inner, variables, out);
      return;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') { out[responseKey] = (source as Node | null)?.__typename ?? typeName; return; }
    const knownFields = TYPE_FIELDS[typeName];
    if (knownFields && !knownFields.includes(selection.name) && !selection.name.startsWith('__')) {
      this.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      return;
    }
    const args = argsOf(selection, variables);
    const raw = this.resolve(typeName, source, selection.name, args);
    out[responseKey] = this.complete(raw, selection, variables);
  }

  private complete(raw: unknown, field: FieldNode, variables: Variables): unknown {
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) return raw.map((item) => this.complete(item, field, variables));
    if (typeof raw === 'object') {
      const node = raw as Node | Connection<unknown>;
      if ('items' in node && 'pageInfo' in node) {
        // A connection: resolve through a synthetic object view.
        const connection = node as Connection<unknown>;
        const view: Record<string, unknown> = {};
        if (field.selectionSet) {
          for (const selection of field.selectionSet) {
            if (selection.kind !== 'field') continue;
            const key = selection.alias ?? selection.name;
            if (selection.name === 'nodes') view[key] = connection.items.map((item) => this.complete(item, selection, variables));
            else if (selection.name === 'edges') view[key] = connection.items.map((item, index) => this.complete({ __typename: 'Generic', type: 'Edge', fields: { node: item, cursor: cursorOf(index) } }, selection, variables));
            else if (selection.name === 'pageInfo') view[key] = this.complete({ __typename: 'PageInfo', ...connection.pageInfo } as Node, selection, variables);
            else if (selection.name === 'totalCount') view[key] = connection.total;
            else view[key] = null;
          }
        }
        return view;
      }
      const typed = node as Node;
      if (typed.__typename === 'Generic') {
        const generic = typed as { fields: Record<string, unknown> };
        if (!field.selectionSet) return generic.fields;
        const view: Record<string, unknown> = {};
        for (const selection of field.selectionSet) {
          if (selection.kind !== 'field') continue;
          const key = selection.alias ?? selection.name;
          const inner = generic.fields[selection.name];
          view[key] = inner !== null && typeof inner === 'object' && (inner as Node).__typename
            ? this.complete(inner, selection, variables)
            : inner ?? null;
        }
        return view;
      }
      if (!field.selectionSet) {
        // An object selected without subfields: hand back its id-ish view.
        return this.executeSet(typed.__typename, typed, [{ kind: 'field', name: 'id', alias: null, args: [], selectionSet: null }], variables);
      }
      return this.executeSet(typed.__typename, typed, field.selectionSet, variables);
    }
    return raw;
  }

  // ------------------------------------------------------------ field resolvers

  private repoByGlobalId(id: unknown): RepoRec | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    const match = /^R:(\d+)$/.exec(decoded);
    if (!match) return null;
    const wanted = Number(match[1]);
    for (const repo of this.forge.repos.values()) if (repo.id === wanted) return repo;
    return null;
  }

  private resolve(typeName: string, source: unknown, field: string, args: Record<string, unknown>): unknown {
    switch (typeName) {
      case 'Query': return this.resolveQuery(field, args);
      case 'Mutation': return this.resolveMutation(field, args);
      case 'User': return this.resolveUser(field);
      case 'Repository': return this.resolveRepository((source as { repo: RepoRec }).repo, field, args);
      case 'Issue': { const node = source as { repo: RepoRec; issue: IssueRec }; return this.resolveIssue(node.repo, node.issue, field); }
      case 'PullRequest': { const node = source as { repo: RepoRec; pull: PullRec }; return this.resolvePull(node.repo, node.pull, field, args); }
      case 'Ref': { const node = source as { repo: RepoRec; name: string }; return field === 'name' ? node.name : field === 'prefix' ? 'refs/heads/' : field === 'target' ? ({ __typename: 'Commit', repo: node.repo, oid: this.forge.branchTip(node.repo, node.name) ?? '' } as Node) : null; }
      case 'Commit': { const node = source as { oid: string }; return field === 'oid' ? node.oid : null; }
      case 'IssueComment': { const node = source as { repo: RepoRec; issue: IssueRec; commentId: number; body: string }; return this.resolveComment(node, field); }
      case 'Label': { const node = source as { name: string; color: string; description: string }; return (node as unknown as Record<string, unknown>)[field] ?? null; }
      case '__Type': { const node = source as { name: string }; return this.resolveType(node.name, field); }
      case '__Field': case '__EnumValue': { const node = source as { name: string }; return field === 'name' ? node.name : field === 'isDeprecated' ? false : null; }
      case 'PageInfo': { const node = source as unknown as Record<string, unknown>; return node[field] ?? null; }
      case 'Generic': { const node = source as { fields: Record<string, unknown> }; return node.fields[field] ?? null; }
      default: return null;
    }
  }

  private resolveQuery(field: string, args: Record<string, unknown>): unknown {
    if (field === 'viewer') return { __typename: 'User' } as Node;
    if (field === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = this.forge.getRepo(owner, name);
      return repo ? ({ __typename: 'Repository', repo } as Node) : null;
    }
    if (field === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      const repoMatch = /^R:(\d+)$/.exec(decoded);
      if (repoMatch) {
        const repo = this.repoByGlobalId(id);
        return repo ? ({ __typename: 'Repository', repo } as Node) : null;
      }
      const issueMatch = /^I:(\d+):(\d+)$/.exec(decoded);
      if (issueMatch) {
        for (const repo of this.forge.repos.values()) {
          if (repo.id !== Number(issueMatch[1])) continue;
          const issue = repo.issues.get(Number(issueMatch[2]));
          return issue ? ({ __typename: 'Issue', repo, issue } as Node) : null;
        }
        return null;
      }
      const pullMatch = /^P:(\d+):(\d+)$/.exec(decoded);
      if (pullMatch) {
        for (const repo of this.forge.repos.values()) {
          if (repo.id !== Number(pullMatch[1])) continue;
          const pull = repo.pulls.get(Number(pullMatch[2]));
          return pull ? ({ __typename: 'PullRequest', repo, pull } as Node) : null;
        }
        return null;
      }
      return null;
    }
    if (field === '__type') return { __typename: '__Type', name: typeof args.name === 'string' ? args.name : '' } as Node;
    if (field === '__schema') return { __typename: 'Generic', type: '__Schema', fields: {} } as Node;
    return null;
  }

  private resolveMutation(field: string, args: Record<string, unknown>): unknown {
    const input = (typeof args.input === 'object' && args.input !== null ? args.input : {}) as Record<string, unknown>;
    const payload = (fields: Record<string, unknown>): Node => ({ __typename: 'Generic', type: 'Payload', fields: { ...fields, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null } });
    if (field === 'createIssue') {
      const repo = this.repoByGlobalId(input.repositoryId);
      if (!repo) { this.errors.push({ message: 'repository not found for createIssue' }); return null; }
      const issue = this.forge.createIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
      return payload({ issue: { __typename: 'Issue', repo, issue } as Node });
    }
    if (field === 'closeIssue') {
      const located = this.locateIssue(input.issueId);
      if (!located) { this.errors.push({ message: 'issue not found for closeIssue' }); return null; }
      located.issue.state = 'closed';
      return payload({ issue: { __typename: 'Issue', repo: located.repo, issue: located.issue } as Node });
    }
    if (field === 'createPullRequest') {
      const repo = this.repoByGlobalId(input.repositoryId);
      if (!repo) { this.errors.push({ message: 'repository not found for createPullRequest' }); return null; }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const pull = this.forge.createPull(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', head, base);
      return payload({ pullRequest: { __typename: 'PullRequest', repo, pull } as Node });
    }
    if (field === 'mergePullRequest') {
      const located = this.locatePull(input.pullRequestId);
      if (!located) { this.errors.push({ message: 'pull request not found for mergePullRequest' }); return null; }
      this.forge.mergePull(located.repo, located.pull);
      return payload({ pullRequest: { __typename: 'PullRequest', repo: located.repo, pull: located.pull } as Node });
    }
    if (field === 'addComment') {
      const located = this.locateIssue(input.subjectId);
      if (!located) { this.errors.push({ message: 'subject not found for addComment' }); return null; }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = this.forge.addComment(located.repo, located.issue, body);
      const node: Node = { __typename: 'IssueComment', repo: located.repo, issue: located.issue, commentId: comment.id, body };
      return payload({ commentEdge: { __typename: 'Generic', type: 'CommentEdge', fields: { node, cursor: cursorOf(0) } } });
    }
    return null;
  }

  private locateIssue(idValue: unknown): { repo: RepoRec; issue: IssueRec } | null {
    if (typeof idValue !== 'string') return null;
    const match = /^I:(\d+):(\d+)$/.exec(decodeGlobalId(idValue));
    if (!match) return null;
    for (const repo of this.forge.repos.values()) {
      if (repo.id !== Number(match[1])) continue;
      const issue = repo.issues.get(Number(match[2]));
      if (issue) return { repo, issue };
    }
    return null;
  }

  private locatePull(idValue: unknown): { repo: RepoRec; pull: PullRec } | null {
    if (typeof idValue !== 'string') return null;
    const match = /^P:(\d+):(\d+)$/.exec(decodeGlobalId(idValue));
    if (!match) return null;
    for (const repo of this.forge.repos.values()) {
      if (repo.id !== Number(match[1])) continue;
      const pull = repo.pulls.get(Number(match[2]));
      if (pull) return { repo, pull };
    }
    return null;
  }

  private resolveUser(field: string): unknown {
    switch (field) {
      case 'login': return VIEWER.login;
      case 'id': return userGlobalId();
      case 'databaseId': return VIEWER.id;
      case 'name': return VIEWER.name;
      case 'email': return VIEWER.email;
      case 'isViewer': return true;
      case 'url': return `https://forge.invalid/${VIEWER.login}`;
      default: return null;
    }
  }

  private resolveRepository(repo: RepoRec, field: string, args: Record<string, unknown>): unknown {
    switch (field) {
      case 'id': return repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return { __typename: 'User' } as Node;
      case 'defaultBranchRef': {
        const tip = this.forge.branchTip(repo, repo.defaultBranch);
        return tip ? ({ __typename: 'Ref', repo, name: repo.defaultBranch } as Node) : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': case 'hasProjectsEnabled': case 'hasWikiEnabled': return true;
      case 'isPrivate': return repo.isPrivate;
      case 'description': return repo.description;
      case 'createdAt': return this.forge.isoOf(repo.seq);
      case 'updatedAt': return this.forge.nowIso();
      case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}`;
      case 'stargazerCount': case 'forkCount': return 0;
      case 'issue': {
        const issue = repo.issues.get(typeof args.number === 'number' ? args.number : -1);
        return issue ? ({ __typename: 'Issue', repo, issue } as Node) : null;
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? args.states.map((state) => String(state).toLowerCase()) : null;
        if (states) issues = issues.filter((issue) => states.includes(issue.state));
        const orderBy = (typeof args.orderBy === 'object' && args.orderBy !== null ? args.orderBy : {}) as Record<string, unknown>;
        const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
        issues.sort((a, b) => (direction === 'DESC' ? (b.seq - a.seq) || (b.number - a.number) : (a.seq - b.seq) || (a.number - b.number)));
        return paginate(issues.map((issue) => ({ __typename: 'Issue', repo, issue } as Node)), args, 'IssueConnection');
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(typeof args.number === 'number' ? args.number : -1);
        return pull ? ({ __typename: 'PullRequest', repo, pull } as Node) : null;
      }
      case 'pullRequests': {
        const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        return paginate(pulls.map((pull) => ({ __typename: 'PullRequest', repo, pull } as Node)), args, 'PullRequestConnection');
      }
      case 'labels': {
        const labels = [...repo.labels.values()].map((label) => ({ __typename: 'Label', ...label } as Node));
        return paginate(labels, args, 'LabelConnection');
      }
      default: return null;
    }
  }

  private resolveIssue(repo: RepoRec, issue: IssueRec, field: string): unknown {
    switch (field) {
      case 'id': return issueGlobalId(repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'closed': return issue.state === 'closed';
      case 'author': return { __typename: 'User' } as Node;
      case 'repository': return { __typename: 'Repository', repo } as Node;
      case 'createdAt': return this.forge.isoOf(issue.seq);
      case 'updatedAt': return this.forge.isoOf(issue.seq);
      case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'labels': {
        const labels = issue.labels.map((name) => {
          const label = repo.labels.get(name);
          return { __typename: 'Label', name, color: label?.color ?? 'ededed', description: label?.description ?? '' } as Node;
        });
        return paginate(labels, {}, 'LabelConnection');
      }
      case 'comments': {
        const comments = issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, commentId: comment.id, body: comment.body } as Node));
        return paginate(comments, {}, 'IssueCommentConnection');
      }
      default: return null;
    }
  }

  private resolvePull(repo: RepoRec, pull: PullRec, field: string, args: Record<string, unknown>): unknown {
    switch (field) {
      case 'id': return pullGlobalId(repo, pull);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.merged ? this.forge.isoOf(pull.mergedSeq) : null;
      case 'mergeable': {
        if (pull.merged) return 'UNKNOWN';
        return this.forge.analyzeMerge(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRef': return { __typename: 'Ref', repo, name: pull.headRef } as Node;
      case 'baseRef': return { __typename: 'Ref', repo, name: pull.baseRef } as Node;
      case 'author': return { __typename: 'User' } as Node;
      case 'repository': return { __typename: 'Repository', repo } as Node;
      case 'createdAt': return this.forge.isoOf(pull.seq);
      case 'updatedAt': return this.forge.isoOf(pull.seq);
      case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'mergeCommit': return pull.mergeCommitSha ? ({ __typename: 'Commit', repo, oid: pull.mergeCommitSha } as Node) : null;
      case 'files': {
        const files = this.forge.pullFiles(repo, pull).map((file) => ({
          __typename: 'Generic', type: 'PullRequestChangedFile',
          fields: { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' },
        } as unknown as Node));
        return paginate(files, args, 'PullRequestChangedFileConnection');
      }
      case 'additions': return this.forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
      case 'deletions': return this.forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
      case 'changedFiles': return this.forge.pullFiles(repo, pull).length;
      default: return null;
    }
  }

  private resolveComment(node: { repo: RepoRec; issue: IssueRec; commentId: number; body: string }, field: string): unknown {
    switch (field) {
      case 'id': return commentGlobalId(node.repo, node.issue, node.commentId);
      case 'body': return node.body;
      case 'author': return { __typename: 'User' } as Node;
      case 'createdAt': return this.forge.nowIso();
      default: return null;
    }
  }

  private resolveType(name: string, field: string): unknown {
    const enumValues = ENUM_VALUES[name];
    if (field === 'name') return name;
    if (field === 'kind') return enumValues ? 'ENUM' : OBJECT_TYPES.has(name) || name === 'Node' ? 'OBJECT' : 'OBJECT';
    if (field === 'description') return null;
    if (field === 'fields') {
      if (enumValues) return null;
      const fields = TYPE_FIELDS[name];
      if (!fields) return null;
      return fields.map((fieldName) => ({ __typename: '__Field', name: fieldName } as Node));
    }
    if (field === 'enumValues') {
      if (!enumValues) return null;
      return enumValues.map((value) => ({ __typename: '__EnumValue', name: value } as Node));
    }
    return null;
  }
}

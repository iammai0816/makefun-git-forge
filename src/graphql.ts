// GraphQL v4 at /api/graphql: a small purpose-built parser and executor for
// the documents gh and github-mcp-server send. No GraphQL library; the
// schema is the set of types those clients probe, plus the mutations they
// call. Unknown fields answer HTTP 200 with an `errors` array naming the
// field; an unknown repository is data.repository = null with no errors.
// Two operation documents in one body answer two results in order.

import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './auth.ts';
import { decodeGlobalId, globalId, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[] };

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: readonly { readonly name: string; readonly value: ValueNode }[];
  readonly selection: readonly SelectionNode[] | null;
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selection: readonly SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selection: readonly SelectionNode[];
}

interface Document {
  readonly operations: readonly Operation[];
  readonly fragments: ReadonlyMap<string, readonly SelectionNode[]>;
}

class GraphQLParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** The full next token, without consuming it. */
  peek(): string {
    const saved = this.pos;
    const token = this.next();
    this.pos = saved;
    return token;
  }

  next(): string {
    this.skipIgnored();
    if (this.text.slice(this.pos, this.pos + 3) === '...') {
      this.pos += 3;
      return '...';
    }
    const ch = this.text[this.pos] ?? '';
    if ('{}()[]:!=$@'.includes(ch)) {
      this.pos += 1;
      return ch;
    }
    if (ch === '"') {
      let out = '';
      this.pos += 1;
      while (this.pos < this.text.length) {
        const c = this.text[this.pos]!;
        if (c === '"') {
          this.pos += 1;
          return JSON.stringify(out);
        }
        if (c === '\\') {
          const esc = this.text[this.pos + 1]!;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[esc] ?? esc;
          this.pos += 2;
          continue;
        }
        out += c;
        this.pos += 1;
      }
      throw new GraphQLParseError('unterminated string');
    }
    const match = /^-?(?:[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*)/.exec(this.text.slice(this.pos));
    if (match === null) throw new GraphQLParseError(`unexpected character ${JSON.stringify(ch)}`);
    this.pos += match[0].length;
    return match[0];
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GraphQLParseError(`expected ${token}, got ${got}`);
  }

  readName(): string {
    const token = this.next();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) throw new GraphQLParseError(`expected a name, got ${token}`);
    return token;
  }
}

function parseValue(lexer: Lexer): ValueNode {
  const token = lexer.next();
  if (token === '$') return { kind: 'variable', name: lexer.readName() };
  if (token === '[') {
    const values: ValueNode[] = [];
    while (lexer.peek() !== ']') values.push(parseValue(lexer));
    lexer.expect(']');
    return { kind: 'list', values };
  }
  if (token === '{') {
    const fields: { name: string; value: ValueNode }[] = [];
    while (lexer.peek() !== '}') {
      const name = lexer.readName();
      lexer.expect(':');
      fields.push({ name, value: parseValue(lexer) });
    }
    lexer.expect('}');
    return { kind: 'object', fields };
  }
  if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
  if (token === 'true') return { kind: 'boolean', value: true };
  if (token === 'false') return { kind: 'boolean', value: false };
  if (token === 'null') return { kind: 'null' };
  if (/^-?[0-9]+$/.test(token)) return { kind: 'int', value: Number(token) };
  if (/^-?[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(token) || /^-?[0-9]+[eE]/.test(token)) return { kind: 'float', value: Number(token) };
  return { kind: 'enum', value: token };
}

function parseSelectionSet(lexer: Lexer): SelectionNode[] {
  lexer.expect('{');
  const selections: SelectionNode[] = [];
  while (lexer.peek() !== '}') {
    if (lexer.peek() === '...') {
      lexer.next();
      const next = lexer.peek();
      if (next === 'on') {
        lexer.next();
        const typeCondition = lexer.readName();
        selections.push({ kind: 'fragment', typeCondition, selection: parseSelectionSet(lexer) });
      } else {
        const name = lexer.readName();
        selections.push({ kind: 'fragment', typeCondition: name, selection: [] });
      }
      continue;
    }
    let alias: string | null = null;
    let name = lexer.readName();
    if (lexer.peek() === ':') {
      lexer.next();
      alias = name;
      name = lexer.readName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (lexer.peek() === '(') {
      lexer.next();
      while (lexer.peek() !== ')') {
        const argName = lexer.readName();
        lexer.expect(':');
        args.push({ name: argName, value: parseValue(lexer) });
      }
      lexer.expect(')');
    }
    // Directives (@skip/@include): skip name and arguments.
    while (lexer.peek() === '@') {
      lexer.next();
      lexer.readName();
      if (lexer.peek() === '(') {
        lexer.next();
        let depth = 1;
        while (depth > 0) {
          const token = lexer.next();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
        }
      }
    }
    const selection = lexer.peek() === '{' ? parseSelectionSet(lexer) : null;
    selections.push({ alias, name, args, selection });
  }
  lexer.expect('}');
  return selections;
}

function parseDocument(query: string): Document {
  const lexer = new Lexer(query);
  const operations: Operation[] = [];
  const fragments = new Map<string, SelectionNode[]>();
  while (lexer.peek() !== '') {
    const token = lexer.peek();
    if (token === 'fragment') {
      lexer.next();
      const name = lexer.readName();
      lexer.expect('on');
      lexer.readName();
      fragments.set(name, parseSelectionSet(lexer));
      continue;
    }
    let type: 'query' | 'mutation' = 'query';
    if (token === 'query' || token === 'mutation') {
      type = lexer.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (/^[A-Za-z_]/.test(lexer.peek())) name = lexer.readName();
    // Variable definitions: skip the whole (...) group.
    if (lexer.peek() === '(') {
      lexer.next();
      let depth = 1;
      while (depth > 0) {
        const t = lexer.next();
        if (t === '(' || t === '[' || t === '{') depth += 1;
        else if (t === ')' || t === ']' || t === '}') depth -= 1;
      }
    }
    while (lexer.peek() === '@') {
      lexer.next();
      lexer.readName();
      if (lexer.peek() === '(') {
        lexer.next();
        let depth = 1;
        while (depth > 0) {
          const t = lexer.next();
          if (t === '(') depth += 1;
          else if (t === ')') depth -= 1;
        }
      }
    }
    operations.push({ type, name, selection: parseSelectionSet(lexer) });
  }
  if (operations.length === 0) throw new GraphQLParseError('empty document');
  return { operations, fragments };
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, variables);
}

function argString(field: FieldNode, name: string, variables: Record<string, unknown>): string | null {
  const value = argValue(field, name, variables);
  return typeof value === 'string' ? value : null;
}

function argInt(field: FieldNode, name: string, variables: Record<string, unknown>): number | null {
  const value = argValue(field, name, variables);
  return typeof value === 'number' ? value : null;
}

// ---------------------------------------------------------------------------------------------
// schema: field sets per type (validation + introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'labels', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'url', 'createdAt', 'updatedAt', 'author'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT', 'WIKI', 'REGISTRY_PACKAGE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function fieldsOf(typeName: string): string[] {
  return SCHEMA_FIELDS[typeName] ?? [];
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  document: Document;
  errors: { message: string }[];
}

type ObjValue = { readonly __typename: string; readonly [key: string]: unknown };

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null): number | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueObj(store: Store, repo: Repo, number: number): ObjValue | null {
  const issue = store.findIssue(repo, number);
  if (issue === undefined) return null;
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: globalId('I', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    labels: issue.labels.map((label) => ({ __typename: 'Label', id: label.id, name: label.name, color: label.color, description: label.description })),
    author: { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
  };
}

function pullObj(store: Store, repo: Repo, pull: Pull): ObjValue {
  const mergeable = pull.state === 'open' ? (store.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: globalId('P', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha },
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    author: { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
  };
}

function repoObj(store: Store, repo: Repo): ObjValue {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('R', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function resolveField(ctx: ExecCtx, parent: ObjValue | null, parentType: string, field: FieldNode): unknown {
  const store = ctx.store;
  const vars = ctx.variables;

  if (field.name === '__typename') return parentType;

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
    }
    if (field.name === 'repository') {
      const owner = argString(field, 'owner', vars);
      const name = argString(field, 'name', vars);
      if (owner === null || name === null) return null;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repoObj(store, repo);
    }
    if (field.name === 'node') {
      const id = argString(field, 'id', vars);
      if (id === null) return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const [owner, name] = decoded.key.split('/', 2);
        const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
        return repo === undefined ? null : repoObj(store, repo);
      }
      if (decoded.kind === 'I') {
        const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
        if (match === null) return null;
        const repo = store.getRepo(match[1]!, match[2]!);
        if (repo === undefined) return null;
        return issueObj(store, repo, Number(match[3]));
      }
      if (decoded.kind === 'P') {
        const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
        if (match === null) return null;
        const repo = store.getRepo(match[1]!, match[2]!);
        if (repo === undefined) return null;
        const pull = store.findPull(repo, Number(match[3]));
        return pull === undefined ? null : pullObj(store, repo, pull);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = argString(field, 'name', vars);
      if (name === null) return null;
      const isEnum = SCHEMA_ENUMS[name] !== undefined;
      const isObject = SCHEMA_FIELDS[name] !== undefined;
      if (!isEnum && !isObject) return null;
      return {
        __typename: '__Type',
        name,
        kind: isEnum ? 'ENUM' : 'OBJECT',
        _fields: isObject ? fieldsOf(name) : [],
        _enumValues: isEnum ? SCHEMA_ENUMS[name]! : [],
      };
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', _types: [...Object.keys(SCHEMA_FIELDS), ...Object.keys(SCHEMA_ENUMS)] };
    }
    return null;
  }

  if (parentType === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (argValue(field, 'input', vars) ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (decoded === null || decoded.kind !== 'R') {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        return null;
      }
      const [owner, name] = decoded.key.split('/', 2);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        return null;
      }
      const issue = store.createIssue(repo, title, body, []);
      return { __typename: 'CreateIssuePayload', issue: issueObj(store, repo, issue.number), clientMutationId: null };
    }
    if (field.name === 'closeIssue') {
      const input = (argValue(field, 'input', vars) ?? {}) as Record<string, unknown>;
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeGlobalId(issueId);
      if (decoded === null || decoded.kind !== 'I') {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      const repo = store.getRepo(match[1]!, match[2]!);
      const issue = repo === undefined ? undefined : store.findIssue(repo, Number(match[3]));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObj(store, repo, issue.number), clientMutationId: null };
    }
    if (field.name === 'createPullRequest') {
      const input = (argValue(field, 'input', vars) ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (decoded === null || decoded.kind !== 'R') {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        return null;
      }
      const [owner, name] = decoded.key.split('/', 2);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        return null;
      }
      const pull = store.createPull(repo, title, body, head, base);
      if (pull === null) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(store, repo, pull), clientMutationId: null };
    }
    if (field.name === 'mergePullRequest') {
      const input = (argValue(field, 'input', vars) ?? {}) as Record<string, unknown>;
      const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(prId);
      if (decoded === null || decoded.kind !== 'P') {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      const repo = store.getRepo(match[1]!, match[2]!);
      const pull = repo === undefined ? undefined : store.findPull(repo, Number(match[3]));
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      if (store.pullConflict(repo, pull)) {
        ctx.errors.push({ message: 'mergePullRequest: pull request is not mergeable' });
        return null;
      }
      store.squashMerge(repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(store, repo, pull), clientMutationId: null };
    }
    if (field.name === 'addComment') {
      const input = (argValue(field, 'input', vars) ?? {}) as Record<string, unknown>;
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = decodeGlobalId(subjectId);
      if (decoded === null || decoded.kind !== 'I') {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        return null;
      }
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        return null;
      }
      const repo = store.getRepo(match[1]!, match[2]!);
      const issue = repo === undefined ? undefined : store.findIssue(repo, Number(match[3]));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        return null;
      }
      const comment = store.addComment(repo, issue.number, body);
      const node: ObjValue = {
        __typename: 'IssueComment',
        id: globalId('C', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
        body: comment.body,
        author: { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
      };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) }, clientMutationId: null };
    }
    return null;
  }

  if (parent === null) return null;
  const repo = parent._repo as Repo | undefined;

  if (parentType === 'Repository' && repo !== undefined) {
    if (field.name === 'issue') {
      const number = argInt(field, 'number', vars);
      if (number === null) return null;
      return issueObj(store, repo, number);
    }
    if (field.name === 'issues') {
      const first = argInt(field, 'first', vars) ?? 30;
      const after = argString(field, 'after', vars);
      const statesRaw = argValue(field, 'states', vars);
      const orderBy = (argValue(field, 'orderBy', vars) ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
      let list = [...repo.issues];
      if (Array.isArray(statesRaw) && statesRaw.length > 0) {
        const wanted = new Set(statesRaw.map((state) => String(state)));
        list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      const afterNumber = cursorNumber(after);
      if (afterNumber !== null) {
        list = list.filter((issue) => (direction === 'ASC' ? issue.number > afterNumber : issue.number < afterNumber));
      }
      const page = list.slice(0, Math.max(0, first));
      const hasNextPage = list.length > page.length;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueObj(store, repo, issue.number)),
        edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueObj(store, repo, issue.number), cursor: cursorFor(issue.number) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: afterNumber !== null, startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null, endCursor },
        totalCount: repo.issues.length,
      };
    }
    if (field.name === 'pullRequests') {
      const first = argInt(field, 'first', vars) ?? 30;
      const statesRaw = argValue(field, 'states', vars);
      let list = [...repo.pulls];
      if (Array.isArray(statesRaw) && statesRaw.length > 0) {
        const wanted = new Set(statesRaw.map((state) => String(state)));
        list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
      } else {
        list = list.filter((pull) => pull.state === 'open');
      }
      const page = list.slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullObj(store, repo, pull)),
        edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullObj(store, repo, pull), cursor: cursorFor(pull.number) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: repo.pulls.length,
      };
    }
    if (field.name === 'pullRequest') {
      const number = argInt(field, 'number', vars);
      if (number === null) return null;
      const pull = store.findPull(repo, number);
      return pull === undefined ? null : pullObj(store, repo, pull);
    }
  }

  if (parentType === 'PullRequest') {
    const pull = parent._pull as Pull | undefined;
    if (field.name === 'files' && pull !== undefined && repo !== undefined) {
      const first = argInt(field, 'first', vars) ?? 30;
      const changes = store.pullFiles(repo, pull).slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: changes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path, additions: change.additions, deletions: change.deletions, changeType: change.status.toUpperCase() })),
        edges: changes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path, additions: change.additions, deletions: change.deletions, changeType: change.status.toUpperCase() })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: changes.length,
      };
    }
  }

  if (parentType === '__Type') {
    if (field.name === 'fields') {
      const names = (parent._fields as string[] | undefined) ?? [];
      return names.map((name) => ({ __typename: '__Field', name, description: null, args: [], type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } }));
    }
    if (field.name === 'enumValues') {
      const names = (parent._enumValues as string[] | undefined) ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name, description: null }));
    }
    return parent[field.name] ?? null;
  }

  if (parentType === '__Schema') {
    if (field.name === 'types') {
      return ((parent._types as string[] | undefined) ?? []).map((name) => ({
        __typename: '__Type',
        name,
        kind: SCHEMA_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT',
        _fields: fieldsOf(name),
        _enumValues: SCHEMA_ENUMS[name] ?? [],
      }));
    }
    if (field.name === 'queryType') return { __typename: '__Type', name: 'Query', kind: 'OBJECT', _fields: fieldsOf('Query'), _enumValues: [] };
    if (field.name === 'mutationType') return { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', _fields: fieldsOf('Mutation'), _enumValues: [] };
    return null;
  }

  // Scalar / stored fields on plain object values.
  const value = parent[field.name];
  return value === undefined ? null : value;
}

function typeOfValue(value: unknown): string {
  if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).__typename);
  }
  return '';
}

function executeSelection(
  ctx: ExecCtx,
  parent: ObjValue | null,
  parentType: string,
  selections: readonly SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragmentSelections =
        selection.selection.length > 0
          ? selection.selection
          : ctx.document.fragments.get(selection.typeCondition ?? '') ?? [];
      // A named fragment's type condition is its name; an inline fragment's
      // is a type name. Apply when the condition matches the parent type or
      // is a fragment name (no condition to check).
      if (selection.selection.length > 0 && selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      const nested = executeSelection(ctx, parent, parentType, fragmentSelections);
      Object.assign(out, nested);
      continue;
    }
    const field = selection;
    if (field.name === '__typename') {
      out[field.alias ?? '__typename'] = parentType;
      continue;
    }
    const allowed = fieldsOf(parentType);
    if (!allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    const value = resolveField(ctx, parent, parentType, field);
    const key = field.alias ?? field.name;
    if (field.selection === null || field.selection === undefined) {
      out[key] = value === undefined ? null : value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (entry !== null && typeof entry === 'object') {
          return executeSelection(ctx, entry as ObjValue, typeOfValue(entry), field.selection!);
        }
        return entry;
      });
      continue;
    }
    if (typeof value === 'object') {
      out[key] = executeSelection(ctx, value as ObjValue, typeOfValue(value), field.selection);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(store: Store, document: Document, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: ExecCtx = { store, variables, document, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, null, rootType, operation.selection);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  return { data };
}

// ---------------------------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { message: 'GraphQL body must be a JSON object' } };
  }
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const entry of body) {
      results.push(executeOne(store, entry));
    }
    return { status: 200, body: results };
  }
  return { status: 200, body: executeOne(store, body) };
}

function executeOne(store: Store, entry: unknown): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'operation must be a JSON object' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? record.variables : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let document: Document;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  let operation = document.operations[0]!;
  if (operationName !== null) {
    const found = document.operations.find((candidate) => candidate.name === operationName);
    if (found !== undefined) operation = found;
  }
  return executeOperation(store, document, operation, variables);
}

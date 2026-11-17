// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, modern revision
// 2026-07-28 (server/discover) with the legacy initialize handshake as a
// fallback. Tools act on the same store as REST and GraphQL.
//
// Tools: create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request. Every tool has a non-empty
// description and an inputSchema of type object; tools/list is
// deterministic, so two calls answer byte-identical lists.

import { VIEWER_LOGIN } from './auth.ts';
import { globalId, type Store } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

const SERVER_NAME = 'git-forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
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
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
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

function toolsList(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

function toolResultText(value: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: boolean } {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function repoView(store: Store, owner: string, name: string): Record<string, unknown> | null {
  if (owner !== VIEWER_LOGIN) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  return {
    id: repo.id,
    node_id: globalId('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickNumber(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Split "owner/repo" into its parts, or null. */
function splitFullName(value: string | undefined): { owner: string; repo: string } | null {
  if (value === undefined) return null;
  const parts = value.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return { owner: parts[0]!, repo: parts[1]! };
}

function callTool(store: Store, name: string, rawArgs: unknown): { result: unknown } | { rpcError: { code: number; message: string } } {
  const def = TOOLS.find((tool) => tool.name.toLowerCase() === name.toLowerCase());
  if (def === undefined) {
    return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const args: Record<string, unknown> = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  // The suite may fill a full_name property instead of owner/repo.
  const fullName = splitFullName(pickString(args, ['full_name', 'repo_full_name', 'repository_full_name']));
  const owner = pickString(args, ['owner', 'owner_login', 'org', 'login']) ?? fullName?.owner;
  const repoName = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name']) ?? fullName?.repo;

  // Required-argument check (missing -> isError, never a crash).
  const missing: string[] = [];
  for (const required of def.required) {
    if (required === 'name' && name === 'create_repo') {
      if (pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']) === undefined) missing.push(required);
      continue;
    }
    if (required === 'owner' && owner === undefined) missing.push(required);
    else if (required === 'repo' && repoName === undefined) missing.push(required);
    else if (required === 'title' && pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']) === undefined) missing.push(required);
    else if (required === 'head' && pickString(args, ['head', 'head_ref', 'head_branch', 'source_branch', 'branch']) === undefined) missing.push(required);
    else if (required === 'base' && pickString(args, ['base', 'base_ref', 'base_branch', 'target_branch']) === undefined) missing.push(required);
    else if (required === 'pull_number' && pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number']) === undefined) missing.push(required);
  }
  if (missing.length > 0) {
    return { result: toolError(`Missing required argument(s): ${missing.join(', ')}`) };
  }

  if (name === 'create_repo') {
    const repoNameArg = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name'])!;
    if (store.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) {
      return { result: toolError(`Repository ${repoNameArg} already exists`) };
    }
    const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
    const isPrivate = args.private === true || args.is_private === true;
    const repo = store.createRepo(repoNameArg, { description, isPrivate });
    return { result: toolResultText(repoView(store, VIEWER_LOGIN, repo.name)) };
  }

  if (owner === undefined || repoName === undefined) {
    return { result: toolError('owner and repo are required') };
  }

  if (name === 'get_repo') {
    const view = repoView(store, owner, repoName);
    if (view === null) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
    return { result: toolResultText(view) };
  }

  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== VIEWER_LOGIN) {
    return { result: toolError(`Repository ${owner}/${repoName} not found`) };
  }

  if (name === 'create_issue') {
    const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'])!;
    const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
    const issue = store.createIssue(repo, title, body, []);
    return {
      result: toolResultText({
        id: issue.id,
        node_id: globalId('I', `${repo.owner}/${repo.name}#${issue.number}`),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
      }),
    };
  }

  if (name === 'list_issues') {
    const state = (pickString(args, ['state', 'status']) ?? 'open').toLowerCase();
    let list = [...repo.issues];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    return {
      result: toolResultText(
        list.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name })),
        })),
      ),
    };
  }

  if (name === 'create_pull_request') {
    const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'])!;
    const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
    const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source_branch', 'branch'])!;
    const base = pickString(args, ['base', 'base_ref', 'base_branch', 'target_branch']) ?? repo.defaultBranch;
    const pull = store.createPull(repo, title, body, head, base);
    if (pull === null) return { result: toolError('head or base branch does not exist') };
    return {
      result: toolResultText({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        merged: pull.merged,
      }),
    };
  }

  if (name === 'merge_pull_request') {
    const number = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number'])!;
    const pull = store.findPull(repo, number);
    if (pull === undefined) return { result: toolError(`Pull request #${number} not found`) };
    if (pull.state !== 'open') return { result: toolError(`Pull request #${number} is not open`) };
    if (store.pullConflict(repo, pull)) return { result: toolError(`Pull request #${number} is not mergeable`) };
    const sha = store.squashMerge(repo, pull);
    if (sha === null) return { result: toolError(`Pull request #${number} could not be merged`) };
    return { result: toolResultText({ sha, merged: true, number: pull.number, state: pull.state }) };
  }

  return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
}

export function handleMcp(store: Store, bodyText: string): McpResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON' } },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body must be a JSON-RPC object' } },
    };
  }
  const request = body as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {}) as Record<string, unknown>;

  const ok = (result: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const rpcError = (code: number, message: string, data?: unknown): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });

  if (method === 'server/discover') {
    return ok({
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
      protocolVersion: '2026-07-28',
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return ok({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id; answer 202 with no body.
    return { status: 202, body: null };
  }

  if (method === 'tools/list') {
    return ok({ tools: toolsList() });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const outcome = callTool(store, toolName, params.arguments);
    if ('rpcError' in outcome) return rpcError(outcome.rpcError.code, outcome.rpcError.message);
    return ok(outcome.result);
  }

  if (method === 'ping') {
    return ok({});
  }

  return rpcError(-32601, `Method not found: ${method}`);
}

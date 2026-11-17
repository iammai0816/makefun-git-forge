// REST v3 under /api/v3: repositories, contents, git refs, branches,
// commits, labels, issues, comments and pull requests. Every reply is
// application/json with a non-empty X-GitHub-Request-Id; errors are JSON
// with a string message.

import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './auth.ts';
import {
  hashObject,
  parseCommit,
  parseTree,
  storeObject,
  ZERO_OID,
} from './git-objects.ts';
import {
  globalId,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const FIXED_DATE = '2026-01-01T00:00:00Z';

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('C', `label:${label.id}`),
    name: label.name,
    color: label.color,
    description: label.description,
    url: `/api/v3/labels/${label.id}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('P', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: true,
    mergeable_state: 'clean',
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE };
    const epoch = Number(match[3]);
    return { name: match[1]!, email: match[2]!, date: new Date(epoch * 1000).toISOString() };
  };
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN },
    committer: { login: VIEWER_LOGIN },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  host: string;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
}

function repoOf(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

function linkHeader(ctx: Ctx, path: string, page: number, perPage: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const url = new URL(`http://${ctx.host}${path}`);
  url.searchParams.set('page', String(page + 1));
  url.searchParams.set('per_page', String(perPage));
  return { link: `<${url.toString()}>; rel="next"` };
}

function bodyObject(ctx: Ctx): Record<string, unknown> {
  return (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function commitFile(
  ctx: Ctx,
  repo: Repo,
  branch: string,
  path: string,
  contentBase64: string,
  message: string,
  expectedSha: string | undefined,
  isDelete: boolean,
): RestResult {
  const clean = contentBase64.replace(/[\r\n\t ]+/g, '');
  let content: Buffer;
  try {
    content = Buffer.from(clean, 'base64');
  } catch {
    return err(400, 'content is not valid base64');
  }
  let tip = ctx.store.branchTip(repo, branch);
  if (tip === undefined) {
    if (branch !== repo.defaultBranch) {
      // A new branch starts from the default branch tip.
      tip = ctx.store.branchTip(repo, repo.defaultBranch);
    }
    if (tip === undefined) {
      // Unborn repository: the first commit has no parents.
      if (isDelete) return err(404, 'Not Found');
      const blobSha = storeObject(repo.objects, 'blob', content);
      const files = new Map([[path, { oid: blobSha, mode: '100644' }]]);
      const commitSha = ctx.store.makeCommit(repo, { files, parents: [], message: message || 'Create file' });
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      return ok(
        {
          content: { sha: blobSha, name: path.split('/').pop() ?? path, path, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        },
        201,
      );
    }
  }
  const files = ctx.store.filesOfCommit(repo, tip);
  const existing = files.get(path);
  if (isDelete) {
    if (existing === undefined) return err(404, 'Not Found');
    files.delete(path);
    const commitSha = ctx.store.makeCommit(repo, { files, parents: [tip], message: message || 'Delete file' });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return ok({ commit: { sha: commitSha, message } }, 200);
  }
  if (expectedSha !== undefined) {
    if (existing === undefined) return err(404, 'Not Found');
    if (existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
  }
  const blobSha = storeObject(repo.objects, 'blob', content);
  files.set(path, { oid: blobSha, mode: '100644' });
  const commitSha = ctx.store.makeCommit(repo, { files, parents: [tip], message: message || 'Update file' });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  const status = existing === undefined ? 201 : 200;
  return ok(
    {
      content: { sha: blobSha, name: path.split('/').pop() ?? path, path, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    },
    status,
  );
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function handleRest(ctx: Ctx): RestResult {
  const seg = ctx.segments;
  const method = ctx.method;

  // GET /api/v3/ — the API root.
  if (seg.length === 0 && method === 'GET') {
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return ok({ installed_version: '1.0.0' });
  }
  // GET /api/v3/user — the token owner.
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
  }
  // GET/POST /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(ctx);
      const repos = ctx.store.listRepos();
      const { items, hasNext } = paginate(repos, page, perPage);
      return ok(items.map(repoJson), 200, linkHeader(ctx, '/api/v3/user/repos', page, perPage, hasNext));
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const name = asString(body.name).trim();
      if (name === '') return err(422, 'name is required');
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return err(422, `Repository ${name} already exists`);
      }
      const repo = ctx.store.createRepo(name, {
        description: asString(body.description),
        isPrivate: body.private === true,
      });
      return ok(repoJson(repo), 201);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1]!);
    const name = decodeURIComponent(seg[2]!);
    const repo = repoOf(ctx, owner, name);
    if (repo === null) return err(404, 'Not Found');
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        const body = bodyObject(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = bodyObject(ctx);
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha.toLowerCase());
        return ok({ ref, object: { sha: sha.toLowerCase() } }, 201);
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
          return ok(list);
        }
        const refName = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
        const sha = repo.refs.get(refName);
        if (sha === undefined) return err(404, 'Not Found');
        return ok({ ref: refName, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        return ok(list);
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = decodeURIComponent(rest[1]!);
        const sha = ctx.store.branchTip(repo, branch);
        if (sha === undefined) return err(404, 'Not Found');
        return ok({ name: branch, commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 2) {
        const sha = decodeURIComponent(rest[1]!);
        const commit = commitJson(repo, sha);
        if (commit === null) return err(404, 'Not Found');
        return ok(commit);
      }
      const ref = ctx.query.get('sha');
      const tip = ref === null ? ctx.store.branchTip(repo, repo.defaultBranch) : (ctx.store.branchTip(repo, ref) ?? (repo.objects.has(ref) ? ref : undefined));
      if (tip === undefined) return ok([]);
      const commits = ctx.store.commitsFrom(repo, tip).map((sha) => commitJson(repo, sha)).filter((entry): entry is Record<string, unknown> => entry !== null);
      return ok(commits);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'PUT' || method === 'DELETE') {
        const body = bodyObject(ctx);
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        if (method === 'PUT') {
          return commitFile(ctx, repo, branch, path, asString(body.content), asString(body.message), typeof body.sha === 'string' ? body.sha : undefined, false);
        }
        return commitFile(ctx, repo, branch, path, '', asString(body.message), undefined, true);
      }
      if (method === 'GET') {
        const ref = ctx.query.get('ref');
        const tip = ref === null ? ctx.store.branchTip(repo, repo.defaultBranch) : (ctx.store.branchTip(repo, ref) ?? (repo.objects.has(ref) ? ref : undefined));
        if (tip === undefined) return err(404, 'Not Found');
        const found = ctx.store.readPath(repo, tip, path);
        if (found === null) return err(404, 'Not Found');
        if (found.kind === 'blob') {
          const blob = repo.objects.get(found.oid)!;
          return ok({
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: blob.data.toString('base64'),
            sha: found.oid,
          });
        }
        const entries = (found.entries ?? []).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
          size: 0,
        }));
        return ok(entries);
      }
      return err(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const body = bodyObject(ctx);
        const labelName = asString(body.name).trim();
        if (labelName === '') return err(422, 'name is required');
        const label = ctx.store.createLabel(repo, labelName, asString(body.color) || 'ededed', asString(body.description));
        return ok(labelJson(label), 201);
      }
      if (method === 'GET' && rest.length === 1) {
        return ok([...repo.labels.values()].map(labelJson));
      }
      return err(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = asString(body.title).trim();
          if (title === '') return err(422, 'title is required');
          const wanted: string[] = Array.isArray(body.labels)
            ? (body.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : asString((entry as Record<string, unknown>)?.name)))
            : [];
          const missing = wanted.filter((labelName) => !repo.labels.has(labelName));
          if (missing.length > 0) return err(422, `Label does not exist: ${missing[0]}`);
          const issue = ctx.store.createIssue(repo, title, asString(body.body), wanted);
          return ok(issueJson(repo, issue), 201);
        }
        if (method === 'GET') {
          const { page, perPage } = pageParams(ctx);
          const state = (ctx.query.get('state') ?? 'open').toLowerCase();
          const sort = (ctx.query.get('sort') ?? 'created').toLowerCase();
          const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const { items, hasNext } = paginate(list, page, perPage);
          return ok(items.map((issue) => issueJson(repo, issue)), 200, linkHeader(ctx, `/api/v3/repos/${owner}/${name}/issues`, page, perPage, hasNext));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const issue = ctx.store.findIssue(repo, number);
      if (rest.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(issueJson(repo, issue));
        if (method === 'PATCH') {
          const body = bodyObject(ctx);
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return ok(issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const comment = ctx.store.addComment(repo, number, asString(body.body));
          return ok({ id: comment.id, node_id: globalId('C', `${repo.owner}/${repo.name}#${number}:${comment.id}`), body: comment.body }, 201);
        }
        if (method === 'GET') {
          const list = (repo.comments.get(number) ?? []).map((comment) => ({
            id: comment.id,
            node_id: globalId('C', `${repo.owner}/${repo.name}#${number}:${comment.id}`),
            body: comment.body,
          }));
          return ok(list);
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = asString(body.title).trim();
          const head = asString(body.head).trim();
          const base = asString(body.base).trim() || repo.defaultBranch;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
          if (existing !== undefined) return err(422, 'A pull request already exists for this branch');
          const pull = ctx.store.createPull(repo, title, asString(body.body), head, base);
          if (pull === null) return err(422, 'head or base branch does not exist');
          return ok(pullJson(repo, pull), 201);
        }
        if (method === 'GET') {
          const { page, perPage } = pageParams(ctx);
          const state = (ctx.query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          const { items, hasNext } = paginate(list, page, perPage);
          return ok(items.map((pull) => pullJson(repo, pull)), 200, linkHeader(ctx, `/api/v3/repos/${owner}/${name}/pulls`, page, perPage, hasNext));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const pull = ctx.store.findPull(repo, number);
      if (rest.length === 2) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        const files = ctx.store.pullFiles(repo, pull).map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          sha: change.newOid ?? change.oldOid ?? ZERO_OID,
        }));
        return ok(files);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        const sha = ctx.store.squashMerge(repo, pull);
        if (sha === null) return err(405, 'Pull request is not mergeable');
        return ok({ sha, merged: true, message: `Pull request #${pull.number} merged` }, 200);
      }
      return err(404, 'Not Found');
    }
  }

  return err(404, 'Not Found');
}

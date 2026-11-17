// The in-memory store: repositories, git objects and refs, issues, pull
// requests, labels and comments. One process, one store; every trial is a
// fresh pod, so in-memory is enough. Deterministic: ids come from counters
// (never random, never the wall clock); server-created commit timestamps
// come from a fixed epoch plus a counter, so the same request sequence
// always builds the same state.

import { VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './auth.ts';
import {
  buildCommitBytes,
  buildTreeFromPaths,
  collectReachable,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  storeObject,
  ZERO_OID,
  type GitObject,
} from './git-objects.ts';

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
}

export interface Comment {
  readonly id: number;
  readonly body: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  readonly comments: Map<number, Comment[]>;
  nextNumber: number;
}

/** A changed path between two trees. */
export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
}

const FIXED_EPOCH = 1700000000;
const FIXED_DATE = '2026-01-01T00:00:00Z';

export function globalId(kind: 'R' | 'I' | 'P' | 'C', key: string): string {
  return `${kind}_${Buffer.from(key, 'utf8').toString('base64url')}`;
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  const match = /^([RIPC])_([A-Za-z0-9_-]+)$/.exec(id);
  if (match === null) return null;
  try {
    return { kind: match[1]!, key: Buffer.from(match[2]!, 'base64url').toString('utf8') };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextEntityId = 1;
  private nextCommitSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Repositories owned by the viewer, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): Repo {
    const id = this.nextEntityId++;
    const repo: Repo = {
      id,
      name,
      owner: VIEWER_LOGIN,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // git helpers
  // -------------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The commit a ref peels to, or null. */
  peelRef(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    return peelToCommit(this.lookup(repo), oid);
  }

  /** Sorted ref names, HEAD excluded (callers add it). */
  sortedRefs(repo: Repo): string[] {
    return [...repo.refs.keys()].sort();
  }

  /** Create a commit object from a flat file map and store it. */
  makeCommit(
    repo: Repo,
    options: { files: ReadonlyMap<string, { oid: string; mode: string }>; parents: readonly string[]; message: string },
  ): string {
    const tree = buildTreeFromPaths(repo.objects, options.files);
    const timestamp = FIXED_EPOCH + this.nextCommitSeq++;
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommitBytes({ tree, parents: options.parents, message: options.message, author, committer: author, timestamp });
    return storeObject(repo.objects, 'commit', data);
  }

  /** The flat file map of a commit's tree (empty when the commit is missing). */
  filesOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(this.lookup(repo), parseCommit(object.data).tree);
  }

  /** Read one path out of a commit's tree. */
  readPath(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'blob' | 'tree'; oid: string; entries?: { name: string; mode: string; oid: string }[] } | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    let treeOid = parseCommit(object.data).tree;
    const segments = path === '' ? [] : path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entries = parseTree(tree.data);
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const sub = repo.objects.get(entry.oid);
          if (sub === undefined) return null;
          return { kind: 'tree', oid: entry.oid, entries: parseTree(sub.data) };
        }
        return { kind: 'blob', oid: entry.oid };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const root = repo.objects.get(treeOid);
    if (root === undefined) return null;
    return { kind: 'tree', oid: treeOid, entries: parseTree(root.data) };
  }

  /** Commits reachable from `tip`, newest first (parents after children). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Diff two trees (flat maps) into per-path changes with line counts. */
  diffFiles(repo: Repo, baseTree: Map<string, { oid: string; mode: string }>, headTree: Map<string, { oid: string; mode: string }>): FileChange[] {
    const changes: FileChange[] = [];
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = baseTree.get(path);
      const newEntry = headTree.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
      if (oldEntry === undefined && newEntry !== undefined) {
        const blob = repo.objects.get(newEntry.oid);
        const lines = blob === undefined ? 0 : blob.data.toString('utf8').split('\n').length;
        changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: lines, deletions: 0 });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        const blob = repo.objects.get(oldEntry.oid);
        const lines = blob === undefined ? 0 : blob.data.toString('utf8').split('\n').length;
        changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: lines });
      } else if (oldEntry !== undefined && newEntry !== undefined) {
        const oldBlob = repo.objects.get(oldEntry.oid);
        const newBlob = repo.objects.get(newEntry.oid);
        const oldLines = oldBlob === undefined ? [] : oldBlob.data.toString('utf8').split('\n');
        const newLines = newBlob === undefined ? [] : newBlob.data.toString('utf8').split('\n');
        const oldSet = new Map<string, number>();
        for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
        let additions = 0;
        for (const line of newLines) {
          const remaining = oldSet.get(line) ?? 0;
          if (remaining > 0) oldSet.set(line, remaining - 1);
          else additions += 1;
        }
        let deletions = 0;
        for (const remaining of oldSet.values()) deletions += remaining;
        changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions: Math.max(additions, 1), deletions });
      }
    }
    return changes;
  }

  /** Files a pull request changes: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit === undefined || headCommit.type !== 'commit') return [];
    const baseSha = this.currentBaseSha(repo, pull);
    const base = mergeBase(this.lookup(repo), pull.headSha, baseSha);
    const baseFiles = base === null ? new Map() : this.filesOfCommit(repo, base);
    return this.diffFiles(repo, baseFiles, this.filesOfCommit(repo, pull.headSha));
  }

  /** The current tip of a pull request's base branch (it may have advanced since the PR was opened). */
  currentBaseSha(repo: Repo, pull: Pull): string {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  /** Whether a pull request can merge cleanly (no path changed on both sides differently). */
  pullConflict(repo: Repo, pull: Pull): boolean {
    const baseSha = this.currentBaseSha(repo, pull);
    const base = mergeBase(this.lookup(repo), pull.headSha, baseSha);
    if (base === null) return false;
    const baseFiles = this.filesOfCommit(repo, base);
    const headFiles = this.filesOfCommit(repo, pull.headSha);
    const baseTipFiles = this.filesOfCommit(repo, baseSha);
    const headChanges = this.diffFiles(repo, baseFiles, headFiles);
    const baseChanges = this.diffFiles(repo, baseFiles, baseTipFiles);
    const baseChanged = new Map(baseChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const other = baseChanged.get(change.path);
      if (other === undefined) continue;
      if (other.newOid !== change.newOid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    if (this.pullConflict(repo, pull)) return null;
    const headFiles = this.filesOfCommit(repo, pull.headSha);
    const message = `Squash merge #${pull.number}: ${pull.title}\n`;
    const mergeSha = this.makeCommit(repo, { files: headFiles, parents: [this.currentBaseSha(repo, pull)], message });
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_DATE;
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    const issue: Issue = {
      id: this.nextEntityId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels: labelNames.map((name) => repo.labels.get(name)!).filter(Boolean),
    };
    repo.issues.push(issue);
    repo.comments.set(issue.number, []);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: Pull = {
      id: this.nextEntityId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    const comment: Comment = { id: this.nextEntityId++, body };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { id: this.nextEntityId++, name, color: color ?? 'ededed', description: description ?? '' };
    repo.labels.set(name, label);
    return label;
  }

  /** Reachable objects from every ref tip (for fetch exclusion math). */
  reachableFromRefs(repo: Repo): Set<string> {
    return collectReachable([...repo.refs.values()], this.lookup(repo));
  }
}

export { ZERO_OID };

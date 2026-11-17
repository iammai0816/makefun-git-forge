// Git smart HTTP: /{owner}/{repo}.git/info/refs and the upload-pack /
// receive-pack POSTs. Protocol v2 for upload-pack (when the client asks
// with `Git-Protocol: version=2`), v0 otherwise; receive-pack is v0 only.
//
// v2 capabilities: ls-refs=unborn, fetch=shallow filter, object-format=sha1.
// v0 upload-pack capabilities: multi_ack thin-pack side-band side-band-64k
// ofs-delta shallow deepen-since deepen-not no-progress include-tag
// symref=HEAD:refs/heads/main object-format=sha1.
// v0 receive-pack capabilities: report-status side-band-64k delete-refs
// ofs-delta quiet atomic.

import {
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  peelToCommit,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  type GitObject,
} from './git-objects.ts';
import { parsePack, writePack } from './git-pack.ts';
import { VIEWER_LOGIN } from './auth.ts';
import { type Repo, type Store } from './store.ts';

const AGENT = 'git-forge/1.0';
const UPLOAD_CAPS_V2 = ['ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', `agent=${AGENT}`];
const UPLOAD_CAPS_V0 =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag symref=HEAD:refs/heads/main object-format=sha1 agent=' +
  AGENT;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta quiet atomic agent=${AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

export function findGitRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

/** Refs in advertisement order: HEAD first, then sorted refs. */
function advertisedRefs(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const refs: { name: string; oid: string; peeled?: string }[] = [];
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(lookup, oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

function defaultBranch(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** v0 ref advertisement body (with the # service= preamble). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), PKT_FLUSH];
  const headTip = repo.refs.get(defaultBranch(repo));
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = headTip ?? refs[0]!.oid;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement body (with the # service= preamble). */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), PKT_FLUSH, encodePktLine('version 2\n')];
  for (const cap of UPLOAD_CAPS_V2) parts.push(encodePktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  name: string,
  service: string,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = findGitRepo(store, owner, name);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
    }
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send (full objects, no deltas). */
  objects: GitObject[];
  /** New shallow boundaries (commits whose parents are cut off). */
  shallow: string[];
  /** Previous shallow boundaries that are now fully included. */
  unshallow: string[];
}

/**
 * Plan a fetch: walk from `wants`, stop at `haves` and at the depth limit.
 * `priorShallow` are the client's current shallow boundaries.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  priorShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const priorShallowSet = new Set(priorShallow);
  // What the client already holds: the closure of its haves, but never
  // past a prior shallow boundary — a shallow clone holds the boundary
  // commit and its tree, not the boundary's parents. An unbounded closure
  // here would make a deepen deliver nothing.
  const haveSet = new Set<string>();
  const heldStack = [...haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop()!;
    if (haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    haveSet.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      heldStack.push(parsed.tree);
      if (!priorShallowSet.has(oid)) {
        for (const parent of parsed.parents) heldStack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) heldStack.push(entry.oid);
    } else if (object.type === 'tag') {
      heldStack.push(parseTag(object.data).object);
    }
  }
  // Commits to include, with their distance from a want (0 = the want itself).
  // Walk from the wants. Held commits are traversed (a deepen walks through
  // the held tip to its parents) but their objects are excluded from the
  // send set below.
  const includeCommits = new Map<string, number>();
  const queue: { oid: string; distance: number }[] = [];
  for (const want of wants) {
    if (!isObjectId(want) || want === ZERO_OID) continue;
    queue.push({ oid: want, distance: 0 });
  }
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (includeCommits.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      // A wanted tag: include the tag and walk its target at the same distance.
      includeCommits.set(oid, distance);
      queue.push({ oid: parseTag(object.data).object, distance });
      continue;
    }
    if (object.type !== 'commit') {
      includeCommits.set(oid, distance);
      continue;
    }
    if (depth !== null && distance >= depth) continue;
    includeCommits.set(oid, distance);
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, distance: distance + 1 });
    }
  }
  // The objects to send: the closure of the included commits, minus what
  // the client already has. The walk is bounded to included commits: a
  // parent that was cut off by depth (or by a shallow boundary) is never
  // traversed, so a depth-1 fetch sends only the tip commit, its tree and
  // its blobs.
  const send = new Set<string>();
  const stack = [...includeCommits.keys()];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (send.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    send.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      for (const parent of parsed.parents) {
        if (includeCommits.has(parent)) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (includeCommits.has(target)) stack.push(target);
    }
  }
  for (const oid of send) {
    if (haveSet.has(oid)) send.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  }
  // Shallow boundaries: included commits that have parents, none of which
  // were included (depth cut-off, or a prior shallow boundary kept shallow).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const [oid, distance] of includeCommits) {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const anyParentIncluded = parents.some((parent) => includeCommits.has(parent));
    if (!anyParentIncluded) {
      // Cut off: this commit is a new boundary, unless it is a have (already held).
      if (!haveSet.has(oid)) shallow.push(oid);
    }
  }
  // Prior shallow boundaries that are no longer boundaries: their parents
  // are now included (or they have no parents left out).
  for (const boundary of priorShallowSet) {
    if (shallow.includes(boundary)) continue;
    if (includeCommits.has(boundary)) {
      const object = lookup(boundary);
      if (object !== undefined && object.type === 'commit') {
        const parents = parseCommit(object.data).parents;
        if (parents.length > 0 && parents.every((parent) => includeCommits.has(parent))) unshallow.push(boundary);
      }
    }
  }
  // A depth-limited fetch always names its boundaries; a full fetch names
  // none unless the client already held shallow boundaries that stay cut.
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, prefixes: readonly string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(defaultBranch(repo));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip !== undefined) {
    if (keep('HEAD')) {
      const attrs = symrefs ? ` symref-target:${defaultBranch(repo)}` : '';
      parts.push(encodePktLine(`${headTip} HEAD${attrs}\n`));
    }
  } else if (unborn && keep('HEAD')) {
    const attrs = symrefs ? ` symref-target:${defaultBranch(repo)}` : '';
    parts.push(encodePktLine(`unborn HEAD${attrs}\n`));
  }
  for (const ref of advertisedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const attrs = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
    parts.push(encodePktLine(`${ref.oid} ${ref.name}${attrs}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleUploadPack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = findGitRepo(store, owner, name);
  if (repo === undefined) return notFound();
  let packets;
  try {
    packets = parsePktLines(body).packets;
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (lines.length === 0) return badRequest('empty upload-pack request');
  const command = lines[0] ?? '';
  const isV2 = gitProtocol === 'version=2';
  if (isV2 && command === 'command=ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const line of lines.slice(1)) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    void sawDelim;
    return ok('application/x-git-upload-pack-result', lsRefsResponse(repo, prefixes, peel, symrefs, unborn));
  }
  if (isV2 && command === 'command=fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n)) args.depth = n;
      }
    }
    if (args.wants.length === 0) return ok('application/x-git-upload-pack-result', encodePktLines(['acknowledgments\n', 'NAK\n', 'delim', 'flush']));
    return ok('application/x-git-upload-pack-result', fetchResponseV2(repo, args));
  }
  if (!isV2) {
    // v0 fetch: wants (first may carry capabilities), shallow/deepen, flush,
    // then haves and done. parsePktLines stops at the first flush, so parse
    // the whole body manually: split on flush packets.
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
    let offset = 0;
    let section = 0;
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (header === '0000') {
        section += 1;
        offset += 4;
        continue;
      }
      const length = parseInt(header, 16);
      if (!Number.isFinite(length) || length < 4 || offset + length > body.length) break;
      const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      offset += length;
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const oid = rest.split(' ')[0]!;
        args.wants.push(oid);
      } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n)) args.depth = n;
      }
    }
    void section;
    if (args.wants.length === 0) return ok('application/x-git-upload-pack-result', encodePktLines(['flush']));
    return ok('application/x-git-upload-pack-result', fetchResponseV0(repo, args));
  }
  return badRequest(`unsupported upload-pack command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): GitResponse {
  const repo = findGitRepo(store, owner, name);
  if (repo === undefined) return notFound();
  let commands: PushCommand[] = [];
  let packOffset = 0;
  try {
    const { packets, next } = parsePktLines(body);
    packOffset = next;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const parts = head.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  if (commands.length === 0) return badRequest('no push commands');

  // Unpack: everything after the command flush is the packfile (may be empty).
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packOffset);
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  // Apply each ref update; fast-forward only. A refused ref does not move.
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    let okUpdate = unpackOk;
    let reason = '';
    if (unpackOk) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          okUpdate = false;
          reason = 'remote ref does not exist';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          okUpdate = false;
          reason = 'non-fast-forward';
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          okUpdate = false;
          reason = 'already exists';
        } else if (!repo.objects.has(command.newOid)) {
          okUpdate = false;
          reason = 'object not found';
        }
      } else {
        // Update: old must match, new must be a descendant of old.
        if (current === undefined) {
          okUpdate = false;
          reason = 'remote ref does not exist';
        } else if (command.oldOid !== current) {
          okUpdate = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          okUpdate = false;
          reason = 'object not found';
        } else if (!isAncestor(lookup, command.oldOid, command.newOid)) {
          okUpdate = false;
          reason = 'non-fast-forward';
        }
      }
    }
    if (okUpdate) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    } else {
      reportLines.push(`ng ${command.ref} ${reason || 'failed'}`);
    }
  }

  // report-status inside side-band-64k band 1.
  const reportText = reportLines.map((line) => `${line}\n`).join('');
  const reportPkt = encodePktLines(reportText.split('\n').filter((line) => line !== '').map((line) => `${line}\n`));
  const banded = Buffer.concat([Buffer.from([1]), reportPkt]);
  const bodyOut = Buffer.concat([encodePktLine(banded), PKT_FLUSH]);
  return ok('application/x-git-receive-pack-result', bodyOut);
}

// Git object model: SHA-1 ids, tree/commit/tag parsing and building,
// pkt-line framing, delta application, and graph walks. Stdlib only
// (node:crypto, node:zlib). No wall clock, no randomness: every byte the
// server creates is a pure function of its inputs.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree to path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  const tree = lookup(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(lookup, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Build nested trees from a flat path -> blob oid map, storing every tree
 * object. Returns the root tree oid.
 */
export function buildTreeFromPaths(
  objects: Map<string, GitObject>,
  files: ReadonlyMap<string, { oid: string; mode: string }>,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(objects, 'tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    // Continuation lines (gpgsig) start with a space; they belong to the previous header.
    if (line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommitBytes(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const who = `${fields.author} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// graph walks
// ---------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (commits, trees, tags, blobs). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(
  lookup: (oid: string) => GitObject | undefined,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits (linear histories: first shared commit). */
export function mergeBase(
  lookup: (oid: string) => GitObject | undefined,
  a: string,
  b: string,
): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Peel a ref target to a commit: annotated tags resolve to their target commit. */
export function peelToCommit(
  lookup: (oid: string) => GitObject | undefined,
  oid: string,
): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'end') parts.push(PKT_END);
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'end' };

/** Parse pkt-lines from a buffer; returns packets and the offset just past them (flush-terminated). */
export function parsePktLines(buffer: Buffer, start = 0): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, next: offset + 4 };
    }
    if (header === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    const length = parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`malformed pkt-line header ${JSON.stringify(header)}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** The data-packet payloads of a pkt-line stream, as text lines (trailing newline stripped). */
export function pktTextLines(buffer: Buffer): string[] {
  const { packets } = parsePktLines(buffer);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// deltas
// ---------------------------------------------------------------------------------------------

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset++]!;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) copyOffset |= delta[offset++]! << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) copySize |= delta[offset++]! << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      if (offset + opcode > delta.length) throw new Error('delta insert out of range');
      parts.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      produced += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Inflate a zlib stream that starts at `offset`, finding its exact end by
 * binary search (inflateSync ignores trailing bytes but throws on truncation,
 * so the smallest succeeding length is the stream's end).
 */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const max = buffer.length - offset;
  if (max <= 0) throw new Error('pack entry has no zlib stream');
  let low = 1;
  let high = max;
  let data: Buffer | null = null;
  // Exponential probe first: most streams are short, so grow quickly.
  let probe = Math.min(64, max);
  while (probe < max) {
    try {
      data = zlibInflateSync(buffer.subarray(offset, offset + probe));
      break;
    } catch {
      probe = Math.min(max, probe * 2);
    }
  }
  if (data === null) {
    // The stream is at most `probe` bytes (or exactly max): binary search the end.
    low = 1;
    high = probe;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      try {
        zlibInflateSync(buffer.subarray(offset, offset + mid));
        high = mid;
      } catch {
        low = mid + 1;
      }
    }
    data = zlibInflateSync(buffer.subarray(offset, offset + low));
    return { data, next: offset + low };
  }
  // `data` inflated at `probe` bytes; shrink to the exact end.
  low = 1;
  high = probe;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      zlibInflateSync(buffer.subarray(offset, offset + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return { data: zlibInflateSync(buffer.subarray(offset, offset + low)), next: offset + low };
}

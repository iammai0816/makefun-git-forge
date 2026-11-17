// Packfile generation and parsing (pack v2, no deltas on write; full delta
// resolution on read: OFS_DELTA and REF_DELTA, thin packs included).

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflateSync } from 'node:zlib';
import {
  applyDelta,
  hashObject,
  inflateAt,
  type GitObject,
  type GitObjectType,
} from './git-objects.ts';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a pack v2 from plain objects (no deltas). Trailer is SHA-1 over the rest. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface PackEntryRaw {
  offset: number;
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  size: number;
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

function readSizeVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/**
 * Parse a packfile into objects. `lookup` resolves REF_DELTA bases the pack
 * itself does not carry (thin packs). Returns the resolved objects keyed by
 * oid, in pack order.
 */
export function parsePack(
  pack: Buffer,
  lookup?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: PackEntryRaw[] = [];
  const byOffset = new Map<number, PackEntryRaw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readSizeVarint(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6) {
      // OFS_DELTA
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      offset = afterBase;
      const { data, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      const entry: PackEntryRaw = { offset: entryOffset, type: 'ofs-delta', size, data, baseOffset: entryOffset - baseOffset };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      const entry: PackEntryRaw = { offset: entryOffset, type: 'ref-delta', size, data, baseOid };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const entry: PackEntryRaw = { offset: entryOffset, type, size, data };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }

  const resolved = new Map<string, GitObject>();
  const resolve = (entry: PackEntryRaw, depth = 0): GitObject => {
    if (depth > 100) throw new Error('delta chain too deep');
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry, depth + 1);
      } else {
        const inPack = entries.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type as GitObjectType, candidate.data) === entry.baseOid);
        if (inPack !== undefined) base = resolve(inPack, depth + 1);
        else base = lookup?.(entry.baseOid!);
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not available`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: entry.type as GitObjectType, data: entry.data };
  };

  for (const entry of entries) {
    const object = resolve(entry);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

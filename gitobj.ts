// gitobj.ts — the git object model for github-forge-v2: SHA-1 addressed objects, tree and commit
// codecs, packfile reading (with OFS/REF delta resolution) and packfile writing (plain objects),
// plus pkt-line framing. Pure node: built-ins only, no git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type GitType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_CODE: Readonly<Record<GitType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4, };
export const CODE_TYPE: Readonly<Record<number, GitType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject { type: GitType; data: Buffer }

export function hashObject(type: GitType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean { return /^[0-9a-f]{40}$/.test(value); }

// ------------------------------------------------------------------ trees

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string { return entry.mode === '40000' ? `${entry.name}/` : entry.name; }

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
  rawMessage: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const rawMessage = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const stampMatch = / (\d+) [+-]\d{4}$/.exec(committer || author);
  const timestamp = stampMatch ? Number(stampMatch[1]) : 0;
  // The display message drops exactly one trailing newline; the stored bytes never change.
  const message = rawMessage.endsWith('\n') ? rawMessage.slice(0, -1) : rawMessage;
  return { tree, parents, author, committer, timestamp, message, rawMessage };
}

export function buildCommit(fields: {
  tree: string; parents: readonly string[]; message: string;
  authorName: string; authorEmail: string; timestamp: number;
}): Buffer {
  const who = `${fields.authorName} <${fields.authorEmail}> ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '', fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView { object: string; type: string; tag: string; message: string }

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const out: TagView = { object: '', type: '', tag: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

/** Peel a ref target through tag objects until a non-tag object (or a missing object) is reached. */
export function peelToCommit(lookup: (oid: string) => GitObject | undefined, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
    if (!isOid(current)) return current;
  }
  return current;
}

// ------------------------------------------------------------------ reachability

/** Every object reachable from `tips` (commits walk parents and trees; tags walk their target). */
export function collectReachable(lookup: (oid: string) => GitObject | undefined, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its commit ancestors. */
export function isAncestor(lookup: (oid: string) => GitObject | undefined, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

// ------------------------------------------------------------------ packfiles

function packObjectHeader(type: GitType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) { bytes.push(first | 0x80); first = size & 0x7f; size = Math.floor(size / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 packfile of plain (non-delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readPackVarint(buffer: Buffer, start: number): { size: number; first: number; next: number } {
  let offset = start;
  const first = buffer[offset] as number;
  offset += 1;
  let size = first & 0x0f;
  let shift = 4;
  let byte = first;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, first, next: offset };
}

function readOfsOffset(buffer: Buffer, start: number): { baseOffsetBack: number; next: number } {
  let offset = start;
  let byte = buffer[offset] as number;
  offset += 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffsetBack: value, next: offset };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readSize();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset] as number; offset += 1; }
      if (op & 0x02) { copyOffset += (delta[offset] as number) * 256; offset += 1; }
      if (op & 0x04) { copyOffset += (delta[offset] as number) * 65536; offset += 1; }
      if (op & 0x08) { copyOffset += (delta[offset] as number) * 16777216; offset += 1; }
      if (op & 0x10) { copySize = delta[offset] as number; offset += 1; }
      if (op & 0x20) { copySize += (delta[offset] as number) * 256; offset += 1; }
      if (op & 0x40) { copySize += (delta[offset] as number) * 65536; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      chunks.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize) throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  return out;
}

interface RawPackEntry {
  offset: number; typeCode: number; data: Buffer;
  baseOffset?: number; baseOid?: string;
}

/** Parse a packfile and resolve every object, including OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, externalBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const ofs = readOfsOffset(pack, offset);
      offset = ofs.next;
      entry.baseOffset = entryOffset - ofs.baseOffsetBack;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<string, GitObject>();
  const resolveEntry = (entry: RawPackEntry, guard: Set<number>): GitObject => {
    if (guard.has(entry.offset)) throw new Error('delta cycle in pack');
    guard.add(entry.offset);
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      return { type: CODE_TYPE[entry.typeCode] as GitType, data: entry.data };
    }
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing from pack');
      const base = resolveEntry(baseEntry, guard);
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    if (entry.typeCode === 7) {
      const inPack = raw.find((candidate) => {
        if (candidate.typeCode < 1 || candidate.typeCode > 4) return false;
        return hashObject(CODE_TYPE[candidate.typeCode] as GitType, candidate.data) === entry.baseOid;
      });
      let base: GitObject | undefined;
      if (inPack) base = resolveEntry(inPack, guard);
      else base = externalBase?.(entry.baseOid as string);
      if (!base) throw new Error('ref-delta base missing');
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    throw new Error(`unknown pack type code ${entry.typeCode}`);
  };
  for (const entry of raw) {
    const object = resolveEntry(entry, new Set());
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

// ------------------------------------------------------------------ pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode as many complete pkt-lines as `buffer` holds; returns packets plus the unconsumed rest. */
export function decodePktLines(buffer: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let cursor = offset;
  while (cursor + 4 <= buffer.length) {
    const header = buffer.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) { packets.push({ kind: 'flush' }); cursor += 4; continue; }
    if (length === 1) { packets.push({ kind: 'delim' }); cursor += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end' }); cursor += 4; continue; }
    if (length < 4 || cursor + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { packets, next: cursor };
}

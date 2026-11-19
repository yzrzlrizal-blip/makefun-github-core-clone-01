// git-core.ts — pure git protocol helpers: pkt-line codec, SHA-1 object ids,
// tree/commit/tag parsing and building, packfile read (with OFS/REF delta
// resolution) and write (plain objects only), reachability and flat trees.
// Node stdlib only (node:crypto, node:zlib). No I/O, no clock, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 id of an object, exactly as git computes it. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: ObjType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
  /** The raw bytes of this packet, header included. */
  raw: Buffer;
}

export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktLineError';
  }
}

/** Decode a whole buffer of pkt-lines. Throws PktLineError on malformed input. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new PktLineError('truncated pkt-line header');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PktLineError(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new PktLineError(`pkt-line length ${len} out of range`);
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len), raw: buf.subarray(off, off + len) });
    off += len;
  }
  return out;
}

/** Encode data packets from lines, plus a trailing flush. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Split decoded packets into sections divided by flush/delim; returns the data lines per section. */
export function pktSections(packets: readonly Pkt[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      sections.push(current);
      current = [];
      continue;
    }
    current.push(packet.payload.toString('utf8'));
  }
  sections.push(current);
  return sections;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git tree sort order: entries by name, directories as if named `name/`. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
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
  return { tree, parents, author, committer, message, raw: data };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${message}`, 'utf8');
}

/** Parse an `author Name <email> ts +0000` line. */
export function parseIdent(line: string): { name: string; email: string; timestamp: number; tz: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!match) return { name: line, email: '', timestamp: 0, tz: '+0000' };
  return { name: match[1] ?? '', email: match[2] ?? '', timestamp: Number(match[3] ?? 0), tz: match[4] ?? '+0000' };
}

// ---------------------------------------------------------------- reachability / flat trees

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots` (commit → tree + parents, tag → target, tree → entries). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
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

/** True when `ancestor` is `descendant` itself or reachable from it through parents (tags peeled). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.parents.includes(ancestor)) return true;
      queue.push(...commit.parents);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target === ancestor) return true;
      queue.push(target);
    }
  }
  return false;
}

/** Peel tags to the object they point at (commit/tree/blob). */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return current;
  }
  return null;
}

/** A commit's tree as a flat path → {oid, mode} map. */
export function flatTreeOfCommit(objects: Map<string, GitObject>, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return out;
  const root = parseCommit(commit.data).tree;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(root, '');
  return out;
}

/** Build nested tree objects from a flat path map, storing them via `put`; returns the root tree oid. */
export function buildTreeFromFlat(
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  put: (type: ObjType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- deltas

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('delta varint overruns buffer');
    const byte = buf[pos] as number;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to its base. Throws on malformed deltas or size mismatches. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readVarint(delta, 0);
  if (src.value !== base.length) throw new Error(`delta source size ${src.value} != base ${base.length}`);
  const tgt = readVarint(delta, src.next);
  const out: Buffer[] = [];
  let outLen = 0;
  let pos = tgt.next;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) {
        offset = delta[pos] as number;
        pos += 1;
      }
      if ((op & 0x02) !== 0) {
        offset |= (delta[pos] as number) << 8;
        pos += 1;
      }
      if ((op & 0x04) !== 0) {
        offset |= (delta[pos] as number) << 16;
        pos += 1;
      }
      if ((op & 0x08) !== 0) {
        offset |= (delta[pos] as number) << 24;
        pos += 1;
      }
      if ((op & 0x10) !== 0) {
        size = delta[pos] as number;
        pos += 1;
      }
      if ((op & 0x20) !== 0) {
        size |= (delta[pos] as number) << 8;
        pos += 1;
      }
      if ((op & 0x40) !== 0) {
        size |= (delta[pos] as number) << 16;
        pos += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy overruns base');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert overruns delta');
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  if (outLen !== tgt.value) throw new Error(`delta target size ${tgt.value} != produced ${outLen}`);
  return Buffer.concat(out, outLen);
}

// ---------------------------------------------------------------- packs

const PACK_TYPE_NAMES: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Inflate the zlib stream starting at `offset`, expecting `expectedSize` bytes out.
 * inflateSync ignores trailing bytes and throws on truncation, so binary-search
 * the smallest prefix that inflates to exactly the expected size.
 */
export function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  let lo = 0;
  let hi = buf.length - offset;
  if (hi < 0) throw new Error('inflate offset past end of pack');
  // Fast path: the whole rest inflates to the expected size and is short.
  const tryInflate = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(offset, offset + len));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  // Binary search the minimal working length.
  let answer: { data: Buffer; next: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const out = tryInflate(mid);
    if (out !== null) {
      answer = { data: out, next: offset + mid };
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (answer !== null) return answer;
  // Fallback: maybe the full remainder is exactly right (defensive; binary search covers it).
  const full = tryInflate(buf.length - offset);
  if (full !== null) return { data: full, next: buf.length };
  throw new Error(`could not inflate object at pack offset ${offset} (expected ${expectedSize} bytes)`);
}

export interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
  delta: boolean;
}

export interface ParsedPack {
  version: number;
  entries: PackEntry[];
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Parse and resolve a packfile. `resolveBase` supplies thin-pack bases the pack itself lacks. */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile (bad magic)');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  let offset = 12;
  interface RawEntry {
    typeNum: number;
    baseOid?: string;
    baseOffset?: number;
    data: Buffer;
    startOffset: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    if (offset >= buf.length) throw new Error('pack truncated in object header');
    let byte = buf[offset] as number;
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= buf.length) throw new Error('pack truncated in size varint');
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 7) {
      if (offset + 20 > buf.length) throw new Error('pack truncated in ref-delta base');
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeNum === 6) {
      let b = buf[offset] as number;
      offset += 1;
      let base = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (offset >= buf.length) throw new Error('pack truncated in ofs-delta base');
        b = buf[offset] as number;
        offset += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = startOffset - base;
    } else if (!(typeNum in PACK_TYPE_NAMES)) {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
    const inflated = inflateAt(buf, offset, size);
    offset = inflated.next;
    const entry: RawEntry = { typeNum, baseOid, baseOffset, data: inflated.data, startOffset };
    raw.push(entry);
    byOffset.set(startOffset, entry);
  }
  // Trailer checksum: SHA-1 of everything before the last 20 bytes.
  if (buf.length < offset + 20) throw new Error('pack truncated before trailer');
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (trailer !== computed) throw new Error(`pack trailer ${trailer} != computed ${computed}`);

  const objects = new Map<string, GitObject>();
  const entries: PackEntry[] = [];
  let deltaCount = 0;
  // Resolve in dependency order: plain entries first, then deltas (iteratively).
  const resolved = new Map<number, { type: ObjType; data: Buffer }>();
  for (const entry of raw) {
    if (entry.typeNum in PACK_TYPE_NAMES) {
      resolved.set(entry.startOffset, { type: PACK_TYPE_NAMES[entry.typeNum] as ObjType, data: entry.data });
    }
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (const entry of raw) {
      if (resolved.has(entry.startOffset)) continue;
      const base = baseOf(entry, resolved, byOffset, raw, resolveBase);
      if (base === null) continue; // base not resolved yet; retry next round
      resolved.set(entry.startOffset, { type: base.type, data: applyDelta(base.data, entry.data) });
      deltaCount += 1;
      progress = true;
    }
    if ([...raw].every((entry) => resolved.has(entry.startOffset))) break;
    if (!progress) {
      // Nothing resolved this round: the remaining deltas have no available base.
      for (const entry of raw) {
        if (resolved.has(entry.startOffset)) continue;
        const base = baseOf(entry, resolved, byOffset, raw, resolveBase);
        if (base === null) throw new Error('delta base not available');
        resolved.set(entry.startOffset, { type: base.type, data: applyDelta(base.data, entry.data) });
        deltaCount += 1;
      }
    }
  }
  for (const entry of raw) {
    const found = resolved.get(entry.startOffset);
    if (found === undefined) throw new Error('unresolved delta in pack');
    const oid = hashObject(found.type, found.data);
    entries.push({ type: found.type, data: found.data, oid, delta: !(entry.typeNum in PACK_TYPE_NAMES) });
    objects.set(oid, { type: found.type, data: found.data });
  }
  return { version, entries, objects, deltaCount };
}

function baseOf(
  entry: { typeNum: number; baseOid?: string; baseOffset?: number },
  resolved: ReadonlyMap<number, { type: ObjType; data: Buffer }>,
  byOffset: ReadonlyMap<number, { startOffset: number }>,
  raw: readonly { typeNum: number; startOffset: number; data: Buffer }[],
  resolveBase?: (oid: string) => GitObject | undefined,
): { type: ObjType; data: Buffer } | null {
  if (entry.typeNum === 6) {
    return resolved.get(entry.baseOffset as number) ?? null;
  }
  if (entry.typeNum === 7) {
    const baseOid = entry.baseOid as string;
    // A base that is itself a plain entry in this pack: find it by oid.
    for (const candidate of raw) {
      const known = resolved.get(candidate.startOffset);
      if (known !== undefined && hashObject(known.type, known.data) === baseOid) return known;
    }
    if (resolveBase !== undefined) {
      const external = resolveBase(baseOid);
      if (external !== undefined) return external;
    }
    return null;
  }
  return null;
}

/** Verify a pack's trailer checksum without parsing its objects. */
export function verifyPackChecksum(buf: Buffer): { ok: boolean; expected: string; actual: string } {
  if (buf.length < 20) return { ok: false, expected: '', actual: '' };
  const actual = buf.subarray(buf.length - 20).toString('hex');
  const expected = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  return { ok: actual === expected, expected, actual };
}

/** Write a packfile of plain (non-delta) objects, version 2, with a trailer checksum. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const typeNums: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const object of objects) {
    const typeNum = typeNums[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    let remaining = size >>> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Split bytes into sideband band-1 pkt-lines (payload = 0x01 + chunk). */
export function sidebandPackets(data: Buffer, chunkSize = 60000): Buffer[] {
  const packets: Buffer[] = [];
  for (let off = 0; off < data.length; off += chunkSize) {
    const chunk = data.subarray(off, Math.min(data.length, off + chunkSize));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

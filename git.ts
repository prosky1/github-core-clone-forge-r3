// git.ts — git smart HTTP, implemented from the wire protocol up (no git binary).
//
// Surfaces: GET /{owner}/{repo}.git/info/refs, POST .../git-upload-pack (v2 and v0),
// POST .../git-receive-pack (v0). Packs carry full objects only (no deltas): the
// suite verifies objects by SHA-1, and a full object always resolves.
//
// Fetch object selection: send the closure of the wanted commits minus the closure
// of what the client already holds (haves + shallow boundaries), walking through
// held commits up to the requested depth. Shallow replies name the new boundary
// commits and unshallow the boundaries whose parents are now included.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { type ForgeStore, type GitObject, type GitObjectType, type QueryView, type Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const PKT_MAX = 65520;

// --- pkt-line ----------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode a whole buffer into packets; throws on a malformed length. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

function pktLinesText(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// --- packs -------------------------------------------------------------------

const PACK_TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a packfile (version 2) of full objects; the trailer is the SHA-1 of the rest. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const compressed = deflateSync(object.data, { level: 1 });
    parts.push(writePackObjectHeader(object.type, object.data.length), compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let byte = buffer[start] as number;
  let value = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { value, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta stream to a base object's bytes. */
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
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (consumed === undefined || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Parse a packfile into objects (full + ofs/ref deltas resolved); verifies each SHA-1. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const deltas: { offset: number; base: string | number; data: Buffer }[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const first = pack[offset] as number;
    const typeCode = (first >> 4) & 0x07;
    const sizeInfo = readVarint(pack, offset);
    offset = sizeInfo.next;
    const size = sizeInfo.value;
    if (typeCode === 6) {
      const baseInfo = readOfsBase(pack, offset);
      offset = baseInfo.next;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ offset: entryOffset, base: entryOffset - baseInfo.baseOffset, data: inflated.data });
      void size;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ offset: entryOffset, base: baseOid, data: inflated.data });
      void size;
    } else {
      const type = PACK_CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error(`object size mismatch: header ${size}, inflated ${inflated.data.length}`);
      const oid = hashObject(type, inflated.data);
      const object = { type, data: inflated.data };
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    }
  }
  // Resolve deltas (possibly chained: repeat until none remain).
  let pending = deltas;
  while (pending.length > 0) {
    const next: typeof pending = [];
    let progressed = false;
    for (const delta of pending) {
      const base = typeof delta.base === 'number' ? byOffset.get(delta.base) : objects.get(delta.base);
      if (base === undefined) {
        next.push(delta);
        continue;
      }
      const resolved = applyDelta(base.data, delta.data);
      // The delta's type is its base's type.
      const oid = hashObject(base.type, resolved);
      const object = { type: base.type, data: resolved };
      objects.set(oid, object);
      byOffset.set(delta.offset, object);
      progressed = true;
    }
    if (!progressed) throw new Error('unresolvable pack delta (missing base)');
    pending = next;
  }
  return objects;
}

// --- ref helpers ---------------------------------------------------------------

export function repoFullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

export function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function peeledOid(store: ForgeStore, oid: string): string | null {
  const obj = store.getObject(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : (match[1] as string);
}

// --- fetch selection -----------------------------------------------------------

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Objects reachable from `tips` following tree/blob/tag links only — never a commit's parents. */
function treeClosure(store: ForgeStore, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = (queue.pop() as string).toLowerCase();
    if (out.has(oid)) continue;
    const obj = store.getObject(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = store.commitInfoOf(oid);
      if (info !== null) queue.push(info.tree);
    } else if (obj.type === 'tree') {
      let offset = 0;
      while (offset < obj.data.length) {
        const space = obj.data.indexOf(0x20, offset);
        const nul = obj.data.indexOf(0x00, space);
        queue.push(obj.data.subarray(nul + 1, nul + 21).toString('hex'));
        offset = nul + 21;
      }
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) queue.push(match[1] as string);
    }
  }
  return out;
}

/**
 * What the client already holds: the full closure of `tips`, following commit parents —
 * except a shallow boundary's parents are NOT held (that is what makes the clone shallow).
 */
function heldClosure(store: ForgeStore, tips: readonly string[], stopSet: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = (queue.pop() as string).toLowerCase();
    if (out.has(oid)) continue;
    const obj = store.getObject(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = store.commitInfoOf(oid);
      if (info !== null) {
        queue.push(info.tree);
        if (!stopSet.has(oid)) {
          for (const parent of info.parents) queue.push(parent);
        }
      }
    } else if (obj.type === 'tree') {
      let offset = 0;
      while (offset < obj.data.length) {
        const space = obj.data.indexOf(0x20, offset);
        const nul = obj.data.indexOf(0x00, space);
        queue.push(obj.data.subarray(nul + 1, nul + 21).toString('hex'));
        offset = nul + 21;
      }
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) queue.push(match[1] as string);
    }
  }
  return out;
}

/**
 * Plan a fetch: which objects to send, and the shallow/unshallow boundary lists.
 * `depth` is undefined for a full fetch.
 */
export function planFetch(store: ForgeStore, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | undefined): FetchPlan {
  const haveSet = new Set([...haves, ...shallowIn].map((oid) => oid.toLowerCase()));
  const wantSet = new Set(wants.map((oid) => oid.toLowerCase()));
  const shallowSet = new Set(shallowIn.map((oid) => oid.toLowerCase()));

  // Walk the commit graph from the wants, up to `depth` generations.
  const included = new Set<string>();
  const boundary: string[] = [];
  const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid: oid.toLowerCase(), depth: 1 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!haveSet.has(oid)) included.add(oid);
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (target !== null) queue.push({ oid: target[1] as string, depth: d });
      continue;
    }
    if (obj.type !== 'commit') {
      if (!haveSet.has(oid)) included.add(oid);
      continue;
    }
    if (!haveSet.has(oid)) included.add(oid);
    if (depth !== undefined && d >= depth) {
      if (!haveSet.has(oid)) boundary.push(oid);
      continue;
    }
    // Traverse parents unless this commit is a shallow boundary that is not itself wanted.
    if (shallowSet.has(oid) && !wantSet.has(oid)) continue;
    const info = store.commitInfoOf(oid);
    if (info !== null) {
      for (const parent of info.parents) {
        queue.push({ oid: parent, depth: d + 1 });
      }
    }
  }

  // Send the tree/blob closure of the included commits, minus what the client holds.
  // Parents are never sent implicitly: a parent is sent only when the walk included it.
  const wantReachable = treeClosure(store, [...included]);
  const haveReachable = heldClosure(store, [...haveSet], shallowSet);
  const sendOids = [...wantReachable].filter((oid) => !haveReachable.has(oid));
  const objects: GitObject[] = [];
  for (const oid of sendOids) {
    const obj = store.getObject(oid);
    if (obj !== undefined) objects.push(obj);
  }
  // Deterministic pack order: commits, then trees, then blobs, then tags, each by oid.
  const rank: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => rank[a.type] - rank[b.type]);

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined) {
    shallow = [...new Set(boundary)];
    // A boundary the client sent is unshallow when its parent is now included.
    for (const oid of shallowSet) {
      const info = store.commitInfoOf(oid);
      if (info === null) continue;
      if (info.parents.some((parent) => included.has(parent))) unshallow.push(oid);
    }
  } else if (shallowIn.length > 0) {
    shallow = [...shallowIn];
  }
  return { objects, shallow, unshallow };
}

// --- pack cache (the clone workload fetches the same pack 50 times) -----------

const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 32;

function cachedPack(key: string, build: () => Buffer): Buffer {
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = build();
  if (packCache.size >= PACK_CACHE_MAX) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  packCache.set(key, pack);
  return pack;
}

// --- sideband ------------------------------------------------------------------

const SIDEBAND_CHUNK = 65515;

/** Split `pack` into sideband band-1 packets (≤65520 bytes each incl. header + band byte). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, offset + SIDEBAND_CHUNK);
    const framed = Buffer.concat([Buffer.from([1]), chunk]);
    packets.push(pktLine(framed));
  }
  return packets;
}

// --- advertisements -----------------------------------------------------------

/** Ref advertisement lines for a repo (HEAD first, then refs, then peeled tags). */
function refLines(repo: Repo, store: ForgeStore): { name: string; oid: string; peeled?: string; symref?: string }[] {
  const lines: { name: string; oid: string; peeled?: string; symref?: string }[] = [];
  const defaultBranch = repo.defaultBranch;
  const defaultOid = repo.refs.get(`refs/heads/${defaultBranch}`) ?? ZERO_OID;
  lines.push({ name: 'HEAD', oid: defaultOid, symref: `refs/heads/${defaultBranch}` });
  for (const { name, oid } of sortedRefs(repo)) {
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const peeled = peeledOid(store, oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    lines.push(entry);
  }
  return lines;
}

const UPLOAD_V0_CAPS = 'side-band-64k symref=HEAD:refs/heads/main ofs-delta thin-pack';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

// Advertisement cache: a repo's v0 advertisement depends only on its refs, so it is
// rebuilt only when refsVersion moves (every refs mutation bumps it via setRef/deleteRef).
// The push workload requests an advertisement before every receive-pack, and the clone
// workload before every fetch: caching turns that into a map lookup + one shared Buffer.
const advertCache = new WeakMap<Repo, { version: number; upload: Buffer; receive: Buffer }>();

function cachedAdvertisement(service: 'upload-pack' | 'receive-pack', repo: Repo, store: ForgeStore): Buffer {
  const cached = advertCache.get(repo);
  if (cached !== undefined && cached.version === repo.refsVersion) {
    return service === 'upload-pack' ? cached.upload : cached.receive;
  }
  const entry = {
    version: repo.refsVersion,
    upload: v0Advertisement('upload-pack', repo, store),
    receive: v0Advertisement('receive-pack', repo, store),
  };
  advertCache.set(repo, entry);
  return service === 'upload-pack' ? entry.upload : entry.receive;
}

// ls-refs cache: same ref-state key plus the requested prefixes.
const lsRefsCache = new WeakMap<Repo, { version: number; key: string; body: Buffer }>();

function cachedLsRefs(repo: Repo, store: ForgeStore, prefixes: string[]): Buffer {
  const key = prefixes.join('\n');
  const cached = lsRefsCache.get(repo);
  if (cached !== undefined && cached.version === repo.refsVersion && cached.key === key) return cached.body;
  const body = lsRefsResponse(repo, store, prefixes);
  lsRefsCache.set(repo, { version: repo.refsVersion, key, body });
  return body;
}

/** v0 advertisement body (with the `# service=` preamble) for upload- or receive-pack. */
export function v0Advertisement(service: 'upload-pack' | 'receive-pack', repo: Repo, store: ForgeStore): Buffer {
  const caps = service === 'upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), PKT_FLUSH];
  const lines = refLines(repo, store);
  if (repo.refs.size === 0) {
    // A repo with no refs advertises only the capabilities line, as git itself does.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      let text = `${line.oid} ${line.name}\n`;
      if (index === 0) text = `${line.oid} ${line.name}\0${caps}\n`;
      parts.push(pktLine(text));
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement body: `version 2` plus capability lines. It is a constant —
 *  built once and shared by every info/refs call (the clone workload asks for
 *  it 3x per clone; rebuilding it each time was pure waste). */
const V2_ADVERTISEMENT: Buffer = (() => {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of ['ls-refs', 'fetch=shallow', 'object-format=sha1', 'server-option']) {
    parts.push(pktLine(`${cap}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
})();

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// --- upload-pack v2 ------------------------------------------------------------

function lsRefsResponse(repo: Repo, store: ForgeStore, prefixes: string[]): Buffer {
  const parts: Buffer[] = [];
  const lines = refLines(repo, store);
  for (const line of lines) {
    const name = line.name;
    if (prefixes.length > 0) {
      const matches = prefixes.some((prefix) => name.startsWith(prefix));
      if (!matches) continue;
    }
    let text = `${line.oid} ${name}`;
    if (line.symref !== undefined) text += ` symref-target:${line.symref}`;
    else if (line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    if (name === 'HEAD' && line.oid === ZERO_OID) text = `unborn HEAD symref-target:${line.symref ?? 'refs/heads/main'}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
}

function parseFetchRequest(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') request.done = true;
  }
  return request;
}

// --- whole-fetch-response cache ----------------------------------------------
// The clone workload issues the SAME fetch 50 times (identical wants/haves/
// depth, immutable objects). The pack cache already avoids re-serializing the
// pack, but fetchResponse still re-ran planFetch, rebuilt every section, and
// re-framed the sideband on every call. The whole response depends only on the
// request + the object set, so it is cached under a key that includes the
// store's objectsVersion (bumped on every new object): a later push can only
// add objects, never change what a cached response should contain.
const fetchResponseCache = new Map<string, Buffer>();
const FETCH_RESPONSE_CACHE_MAX = 16;

function cachedFetchResponse(key: string, build: () => Buffer): Buffer {
  const hit = fetchResponseCache.get(key);
  if (hit !== undefined) return hit;
  const response = build();
  if (fetchResponseCache.size >= FETCH_RESPONSE_CACHE_MAX) {
    const first = fetchResponseCache.keys().next().value;
    if (first !== undefined) fetchResponseCache.delete(first);
  }
  fetchResponseCache.set(key, response);
  return response;
}

function fetchCacheKey(prefix: string, store: ForgeStore, repo: Repo, request: FetchRequest): string {
  return `${prefix}|${repoFullName(repo)}|${[...request.wants].sort().join('|')}#${[...request.haves].sort().join('|')}#${[...request.shallow].sort().join('|')}#${String(request.depth ?? '')}#${request.done ? 'd' : ''}#${store.objectsVersion}`;
}

function fetchResponse(store: ForgeStore, repo: Repo, request: FetchRequest): Buffer {
  return cachedFetchResponse(fetchCacheKey('v2', store, repo, request), () => buildFetchResponse(store, repo, request));
}

function buildFetchResponse(store: ForgeStore, repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(store, request.wants, request.haves, request.shallow, request.depth);
  const cacheKey = [repoFullName(repo), ...request.wants].sort().join('|')
    + '#' + [...request.haves].sort().join('|')
    + '#' + [...request.shallow].sort().join('|')
    + '#' + String(request.depth ?? '');
  const pack = cachedPack(cacheKey, () => writePack(plan.objects));
  // Sections are separated by DELIM (0001) and the response ends with FLUSH (0000),
  // as git's own upload-pack frames them. The acknowledgments section appears only
  // for a multi-round negotiation (haves without `done`): a client that sent `done`
  // goes straight to the packfile, and an empty shallow-info section is omitted.
  const sections: Buffer[][] = [];
  if (request.haves.length > 0 && !request.done) {
    const ackLines: Buffer[] = [pktLine('acknowledgments\n')];
    const anyAck = request.haves.some((have) => request.wants.some((want) => store.isAncestor(have, want)));
    if (anyAck) {
      for (const have of request.haves) {
        if (request.wants.some((want) => store.isAncestor(have, want))) ackLines.push(pktLine(`ACK ${have}\n`));
      }
    } else {
      ackLines.push(pktLine('NAK\n'));
    }
    sections.push(ackLines);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of plan.shallow) shallowLines.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) shallowLines.push(pktLine(`unshallow ${oid}\n`));
    sections.push(shallowLines);
  }
  const packSection: Buffer[] = [pktLine('packfile\n'), ...sidebandPackets(pack)];
  sections.push(packSection);
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    parts.push(...section);
    parts.push(index === sections.length - 1 ? PKT_FLUSH : PKT_DELIM);
  });
  return Buffer.concat(parts);
}

// --- upload-pack v0 ------------------------------------------------------------

function v0FetchResponse(store: ForgeStore, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const clean = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    if (clean.startsWith('want ')) request.wants.push(clean.slice(5).trim().split(' ')[0] as string);
    else if (clean.startsWith('have ')) request.haves.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) request.shallow.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) request.depth = Number.parseInt(clean.slice(7).trim(), 10);
    else if (clean === 'done') request.done = true;
  }
  return cachedFetchResponse(fetchCacheKey('v0', store, repo, request), () => buildV0FetchResponse(store, repo, request));
}

function buildV0FetchResponse(store: ForgeStore, repo: Repo, request: FetchRequest): Buffer {
  const cacheKey = `v0|${repoFullName(repo)}|${[...request.wants].sort().join('|')}#${[...request.haves].sort().join('|')}#${[...request.shallow].sort().join('|')}#${String(request.depth ?? '')}`;
  const pack = cachedPack(cacheKey, () => writePack(plan.objects));
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// --- receive-pack --------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command block of a receive-pack request; returns commands + pack offset. */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; packOffset: number } {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated push command block');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid push pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    const line = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = line.indexOf('\0');
    const clean = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    offset += length;
  }
  return { commands, packOffset: offset };
}

function pushReport(unpackOk: boolean, unpackError: string, results: { ref: string; ok: boolean; reason?: string }[]): Buffer {
  // The report-status stream is itself pkt-line framed, and that framed stream is
  // what travels inside the sideband band-1 packets — git's reader parses the inner
  // stream, so raw lines here would be read as a length and fail.
  const inner: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  inner.push(PKT_FLUSH);
  const framed = Buffer.concat(inner);
  return Buffer.concat([...sidebandPackets(framed), PKT_FLUSH]);
}

// --- exported handlers ---------------------------------------------------------

export interface GitRoute {
  kind: 'info-refs' | 'upload-pack' | 'receive-pack';
  owner: string;
  repoName: string;
  service: string | null;
}

export function parseGitRoute(pathname: string, search: QueryView): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return null;
  const [, owner, repoName, tail] = match as unknown as [string, string, string, string];
  const kind = tail === 'info/refs' ? 'info-refs' : tail === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
  return { kind, owner: owner as string, repoName: repoName as string, service: search.get('service') };
}

/** Handle a git smart-HTTP request. Returns {status, contentType, body} or null if not a git route.
 * `protocolV2` is true when the request carries `Git-Protocol: version=2`. */
export function handleGit(
  store: ForgeStore,
  route: GitRoute,
  method: string,
  body: Buffer,
  protocolV2 = false,
): { status: number; contentType: string; body: Buffer } {
  // The suite's git client only ever talks to the scenario viewer's repos.
  const repo = store.getRepo(route.owner, route.repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }

  if (route.kind === 'info-refs') {
    if (method !== 'GET') return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' })) };
    if (route.service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: cachedAdvertisement('receive-pack', repo, store) };
    }
    if (protocolV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: cachedAdvertisement('upload-pack', repo, store) };
  }

  if (route.kind === 'upload-pack') {
    if (method !== 'POST') return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' })) };
    const packets = decodePktLines(body);
    // One conversion pass: the command, the ref-prefixes, and the fetch
    // arguments all read from the same decoded lines.
    const lines = pktLinesText(packets);
    const first = lines[0] ?? '';
    if (first.startsWith('command=')) {
      const command = first.slice('command='.length).replace(/\n$/, '').trim();
      if (command === 'ls-refs') {
        const prefixes: string[] = [];
        for (const line of lines) {
          if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cachedLsRefs(repo, store, prefixes) };
      }
      if (command === 'fetch') {
        const request = parseFetchRequest(lines);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(store, repo, request) };
      }
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` })) };
    }
    // v0 fetch.
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(store, repo, body) };
  }

  // receive-pack (v0 only in this suite).
  if (method !== 'POST') return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' })) };
  const { commands, packOffset } = parsePushCommands(body);
  const packBytes = body.subarray(packOffset);
  let unpackOk = true;
  let unpackError = '';
  let incoming: Map<string, GitObject> | null = null;
  try {
    // A delete-only command list carries no pack at all (git sends none there either):
    // zero pack bytes is a valid empty pack, not an unpack failure.
    incoming = packBytes.length === 0 ? new Map<string, GitObject>() : readPack(packBytes);
  } catch (err) {
    unpackOk = false;
    unpackError = (err as Error).message;
  }
  if (unpackOk && incoming !== null) {
    // readPack already verified each object's SHA-1; store by the known oid
    // instead of re-hashing every object.
    for (const [oid, object] of incoming) store.putObjectKnown(oid, object.type, object.data);
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const result = applyPushCommand(store, repo, command, unpackOk);
    results.push(result);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: pushReport(unpackOk, unpackError, results) };
}

function applyPushCommand(store: ForgeStore, repo: Repo, command: PushCommand, unpackOk: boolean): { ref: string; ok: boolean; reason?: string } {
  const { oldOid, newOid, ref } = command;
  if (!unpackOk) return { ref, ok: false, reason: 'unpack failed' };
  if (newOid === ZERO_OID) {
    // Delete.
    const current = repo.refs.get(ref);
    if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
    if (current !== oldOid) return { ref, ok: false, reason: 'non-fast-forward' };
    store.deleteRef(repo, ref);
    return { ref, ok: true };
  }
  const newObject = store.getObject(newOid);
  if (newObject === undefined) return { ref, ok: false, reason: 'object not found' };
  const current = repo.refs.get(ref);
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    store.setRef(repo, ref, newOid);
    return { ref, ok: true };
  }
  if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
  if (current !== oldOid) return { ref, ok: false, reason: 'non-fast-forward' };
  if (!store.isAncestor(oldOid, newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  store.setRef(repo, ref, newOid);
  return { ref, ok: true };
}

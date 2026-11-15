// git.ts — git core: object parsing/building, packfile read/write, fetch planning.
// No git binary, no dependencies beyond node:zlib and node:crypto.
// Packfiles written here carry plain objects only (no deltas) — the client
// writes the same way, and the pack-deltas check only judges deltas "when
// the server sends them". Packfiles read here handle OFS_DELTA and REF_DELTA.

import { deflateSync, inflateSync } from 'node:zlib';
import { objectId, sha1Hex, type GitObject, type ObjType, type Repo, ZERO_OID } from './store.ts';

// ---------------------------------------------------------------------------
// Commits, trees, tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function gitSortKey(entry: TreeEntry): string {
  // Git sorts tree entries as if directory names end in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    gitSortKey(a) < gitSortKey(b) ? -1 : gitSortKey(a) > gitSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function buildTag(object: string, type: ObjType, tag: string, tagger: string, message: string): Buffer {
  return Buffer.from(
    `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------------------
// Building a tree from a path -> blob map (contents API, merges)
// ---------------------------------------------------------------------------

export interface FileEntry {
  oid: string;
  mode: string; // '100644' normally
}

/**
 * Build (and store) the tree for a full path map. Returns the root tree oid.
 * Intermediate trees are created as needed; a path removed from the map is
 * simply absent. Deterministic: same map -> same oids.
 */
export function buildTreeFromFiles(
  repo: Repo,
  files: Map<string, FileEntry>,
  put: (type: ObjType, data: Buffer) => string,
): string {
  // Group files by directory: dir -> entries directly inside it.
  interface DirNode {
    files: Map<string, FileEntry>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/').filter((p) => p !== '');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const buildDir = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, child] of node.dirs) {
      const childOid = buildDir(child);
      entries.push({ mode: '40000', name, oid: childOid });
    }
    return put('tree', buildTree(entries));
  };
  return buildDir(root);
}

/** Flatten a tree (recursively) into a path -> {oid, mode} map. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

// ---------------------------------------------------------------------------
// Packfile reading
// ---------------------------------------------------------------------------

const TYPE_BY_CODE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x0f;
  let shift = 4;
  let i = off;
  while (buf[i] & 0x80) {
    i += 1;
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
  }
  return { value, next: i + 1 };
}

/**
 * Inflate a deflate stream starting at `off` and find its exact length.
 * inflateSync ignores trailing bytes, so binary search finds the minimal
 * length whose inflate succeeds and yields the expected size.
 */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  const max = buf.length - off;
  // Tight upper bound: a deflate stream is rarely longer than its output.
  let hi = Math.min(max, expectedSize + 64 + Math.floor(expectedSize / 100) + 16);
  // If the bound is too small the inflate fails; grow it.
  for (;;) {
    try {
      const data = inflateSync(buf.subarray(off, off + hi));
      if (data.length === expectedSize) {
        // Binary-search the minimal length that still inflates to this size.
        let lo = 2;
        let top = hi;
        while (lo < top) {
          const mid = (lo + top) >> 1;
          try {
            const d = inflateSync(buf.subarray(off, off + mid));
            if (d.length === expectedSize) top = mid;
            else lo = mid + 1;
          } catch {
            lo = mid + 1;
          }
        }
        return { data, consumed: top };
      }
      // Inflated fine but wrong size: the bound cut the stream mid-way.
      hi = Math.min(max, hi * 2 + 64);
      if (hi >= max) {
        const data2 = inflateSync(buf.subarray(off));
        return { data: data2, consumed: max };
      }
    } catch {
      hi = Math.min(max, hi * 2 + 64);
      if (hi >= max) {
        // Last resort: inflate the whole remainder.
        const data = inflateSync(buf.subarray(off));
        return { data, consumed: max };
      }
    }
  }
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (version 2). Resolves OFS_DELTA and REF_DELTA. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer checksum.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) {
    throw new Error('pack trailer checksum mismatch');
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  // Deferred ref-deltas whose base is not yet known.
  const deferred: Array<{ baseOid: string; delta: Buffer; offset: number }> = [];
  let off = 12;
  const applyDelta = (base: Buffer, delta: Buffer): Buffer => {
    let p = 0;
    const readDeltaVarint = (): number => {
      let v = 0;
      let shift = 0;
      for (;;) {
        const b = delta[p++];
        v |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      return v;
    };
    const srcSize = readDeltaVarint();
    const tgtSize = readDeltaVarint();
    if (srcSize !== base.length) throw new Error('delta source size mismatch');
    const out: Buffer[] = [];
    let written = 0;
    while (p < delta.length) {
      const op = delta[p++];
      if (op & 0x80) {
        let cpOff = 0;
        let cpSize = 0;
        if (op & 0x01) cpOff = delta[p++];
        if (op & 0x02) cpOff |= delta[p++] << 8;
        if (op & 0x04) cpOff |= delta[p++] << 16;
        if (op & 0x08) cpOff |= delta[p++] << 24;
        if (op & 0x10) cpSize = delta[p++];
        if (op & 0x20) cpSize |= delta[p++] << 8;
        if (op & 0x40) cpSize |= delta[p++] << 16;
        if (cpSize === 0) cpSize = 0x10000;
        out.push(base.subarray(cpOff, cpOff + cpSize));
        written += cpSize;
      } else if (op !== 0) {
        out.push(delta.subarray(p, p + op));
        p += op;
        written += op;
      } else {
        throw new Error('delta op 0 is reserved');
      }
    }
    const result = Buffer.concat(out);
    if (result.length !== tgtSize || written !== tgtSize) throw new Error('delta target size mismatch');
    return result;
  };

  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    const first = pack[off];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while (pack[off - 1] & 0x80) {
      size |= (pack[off] & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    if (typeCode === 6) {
      // OFS_DELTA: negative-offset varint, base is always earlier in the pack.
      let b = pack[off++];
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const baseEntryOff = entryOff - baseOff;
      const { data: delta, consumed } = inflateAt(pack, off, size);
      off += consumed;
      deltaCount += 1;
      const baseOid = byOffset.get(baseEntryOff);
      const base = baseOid ? objects.get(baseOid) : undefined;
      if (!base) throw new Error('ofs-delta base not found in pack');
      const data = applyDelta(base.data, delta);
      const oid = objectId(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(entryOff, oid);
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base oid, then the delta.
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data: delta, consumed } = inflateAt(pack, off, size);
      off += consumed;
      deltaCount += 1;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (!base) {
        deferred.push({ baseOid, delta, offset: entryOff });
        continue;
      }
      const data = applyDelta(base.data, delta);
      const oid = objectId(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(entryOff, oid);
    } else {
      const type = TYPE_BY_CODE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, consumed } = inflateAt(pack, off, size);
      off += consumed;
      const oid = objectId(type, data);
      objects.set(oid, { type, data });
      byOffset.set(entryOff, oid);
    }
  }
  // Resolve deferred ref-deltas (base may have arrived later in the pack).
  for (const d of deferred) {
    const base = objects.get(d.baseOid) ?? resolveBase?.(d.baseOid);
    if (!base) throw new Error(`ref-delta base ${d.baseOid} not found`);
    const data = applyDelta(base.data, d.delta);
    const oid = objectId(base.type, data);
    objects.set(oid, { type: base.type, data });
    byOffset.set(d.offset, oid);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------
// Packfile writing (plain objects, deterministic order)
// ---------------------------------------------------------------------------

function encodeTypeSize(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Deflated RAW object bytes, cached per oid (objects are immutable).
 * NOTE: a pack entry holds the raw object data only — never the loose
 * `"<type> <size>\0"` header, which belongs to loose objects on disk.
 */
export function deflatedObject(repo: Repo, oid: string, obj: GitObject): Buffer {
  const cached = repo.deflated.get(oid);
  if (cached) return cached;
  const deflated = deflateSync(obj.data);
  repo.deflated.set(oid, deflated);
  return deflated;
}

/** Build a packfile from a set of objects. Deterministic: entries sorted by oid. */
export function writePack(repo: Repo, objects: Map<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = objects.get(oid)!;
    const typeCode = CODE_BY_TYPE[obj.type];
    parts.push(encodeTypeSize(typeCode, obj.data.length));
    parts.push(deflatedObject(repo, oid, obj));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

export interface FetchPlan {
  send: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
}

/**
 * Plan a fetch: which objects to send, the new shallow boundary, and which
 * old shallow commits are now fully included.
 * - wants: oids the client asked for.
 * - haves: oids the client already holds.
 * - shallowIn: the client's current shallow boundary (their parents are NOT held).
 * - depth: 0/undefined = unlimited; N = at most N generations from the wants.
 */
export function collectFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | undefined,
): FetchPlan {
  const shallowSet = new Set(shallowIn);
  // Reachable from the wants, with depth counting (commits only).
  const wantSet = new Map<string, number>(); // oid -> depth from a want
  const shallowOut: string[] = [];
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    if (wantSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    wantSet.set(oid, d);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push({ oid: c.tree, depth: d });
      const isBoundary = depth !== undefined && depth > 0 && d + 1 >= depth;
      if (isBoundary) {
        if (!shallowOut.includes(oid)) shallowOut.push(oid);
      } else {
        for (const p of c.parents) queue.push({ oid: p, depth: d + 1 });
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push({ oid: e.oid, depth: d });
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) queue.push({ oid: t.object, depth: d });
    }
  }
  // Reachable from the haves, stopping at the shallow boundary.
  const haveSet = new Set<string>();
  const hqueue: string[] = [...haves];
  while (hqueue.length) {
    const oid = hqueue.shift()!;
    if (haveSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    haveSet.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      hqueue.push(c.tree);
      if (!shallowSet.has(oid)) {
        for (const p of c.parents) hqueue.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) hqueue.push(e.oid);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) hqueue.push(t.object);
    }
  }
  // Send = wantSet minus haveSet.
  const send = new Map<string, GitObject>();
  for (const oid of wantSet.keys()) {
    if (haveSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) send.set(oid, obj);
  }
  // Unshallow: a shallow-in commit in wantSet whose parents are all in wantSet.
  const unshallow: string[] = [];
  for (const oid of shallowIn) {
    if (!wantSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c.parents.every((p) => wantSet.has(p))) unshallow.push(oid);
  }
  // Wanted refs: wants that are ref tips.
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (wants.includes(oid)) wantedRefs.push({ oid, ref });
  }
  wantedRefs.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { send, shallow: shallowOut, unshallow, wantedRefs };
}

/** Is `descendant` reachable from (or equal to) any of `ancestors`? */
export function isAncestor(repo: Repo, ancestorOid: string, descendantOid: string): boolean {
  if (ancestorOid === ZERO_OID) return true; // creating a ref: anything is a fast-forward
  if (ancestorOid === descendantOid) return true;
  const seen = new Set<string>();
  const queue = [descendantOid];
  while (queue.length) {
    const oid = queue.shift()!;
    if (oid === ancestorOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** All commits reachable from a tip, newest-first (by traversal order). */
export function reachableCommits(repo: Repo, tipOid: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tipOid];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

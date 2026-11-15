// smart.ts — git smart HTTP: info/refs, upload-pack (v2 + v0), receive-pack (v0).
// The wire contract comes from the kit's git-client.ts: pkt-line framing,
// v2 sections (acknowledgments / shallow-info / wanted-refs / packfile),
// v0 NAK/ACK + sideband, report-status with the exact ng reason
// 'non-fast-forward'. The protocol version is decided per request from the
// Git-Protocol header: 'version=2' -> v2, anything else -> v0. Receive-pack
// is always v0 (the client never asks it for v2, and refuses a v2 answer).

import { collectFetch, isAncestor, parseTag, readPack, writePack } from './git.ts';
import { decodeAll, pktLine, pktLines, sidebandPackets, DELIM, FLUSH, type Packet } from './pkt.ts';
import { type Repo, type Store, ZERO_OID } from './store.ts';

const AGENT = 'qjack-forge/1.0.0';
const UPLOAD_CAPS_V0 = `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): HttpResult {
  return { status: 200, contentType, body };
}

function notFound(message = 'Not Found'): HttpResult {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function badRequest(message: string): HttpResult {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        entry.peeled = parseTag(obj.data).object;
      }
    }
    out.push(entry);
  }
  return out;
}

function headOid(repo: Repo): string {
  return repo.refs.get('refs/heads/main') ?? ZERO_OID;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): HttpResult {
  const repo = store.getRepoForOwner(owner, repoName);
  if (!repo) return notFound();
  const serviceLine = `# service=${service}\n`;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const body = pktLines([
      serviceLine,
      'flush',
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow filter unborn\n',
      `agent=${AGENT}\n`,
      'object-format=sha1\n',
      'flush',
    ]);
    return ok('application/x-git-upload-pack-advertisement', body);
  }
  // v0 advertisement (receive-pack is always v0).
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const lines: Array<string | 'flush'> = [serviceLine, 'flush'];
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headOid(repo)} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      if (r.peeled) lines.push(`${r.peeled} ${r.name}^{}\n`);
    }
  }
  lines.push('flush');
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  return ok(contentType, pktLines(lines));
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  filter?: string;
}

function parseTextLines(packets: Packet[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  }
  return out;
}

/** The ls-refs response for v2, honouring ref-prefix filters. */
function lsRefsResponse(repo: Repo, prefixes: string[]): Buffer {
  const match = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Array<string | 'flush'> = [];
  const refs = refLines(repo);
  if (refs.length === 0) {
    if (match('HEAD')) lines.push('unborn HEAD symref-target:refs/heads/main\n');
  } else {
    if (match('HEAD')) lines.push(`${headOid(repo)} HEAD symref-target:refs/heads/main\n`);
    for (const r of refs) {
      if (!match(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (r.peeled) line += ` peeled:${r.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

function fetchResponse(repo: Repo, req: FetchRequest, v2: boolean): Buffer {
  // Full-response cache: an identical fetch (same version, wants, haves,
  // shallow, depth) on an unchanged repo answers byte-identically, so the
  // 50 concurrent shallow clones pay the traversal + framing only once.
  // The response is deterministic (no clock, no randomness), and every
  // mutation path clears fetchCache alongside packCache.
  const cacheKey = JSON.stringify([v2 ? 2 : 0, req.wants, req.haves, req.shallow, req.depth ?? 0]);
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) return cached;
  const plan = collectFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  // Pack cache: identical fetch, identical pack (the 50 concurrent shallow
  // clones all fetch the same tip, so 49 of them reuse the first pack).
  const packKey = JSON.stringify([req.wants, req.haves, req.shallow, req.depth ?? 0]);
  let packBytes = repo.packCache.get(packKey);
  if (!packBytes) {
    packBytes = writePack(repo, plan.send);
    repo.packCache.set(packKey, packBytes);
  }

  let response: Buffer;
  if (v2) {
    const parts: Buffer[] = [];
    const ackLines: string[] = [];
    let acked = false;
    for (const h of req.haves) {
      if (repo.objects.has(h)) {
        ackLines.push(`ACK ${h}\n`);
        acked = true;
      }
    }
    if (!acked) ackLines.push('NAK\n');
    parts.push(pktLines(['acknowledgments\n', ...ackLines, 'delim']));
    if (plan.shallow.length || plan.unshallow.length) {
      const lines: Array<string | 'delim'> = ['shallow-info\n'];
      for (const s of plan.shallow) lines.push(`shallow ${s}\n`);
      for (const u of plan.unshallow) lines.push(`unshallow ${u}\n`);
      lines.push('delim');
      parts.push(pktLines(lines));
    }
    if (plan.wantedRefs.length) {
      const lines: Array<string | 'delim'> = ['wanted-refs\n'];
      for (const w of plan.wantedRefs) lines.push(`${w.oid} ${w.ref}\n`);
      lines.push('delim');
      parts.push(pktLines(lines));
    }
    parts.push(pktLines(['packfile\n']));
    parts.push(sidebandPackets(packBytes, 1));
    parts.push(FLUSH);
    response = Buffer.concat(parts);
  } else {
    // v0: NAK/ACK + shallow lines, then sideband pack packets, then flush.
    const parts: Buffer[] = [];
    let acked = false;
    for (const h of req.haves) {
      if (repo.objects.has(h)) {
        parts.push(pktLine(`ACK ${h}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(sidebandPackets(packBytes, 1));
    parts.push(FLUSH);
    response = Buffer.concat(parts);
  }
  repo.fetchCache.set(cacheKey, response);
  return response;
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): HttpResult {
  const repo = store.getRepoForOwner(owner, repoName);
  if (!repo) return notFound();
  const { packets } = decodeAll(body);
  if (packets.length === 0) return badRequest('not a pkt-line stream');
  const lines = parseTextLines(packets);

  if (gitProtocol === 'version=2') {
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      const prefixes: string[] = [];
      for (const line of lines.slice(1)) {
        if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
      }
      return ok('application/x-git-upload-pack-result', lsRefsResponse(repo, prefixes));
    }
    if (command === 'command=fetch') {
      const req: FetchRequest = { wants: [], haves: [], shallow: [] };
      for (const line of lines.slice(1)) {
        const t = line.trim();
        if (t.startsWith('want ')) req.wants.push(t.slice(5).trim());
        else if (t.startsWith('have ')) req.haves.push(t.slice(5).trim());
        else if (t.startsWith('shallow ')) req.shallow.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) {
          const n = parseInt(t.slice(7).trim(), 10);
          if (Number.isFinite(n)) req.depth = n;
        } else if (t.startsWith('filter ')) req.filter = t.slice(7).trim();
      }
      if (!req.wants.length) return badRequest('fetch without wants');
      return ok('application/x-git-upload-pack-result', fetchResponse(repo, req, true));
    }
    return badRequest(`unknown v2 command ${JSON.stringify(command)}`);
  }

  // v0 fetch: wants+shallow+deepen, flush, haves+done, flush.
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    const t = line.trim();
    // The first want line may carry capabilities after a NUL.
    const nul = t.indexOf('\0');
    const clean = nul >= 0 ? t.slice(0, nul) : t;
    if (clean.startsWith('want ')) req.wants.push(clean.slice(5).trim());
    else if (clean.startsWith('have ')) req.haves.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) req.shallow.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) {
      const n = parseInt(clean.slice(7).trim(), 10);
      if (Number.isFinite(n)) req.depth = n;
    }
  }
  if (!req.wants.length) return badRequest('fetch without wants');
  return ok('application/x-git-upload-pack-result', fetchResponse(repo, req, false));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): HttpResult {
  const repo = store.getRepoForOwner(owner, repoName);
  if (!repo) return notFound();
  const { packets, rest } = decodeAll(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').trim();
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) return badRequest('bad receive-pack command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (!commands.length) return badRequest('empty push');

  // Unpack first: objects land even when a ref update is refused.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const read = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, obj);
          repo.packCache.clear();
          repo.fetchCache.clear();
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const c of commands) report.push({ ref: c.ref, ok: false, reason: unpackDetail });
  } else {
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push({ ref: c.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
          report.push({ ref: c.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(c.ref);
          report.push({ ref: c.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(c.newOid)) {
        report.push({ ref: c.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        // Create: old must be zero.
        if (c.oldOid !== ZERO_OID) {
          report.push({ ref: c.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.set(c.ref, c.newOid);
          report.push({ ref: c.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update: old must match, and the new tip must descend from the old.
      if (c.oldOid !== current) {
        report.push({ ref: c.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (!isAncestor(repo, current, c.newOid)) {
        report.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      report.push({ ref: c.ref, ok: true, reason: '' });
    }
    repo.packCache.clear();
    repo.fetchCache.clear();
  }

  const reportLines: Array<string | 'flush'> = [
    unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`,
  ];
  for (const r of report) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  reportLines.push('flush');
  const reportStream = pktLines(reportLines);
  return ok('application/x-git-receive-pack-result', sidebandPackets(reportStream, 1));
}

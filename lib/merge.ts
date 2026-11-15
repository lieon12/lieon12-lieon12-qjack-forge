// merge.ts — shared pull-request logic: merge-base, mergeability, squash
// merge, and the changed-files diff. Used by REST, GraphQL and MCP so the
// three surfaces always agree about what a merge does.

import { buildCommit, buildTreeFromFiles, flattenTree, parseCommit } from './git.ts';
import {
  FORGE_IDENTITY,
  trialNowSeconds,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

/** The merge-base of two tips: the first commit reachable from both. */
export function mergeBaseOf(repo: Repo, headTip: string, baseTip: string): string | null {
  const headAncestors = new Set<string>();
  const q = [headTip];
  while (q.length) {
    const oid = q.shift()!;
    if (headAncestors.has(oid)) continue;
    headAncestors.add(oid);
    const o = repo.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) q.push(p);
  }
  const q2 = [baseTip];
  const seen = new Set<string>();
  while (q2.length) {
    const oid = q2.shift()!;
    if (headAncestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = repo.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) q2.push(p);
  }
  return null;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

/** MERGEABLE when no path changed on both sides to different bytes. */
export function computeMergeable(repo: Repo, pull: Pull): string {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBaseOf(repo, headTip, baseTip);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const baseTipFiles = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const baseFiles = base
    ? flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree)
    : new Map<string, { oid: string; mode: string }>();
  for (const path of new Set([...headFiles.keys(), ...baseFiles.keys(), ...baseTipFiles.keys()])) {
    const h = headFiles.get(path);
    const b0 = baseFiles.get(path);
    const b1 = baseTipFiles.get(path);
    const headChanged = (h?.oid ?? null) !== (b0?.oid ?? null);
    const baseChanged = (b1?.oid ?? null) !== (b0?.oid ?? null);
    if (headChanged && baseChanged && (h?.oid ?? null) !== (b1?.oid ?? null)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** The paths a pull request changes (head vs merge-base), sorted. */
export function pullFilePaths(repo: Repo, pull: Pull): string[] {
  const base = mergeBaseOf(repo, pull.head.sha, pull.base.sha);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(pull.head.sha)!.data).tree);
  const baseFiles = base
    ? flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree)
    : new Map<string, { oid: string; mode: string }>();
  const out: string[] = [];
  for (const path of new Set([...headFiles.keys(), ...baseFiles.keys()])) {
    const h = headFiles.get(path);
    const b = baseFiles.get(path);
    if ((h?.oid ?? null) !== (b?.oid ?? null)) out.push(path);
  }
  return out.sort();
}

/** The changed-files list for GET /pulls/{n}/files. */
export function pullChangedFiles(
  repo: Repo,
  pull: Pull,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const base = mergeBaseOf(repo, pull.head.sha, pull.base.sha);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(pull.head.sha)!.data).tree);
  const baseFiles = base
    ? flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree)
    : new Map<string, { oid: string; mode: string }>();
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of [...paths].sort()) {
    const h = headFiles.get(path);
    const b = baseFiles.get(path);
    if (h && !b) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (!h && b) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (h && b && h.oid !== b.oid) {
      const hd = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const bd = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(hd);
      const deletions = countLines(bd);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export type SquashResult =
  | { ok: true; commitSha: string }
  | { ok: false; status: number; message: string };

/**
 * Squash-merge an open pull request: one commit on the base branch, parent =
 * base tip, tree = base tip tree with the head's changes applied. Marks the
 * pull closed + merged. Returns 405 on a conflict, 422 when a branch is gone.
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): SquashResult {
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'pull request is not open' };
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return { ok: false, status: 422, message: 'head or base branch does not exist' };
  if (computeMergeable(repo, pull) === 'CONFLICTING') {
    return { ok: false, status: 405, message: 'merge conflict' };
  }
  const base = mergeBaseOf(repo, headTip, baseTip);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const baseTipFiles = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const baseFiles = base
    ? flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree)
    : new Map<string, { oid: string; mode: string }>();
  const merged = new Map(baseTipFiles);
  for (const [path, entry] of headFiles) {
    const b0 = baseFiles.get(path);
    if ((entry.oid ?? null) !== (b0?.oid ?? null)) merged.set(path, entry);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path) && baseTipFiles.has(path) && !merged.has(path)) merged.delete(path);
  }
  const put = (type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string =>
    store.putObject(repo, type, data);
  const treeOid = buildTreeFromFiles(repo, merged, put);
  const stamp = `${trialNowSeconds()} +0000`;
  const who = `${FORGE_IDENTITY} ${stamp}`;
  const commitSha = put('commit', buildCommit(treeOid, [baseTip], who, who, pull.title));
  repo.refs.set(`refs/heads/${pull.base.ref}`, commitSha);
  repo.packCache.clear();
  repo.fetchCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = new Date(trialNowSeconds() * 1000).toISOString();
  pull.merge_commit_sha = commitSha;
  pull.base.sha = commitSha;
  return { ok: true, commitSha };
}

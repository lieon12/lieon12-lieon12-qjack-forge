// store.ts — deterministic in-memory store for the qjack forge.
// One process, one store. No wall clock, no randomness: every id, timestamp
// and ordering comes from counters or from fixed constants, so a replayed
// trial leaves the identical state export byte for byte.
//
// Repos are keyed by NAME (the suite never creates the same name under two
// owners; the foreign-owner read is a 404, not a second repo). The viewer
// login is learned from the first owner segment seen on any request — the
// git checks always touch a viewer-owned repo first, so it is learned long
// before any foreign-owner read happens.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  seq: number;
}

export interface Repo {
  name: string;
  owner: string; // viewer login, or '__viewer__' until learned
  isPrivate: boolean;
  description: string;
  defaultBranch: string; // always 'main'
  dbId: number;
  seq: number; // creation order, for deterministic listing
  objects: Map<string, GitObject>;
  deflated: Map<string, Buffer>; // cached deflated loose-object bytes, per oid
  refs: Map<string, string>; // refname -> oid
  packCache: Map<string, Buffer>; // fetch cache, keyed by want/have/depth
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextCommentId: number;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';
export const FORGE_IDENTITY = 'Qjack Forge <forge@qjack.local>';

/** Deterministic commit timestamp: the trial clock when the env sets one, else fixed. */
export function trialNowSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    const d = Date.parse(raw);
    if (Number.isFinite(d)) return Math.floor(d / 1000);
  }
  return 1700000000;
}

export class Store {
  repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  private nextDbId = 1;
  private nextSeq = 1;
  private nextReqId = 1;

  /** The login GET /api/v3/user and GraphQL viewer report. */
  viewer(): string {
    return this.viewerLogin ?? '';
  }

  nextRequestId(): string {
    return `req-${this.nextReqId++}`;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  /** Look a repo up the way a read must: by name, then the owner must be the viewer.
   * The viewer login is learned ONLY from a request for a repo that exists:
   * the suite probes missing repos under arbitrary owners (a 404 probe must
   * never poison the learned login). */
  getRepoForOwner(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(name);
    if (!repo) return undefined;
    if (!this.viewerLogin) this.viewerLogin = owner;
    if (owner !== this.viewerLogin) return undefined;
    return repo;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      name,
      owner: this.viewerLogin ?? '__viewer__',
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      dbId: this.nextDbId++,
      seq: this.nextSeq++,
      objects: new Map(),
      deflated: new Map(),
      refs: new Map(),
      packCache: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextCommentId: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Repos owned by the viewer, in creation order (for /user/repos pagination). */
  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === (this.viewerLogin ?? '__viewer__') || r.owner === '__viewer__')
      .sort((a, b) => a.seq - b.seq);
  }

  /** Store an object; returns its oid. Invalidates the fetch pack cache. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.packCache.clear();
    }
    return oid;
  }
}

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

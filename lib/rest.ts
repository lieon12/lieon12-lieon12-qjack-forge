// rest.ts — the GitHub REST v3 surface.
// Every reply is JSON with an X-GitHub-Request-Id (added by app.ts).
// Auth is enforced by app.ts before this runs. Unknown route -> 404 JSON,
// malformed JSON body -> 400 JSON (also app.ts). Status codes are the
// contract: 201 create, 200 read/update, 204 delete, 401 auth, 404 absent
// or foreign owner, 405 conflicted merge, 409 stale sha, 422 bad ref/label.

import {
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  parseCommit,
  parseTree,
  reachableCommits,
} from './git.ts';
import { pullChangedFiles, squashMerge } from './merge.ts';
import {
  FORGE_IDENTITY,
  trialNowSeconds,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  ZERO_OID,
} from './store.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  store: Store;
  method: string;
  segments: string[]; // path after /api/v3, decoded, no empty parts
  query: URLSearchParams;
  body: unknown; // parsed JSON, or null when there is no body
  baseUrl: string; // e.g. http://127.0.0.1:PORT — for absolute Link URLs
}

const ok = (json: unknown, status = 200, headers?: Record<string, string>): RestResult => ({
  status,
  json,
  headers,
});
const err = (status: number, message: string): RestResult => ({ status, json: { message } });
const notFound = (): RestResult => err(404, 'Not Found');

function nowIso(): string {
  return new Date(trialNowSeconds() * 1000).toISOString();
}

function b64encodeId(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewer() || repo.owner;
  return {
    id: repo.dbId,
    node_id: b64encodeId('Repository', String(repo.dbId)),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.dbId, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${owner}/${repo.name}`,
    url: `/repos/${owner}/${repo.name}`,
    created_at: nowIso(),
    updated_at: nowIso(),
    pushed_at: nowIso(),
    git_url: `git://${owner}/${repo.name}.git`,
    ssh_url: `git@${owner}/${repo.name}.git`,
    clone_url: `https://${owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + issue.number,
    node_id: b64encodeId('Issue', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: store.viewer() || repo.owner },
    created_at: nowIso(),
    updated_at: nowIso(),
    comments: issue.comments.length,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + pull.number,
    node_id: b64encodeId('PullRequest', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${store.viewer() || repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${store.viewer() || repo.owner}:${pull.base.ref}` },
    user: { login: store.viewer() || repo.owner },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function refJson(ref: string, sha: string): Record<string, unknown> {
  return { ref, object: { sha, type: 'commit', url: '' } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bodyObj(ctx: RestContext): Record<string, unknown> | null {
  if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return null;
  return ctx.body as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** The repo for /repos/{owner}/{name}..., or null (404, incl. foreign owner). */
function repoFor(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepoForOwner(owner, name);
  return repo ?? null;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Create a commit on a branch (creating the branch from the default tip when needed). */
function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  files: Map<string, { oid: string; mode: string }>,
): string {
  const put = (type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string =>
    store.putObject(repo, type, data);
  const treeOid = buildTreeFromFiles(repo, files, put);
  const tip = branchTip(repo, branch);
  const parents = tip && tip !== ZERO_OID ? [tip] : [];
  const stamp = `${trialNowSeconds()} +0000`;
  const who = `${FORGE_IDENTITY} ${stamp}`;
  const commitOid = put(
    'commit',
    buildCommit(treeOid, parents, who, who, message),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.packCache.clear();
  return commitOid;
}

function currentFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> | null {
  const tip = branchTip(repo, branch);
  if (!tip) return null;
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return null;
  return flattenTree(repo, parseCommit(obj.data).tree);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RestContext): RestResult {
  const { store, method, segments: s } = ctx;

  // GET /api/v3/  (and /api/v3)
  if (s.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      {
        current_user_url: `${ctx.baseUrl}/api/v3/user`,
        rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
      },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user') {
    if (method !== 'GET') return notFound();
    return ok({ login: store.viewer(), id: 1, type: 'User' });
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const name = str(b?.name);
      if (!name) return err(422, 'name is required');
      const repo = store.createRepo(name, b?.private === true, str(b?.description));
      if (!repo) return err(422, 'name already exists on this account');
      return ok(repoJson(store, repo), 201);
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, num(ctx.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, num(ctx.query.get('page') ?? '1') || 1);
      const all = store.viewerRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `${ctx.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const lastPage = Math.ceil(all.length / perPage);
        const last = `${ctx.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
        headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
      }
      return ok(slice.map((r) => repoJson(store, r)), 200, headers);
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{name}...
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1];
    const name = s[2];
    const repo = repoFor(ctx, owner, name);
    if (!repo) return notFound();
    const tail = s.slice(3);

    // The repo itself.
    if (tail.length === 0) {
      if (method === 'GET') return ok(repoJson(store, repo));
      if (method === 'PATCH') {
        const b = bodyObj(ctx);
        if (typeof b?.description === 'string') repo.description = b.description;
        if (typeof b?.private === 'boolean') repo.isPrivate = b.private;
        return ok(repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(name);
        return { status: 204, json: null };
      }
      return notFound();
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2) {
        if (method !== 'POST') return notFound();
        const b = bodyObj(ctx);
        const ref = str(b?.ref);
        const sha = str(b?.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          return err(422, 'ref and sha are required');
        }
        if (!repo.objects.has(sha)) return err(422, 'sha does not exist');
        if (repo.refs.has(ref)) return err(422, 'ref already exists');
        repo.refs.set(ref, sha);
        repo.packCache.clear();
        return ok(refJson(ref, sha), 201);
      }
      if (tail.length >= 4 && tail[2] === 'heads') {
        if (method !== 'GET') return notFound();
        const branch = tail.slice(3).join('/');
        const tip = branchTip(repo, branch);
        if (!tip) return notFound();
        return ok(refJson(`refs/heads/${branch}`, tip));
      }
      return notFound();
    }

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return notFound();
        const list = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha } }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return ok(list);
      }
      if (tail.length >= 2) {
        if (method !== 'GET') return notFound();
        const branch = tail.slice(1).join('/');
        const tip = branchTip(repo, branch);
        if (!tip) return notFound();
        return ok({ name: branch, commit: { sha: tip } });
      }
      return notFound();
    }

    // commits
    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return notFound();
      const shaParam = ctx.query.get('sha');
      const tip = shaParam
        ? (branchTip(repo, shaParam) ?? (/^[0-9a-f]{40}$/.test(shaParam) ? shaParam : undefined))
        : branchTip(repo, repo.defaultBranch);
      if (!tip) return ok([]);
      const commits = reachableCommits(repo, tip).map((oid) => {
        const obj = repo.objects.get(oid)!;
        const c = parseCommit(obj.data);
        return { sha: oid, commit: { message: c.message, tree: { sha: c.tree } } };
      });
      return ok(commits);
    }

    // contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      const refParam = ctx.query.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      if (method === 'GET') {
        const files = currentFiles(repo, branch);
        if (!files) return notFound();
        const tip = branchTip(repo, branch);
        const rootTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : '';
        if (path === '') {
          // Root directory listing.
          const entries = dirListing(repo, files, '', rootTree);
          return ok(entries);
        }
        const entry = files.get(path);
        if (entry) {
          const obj = repo.objects.get(entry.oid)!;
          return ok({
            type: 'file',
            encoding: 'base64',
            size: obj.data.length,
            name: path.split('/').pop(),
            path,
            content: obj.data.toString('base64'),
            sha: entry.oid,
          });
        }
        // Maybe a directory.
        const prefix = `${path}/`;
        let isDir = false;
        for (const p of files.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
        if (!isDir) return notFound();
        return ok(dirListing(repo, files, path, rootTree));
      }
      if (method === 'PUT') {
        const b = bodyObj(ctx);
        if (!b) return err(400, 'body must be JSON');
        const message = str(b.message) || 'Update file';
        const contentB64 = str(b.content);
        if (!contentB64) return err(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const putBranch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const files = currentFiles(repo, putBranch);
        const existing = files?.get(path);
        const givenSha = typeof b.sha === 'string' ? b.sha : undefined;
        if (givenSha !== undefined) {
          if (!existing || existing.oid !== givenSha) return err(409, 'sha does not match the current file');
        }
        const isUpdate = existing !== undefined;
        const blobOid = store.putObject(repo, 'blob', content);
        const nextFiles = new Map(files ?? []);
        nextFiles.set(path, { oid: blobOid, mode: '100644' });
        const commitSha = commitOnBranch(store, repo, putBranch, message, nextFiles);
        return ok(
          {
            content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64' },
            commit: { sha: commitSha, message },
          },
          isUpdate ? 200 : 201,
        );
      }
      if (method === 'DELETE') {
        const b = bodyObj(ctx);
        const files = currentFiles(repo, branch);
        const existing = files?.get(path);
        if (!existing) return notFound();
        const givenSha = typeof b?.sha === 'string' ? b.sha : undefined;
        if (givenSha !== undefined && givenSha !== existing.oid) {
          return err(409, 'sha does not match the current file');
        }
        const nextFiles = new Map(files!);
        nextFiles.delete(path);
        const message = str(b?.message) || 'Delete file';
        const commitSha = commitOnBranch(store, repo, branch, message, nextFiles);
        return ok({ commit: { sha: commitSha, message } });
      }
      return notFound();
    }

    // labels
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method !== 'POST') return notFound();
      const b = bodyObj(ctx);
      const labelName = str(b?.name);
      if (!labelName) return err(422, 'name is required');
      const color = str(b?.color) || 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      return ok({ name: labelName, color }, 201);
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const b = bodyObj(ctx);
          if (!b) return err(400, 'body must be JSON');
          const title = str(b.title);
          if (!title) return err(422, 'title is required');
          const rawLabels = Array.isArray(b.labels) ? b.labels : [];
          const labelNames: string[] = [];
          for (const l of rawLabels) {
            const labelName = typeof l === 'string' ? l : typeof l === 'object' && l !== null ? str((l as Record<string, unknown>).name) : '';
            if (!labelName) continue;
            if (!repo.labels.has(labelName)) return err(422, `label does not exist: ${labelName}`);
            labelNames.push(labelName);
          }
          const issue: Issue = {
            number: repo.issues.length + 1,
            title,
            body: str(b.body),
            state: 'open',
            labels: labelNames,
            comments: [],
            seq: repo.issues.length + 1,
          };
          repo.issues.push(issue);
          return ok(issueJson(store, repo, issue), 201);
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          const perPage = Math.max(1, Math.min(100, num(ctx.query.get('per_page') ?? '30') || 30));
          const page = Math.max(1, num(ctx.query.get('page') ?? '1') || 1);
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const start = (page - 1) * perPage;
          return ok(list.slice(start, start + perPage).map((i) => issueJson(store, repo, i)));
        }
        return notFound();
      }
      const issueNo = parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === issueNo);
      if (tail.length === 2) {
        if (!issue) return notFound();
        if (method === 'GET') return ok(issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const b = bodyObj(ctx);
          if (b && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
          if (b && typeof b.title === 'string') issue.title = b.title;
          if (b && typeof b.body === 'string') issue.body = b.body;
          return ok(issueJson(store, repo, issue));
        }
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) return notFound();
        if (method === 'GET') {
          return ok(issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: nowIso() })));
        }
        if (method === 'POST') {
          const b = bodyObj(ctx);
          if (!b || typeof b.body !== 'string') return err(422, 'body is required');
          const comment = { id: repo.nextCommentId++, body: b.body, seq: repo.nextCommentId };
          issue.comments.push(comment);
          return ok({ id: comment.id, body: comment.body, created_at: nowIso() }, 201);
        }
        return notFound();
      }
      return notFound();
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const b = bodyObj(ctx);
          if (!b) return err(400, 'body must be JSON');
          const head = str(b.head);
          const base = str(b.base) || repo.defaultBranch;
          const title = str(b.title);
          if (!head || !title) return err(422, 'head and title are required');
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
          const dup = repo.pulls.find((p) => p.state === 'open' && p.head.ref === head);
          if (dup) return err(422, 'a pull request is already open for this head');
          const pull: Pull = {
            number: repo.pulls.length + 1,
            title,
            body: str(b.body),
            state: 'open',
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            head: { ref: head, sha: headSha },
            base: { ref: base, sha: baseSha },
            seq: repo.pulls.length + 1,
          };
          repo.pulls.push(pull);
          return ok(pullJson(store, repo, pull), 201);
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          return ok(list.map((p) => pullJson(store, repo, p)));
        }
        return notFound();
      }
      const pullNo = parseInt(tail[1], 10);
      const pull = repo.pulls.find((p) => p.number === pullNo);
      if (tail.length === 2) {
        if (!pull) return notFound();
        if (method !== 'GET') return notFound();
        return ok(pullJson(store, repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (!pull) return notFound();
        if (method !== 'GET') return notFound();
        return ok(pullChangedFiles(repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (!pull) return notFound();
        if (method !== 'PUT') return notFound();
        const merged = squashMerge(store, repo, pull);
        if (!merged.ok) return err(merged.status, merged.message);
        return ok({ merged: true, sha: merged.commitSha, message: `Merged pull request #${pull.number}` });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Directory listing + pull files + merge
// ---------------------------------------------------------------------------

function dirListing(
  repo: Repo,
  files: Map<string, { oid: string; mode: string }>,
  dir: string,
  rootTreeOid: string,
): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; oid: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { type: 'file', oid: entry.oid });
    } else {
      seen.set(rest.slice(0, slash), { type: 'dir', oid: '' });
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of [...seen.keys()].sort()) {
    const info = seen.get(name)!;
    let sha = info.oid;
    if (info.type === 'dir') {
      sha = dirTreeOid(repo, rootTreeOid, dir === '' ? name : `${dir}/${name}`) ?? '';
    }
    out.push({
      type: info.type,
      name,
      path: prefix + name,
      sha,
      size: info.type === 'file' ? (repo.objects.get(info.oid)?.data.length ?? 0) : 0,
    });
  }
  return out;
}

function dirTreeOid(repo: Repo, rootTreeOid: string, dirPath: string): string | null {
  let treeOid = rootTreeOid;
  for (const part of dirPath.split('/')) {
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

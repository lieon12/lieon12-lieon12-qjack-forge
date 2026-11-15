// graphql.ts — the GitHub GraphQL v4 surface.
// The suite sends a fixed set of documents (query + mutation + batching +
// introspection), so this is a small parser + executor for exactly that
// subset: fields, aliases, arguments (literals, variables, lists, objects),
// inline fragments, __type introspection. Global ids are opaque base64 of a
// type prefix + numeric id, stable across reads, decodable for mutations.
// Unknown fields answer HTTP 200 with an errors array naming the field.

import { flattenTree, parseCommit } from './git.ts';
import { computeMergeable, mergeBaseOf, pullFilePaths, squashMerge } from './merge.ts';
import { FORGE_IDENTITY, trialNowSeconds, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// Mini parser
// ---------------------------------------------------------------------------

type Value =
  | string
  | number
  | boolean
  | null
  | { __var: string }
  | { __enum: string }
  | Value[]
  | { [key: string]: Value };

interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[] | null;
  fragmentType: string | null; // for `... on Type { }`
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():![]$='.includes(c) || c === ':') {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_\-]/.test(src[j])) j += 1;
    if (j === i) {
      // Unknown character: skip it.
      i += 1;
      continue;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string | undefined {
    return this.tokens[this.pos++];
  }
  private expect(tok: string): void {
    const t = this.next();
    if (t !== tok) throw new Error(`expected ${tok}, got ${t ?? 'eof'}`);
  }

  parseDocument(): { operation: string; selections: Selection[] } {
    let operation = 'query';
    let t = this.peek();
    if (t === 'query' || t === 'mutation') {
      operation = this.next()!;
      t = this.peek();
      // Optional operation name.
      if (t !== undefined && t !== '{' && t !== '(') this.next();
      // Optional variable definitions: ($x: Type, ...).
      if (this.peek() === '(') this.skipBalanced('(', ')');
    }
    this.expect('{');
    const selections = this.parseSelections();
    this.expect('}');
    return { operation, selections };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const t = this.next();
      if (t === undefined) return;
      if (t === open) depth += 1;
      else if (t === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelections(): Selection[] {
    const out: Selection[] = [];
    while (this.peek() !== undefined && this.peek() !== '}') {
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next() ?? null;
      } else {
        // Named fragment spread: skip the name; the fragment itself is
        // defined elsewhere and not used by the suite's documents.
        this.next();
      }
      this.expect('{');
      const inner = this.parseSelections();
      this.expect('}');
      // An inline fragment contributes its selections directly.
      return { alias: null, name: '', args: {}, selections: inner, fragmentType };
    }
    let name = this.next()!;
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next()!;
    }
    const args: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const key = this.next()!;
        this.expect(':');
        args[key] = this.parseValue();
        if (this.peek() === ',') this.next();
      }
      this.next();
    }
    let selections: Selection[] | null = null;
    if (this.peek() === '{') {
      this.next();
      selections = this.parseSelections();
      this.expect('}');
    }
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): Value {
    const t = this.next()!;
    if (t === '$') {
      return { __var: this.next()! };
    }
    if (t === '[') {
      const list: Value[] = [];
      while (this.peek() !== ']') {
        list.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.next();
      return list;
    }
    if (t === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next()!;
        this.expect(':');
        obj[key] = this.parseValue();
        if (this.peek() === ',') this.next();
      }
      this.next();
      return obj;
    }
    if (t.startsWith('"')) {
      return JSON.parse(t) as string;
    }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) return n;
    return { __enum: t };
  }
}

function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object' && '__var' in (v as Record<string, unknown>)) {
    return variables[(v as { __var: string }).__var];
  }
  if (v !== null && typeof v === 'object' && '__enum' in (v as Record<string, unknown>)) {
    return (v as { __enum: string }).__enum;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, variables));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveValue(x, variables);
    return out;
  }
  return v;
}

function arg(sel: Selection, name: string, variables: Record<string, unknown>): unknown {
  if (!(name in sel.args)) return undefined;
  return resolveValue(sel.args[name], variables);
}

// ---------------------------------------------------------------------------
// Global ids (opaque, stable, decodable)
// ---------------------------------------------------------------------------

function gid(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; id: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), id: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', String(repo.dbId));
}
function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', `${repo.dbId}:${issue.number}`);
}
function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', `${repo.dbId}:${pull.number}`);
}
function commentGid(repo: Repo, commentId: number): string {
  return gid('IssueComment', `${repo.dbId}:${commentId}`);
}

function repoByGid(store: Store, id: string): Repo | null {
  const d = ungid(id);
  if (!d || d.kind !== 'Repository') return null;
  const dbId = parseInt(d.id, 10);
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

// ---------------------------------------------------------------------------
// Introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'closedAt', 'comments', 'labels', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  SearchType: [],
};
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function fieldError(ctx: Ctx, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

type Obj =
  | { __type: 'Query' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'User'; login: string }
  | { __type: 'BranchRef'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullConnection'; repo: Repo; pulls: Pull[] }
  | { __type: 'FileConnection'; files: string[] }
  | { __type: 'Type'; name: string }
  | { __type: 'MutationIssue'; repo: Repo; issue: Issue }
  | { __type: 'MutationPull'; repo: Repo; pull: Pull }
  | { __type: 'CommentEdge'; repo: Repo; commentId: number; body: string };

function resolveSelections(ctx: Ctx, obj: Obj, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    // Inline fragments: apply when the type matches (or unconditionally
    // when the fragment has no type condition in these documents).
    if (sel.name === '' && sel.selections) {
      if (sel.fragmentType === null || fragmentApplies(obj, sel.fragmentType)) {
        Object.assign(out, resolveSelections(ctx, obj, sel.selections));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = resolveField(ctx, obj, sel);
  }
  return out;
}

function fragmentApplies(obj: Obj, typeName: string): boolean {
  const map: Record<string, string> = {
    Repository: 'Repository',
    Issue: 'Issue',
    PullRequest: 'PullRequest',
  };
  return map[typeName] === obj.__type;
}

function issueCursor(n: number): string {
  return Buffer.from(String(n), 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const n = parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveField(ctx: Ctx, obj: Obj, sel: Selection): unknown {
  const { store } = ctx;
  switch (obj.__type) {
    case 'Query': {
      if (sel.name === 'viewer') {
        const login = store.viewer();
        if (!sel.selections) return { login };
        return resolveSelections(ctx, { __type: 'User', login }, sel.selections);
      }
      if (sel.name === 'repository') {
        const owner = String(arg(sel, 'owner', ctx.variables) ?? '');
        const name = String(arg(sel, 'name', ctx.variables) ?? '');
        const repo = store.getRepoForOwner(owner, name);
        if (!repo) return null;
        if (!sel.selections) return {};
        return resolveSelections(ctx, { __type: 'Repository', repo }, sel.selections);
      }
      if (sel.name === 'node') {
        const id = String(arg(sel, 'id', ctx.variables) ?? '');
        const d = ungid(id);
        if (!d) return null;
        if (d.kind === 'Repository') {
          const repo = repoByGid(store, id);
          if (!repo) return null;
          if (!sel.selections) return { id };
          return resolveSelections(ctx, { __type: 'Repository', repo }, sel.selections);
        }
        if (d.kind === 'Issue') {
          const [dbId, num] = d.id.split(':');
          for (const repo of store.repos.values()) {
            if (repo.dbId !== parseInt(dbId, 10)) continue;
            const issue = repo.issues.find((i) => i.number === parseInt(num, 10));
            if (!issue) return null;
            if (!sel.selections) return { id };
            return resolveSelections(ctx, { __type: 'Issue', repo, issue }, sel.selections);
          }
          return null;
        }
        return null;
      }
      if (sel.name === '__type') {
        const name = String(arg(sel, 'name', ctx.variables) ?? '');
        if (!(name in TYPE_FIELDS) && name !== 'SearchType') return null;
        if (!sel.selections) return { name };
        return resolveSelections(ctx, { __type: 'Type', name }, sel.selections);
      }
      fieldError(ctx, 'Query', sel.name);
      return null;
    }
    case 'Repository': {
      const repo = obj.repo;
      switch (sel.name) {
        case 'id': return repoGid(repo);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.viewer() || repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'url': return `/${store.viewer() || repo.owner}/${repo.name}`;
        case 'createdAt': return '2026-11-15T00:00:00Z';
        case 'owner': {
          const login = store.viewer() || repo.owner;
          if (!sel.selections) return { login };
          return resolveSelections(ctx, { __type: 'User', login }, sel.selections);
        }
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          if (!sel.selections) return { name: repo.defaultBranch };
          return resolveSelections(ctx, { __type: 'BranchRef', name: repo.defaultBranch }, sel.selections);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const n = Number(arg(sel, 'number', ctx.variables));
          const issue = repo.issues.find((i) => i.number === n);
          if (!issue) return null;
          if (!sel.selections) return {};
          return resolveSelections(ctx, { __type: 'Issue', repo, issue }, sel.selections);
        }
        case 'issues': {
          const first = Number(arg(sel, 'first', ctx.variables) ?? 100);
          const after = arg(sel, 'after', ctx.variables);
          const states = arg(sel, 'states', ctx.variables);
          const orderBy = (arg(sel, 'orderBy', ctx.variables) ?? {}) as Record<string, unknown>;
          let list = [...repo.issues];
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((s) => String(s).toUpperCase()));
            list = list.filter((i) => wanted.has(i.state.toUpperCase()));
          }
          const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
          list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
          if (typeof after === 'string' && after) {
            const cursorNum = decodeCursor(after);
            if (cursorNum !== null) {
              list = list.filter((i) => (direction === 'DESC' ? i.number < cursorNum : i.number > cursorNum));
            }
          }
          const page = list.slice(0, Math.max(0, first));
          const hasNextPage = list.length > page.length;
          const endCursor = page.length ? issueCursor(page[page.length - 1].number) : null;
          const conn: Obj = {
            __type: 'IssueConnection',
            repo,
            issues: page,
            pageInfo: { hasNextPage, endCursor },
          };
          if (!sel.selections) return {};
          return resolveSelections(ctx, conn, sel.selections);
        }
        case 'pullRequest': {
          const n = Number(arg(sel, 'number', ctx.variables));
          const pull = repo.pulls.find((p) => p.number === n);
          if (!pull) return null;
          if (!sel.selections) return {};
          return resolveSelections(ctx, { __type: 'PullRequest', repo, pull }, sel.selections);
        }
        case 'pullRequests': {
          const first = Number(arg(sel, 'first', ctx.variables) ?? 100);
          const page = repo.pulls.slice(0, Math.max(0, first));
          const conn: Obj = { __type: 'PullConnection', repo, pulls: page };
          if (!sel.selections) return {};
          return resolveSelections(ctx, conn, sel.selections);
        }
        default:
          fieldError(ctx, 'Repository', sel.name);
          return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = obj;
      switch (sel.name) {
        case 'id': return issueGid(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        default:
          fieldError(ctx, 'Issue', sel.name);
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = obj;
      switch (sel.name) {
        case 'id': return pullGid(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.head.ref;
        case 'baseRefName': return pull.base.ref;
        case 'mergeable': return computeMergeable(repo, pull);
        case 'files': {
          const files = pullFilePaths(repo, pull);
          const first = Number(arg(sel, 'first', ctx.variables) ?? 10);
          const conn: Obj = { __type: 'FileConnection', files: files.slice(0, Math.max(0, first)) };
          if (!sel.selections) return {};
          return resolveSelections(ctx, conn, sel.selections);
        }
        default:
          fieldError(ctx, 'PullRequest', sel.name);
          return null;
      }
    }
    case 'User': {
      if (sel.name === 'login') return obj.login;
      fieldError(ctx, 'User', sel.name);
      return null;
    }
    case 'BranchRef': {
      if (sel.name === 'name') return obj.name;
      fieldError(ctx, 'BranchRef', sel.name);
      return null;
    }
    case 'IssueConnection': {
      if (sel.name === 'nodes') {
        if (!sel.selections) return obj.issues.map(() => ({}));
        return obj.issues.map((issue) =>
          resolveSelections(ctx, { __type: 'Issue', repo: obj.repo, issue }, sel.selections!),
        );
      }
      if (sel.name === 'pageInfo') {
        if (!sel.selections) return obj.pageInfo;
        const out: Record<string, unknown> = {};
        for (const p of sel.selections) {
          if (p.name === 'hasNextPage') out[p.alias ?? p.name] = obj.pageInfo.hasNextPage;
          else if (p.name === 'endCursor') out[p.alias ?? p.name] = obj.pageInfo.endCursor;
          else fieldError(ctx, 'PageInfo', p.name);
        }
        return out;
      }
      fieldError(ctx, 'IssueConnection', sel.name);
      return null;
    }
    case 'PullConnection': {
      if (sel.name === 'nodes') {
        if (!sel.selections) return obj.pulls.map(() => ({}));
        return obj.pulls.map((pull) =>
          resolveSelections(ctx, { __type: 'PullRequest', repo: obj.repo, pull }, sel.selections!),
        );
      }
      fieldError(ctx, 'PullRequestConnection', sel.name);
      return null;
    }
    case 'FileConnection': {
      if (sel.name === 'nodes') {
        if (!sel.selections) return obj.files.map((path) => ({ path }));
        return obj.files.map((path) => {
          const out: Record<string, unknown> = {};
          for (const p of sel.selections!) {
            if (p.name === 'path') out[p.alias ?? p.name] = path;
            else fieldError(ctx, 'File', p.name);
          }
          return out;
        });
      }
      fieldError(ctx, 'FileConnection', sel.name);
      return null;
    }
    case 'Type': {
      if (sel.name === 'name') return obj.name;
      if (sel.name === 'fields') {
        const names = TYPE_FIELDS[obj.name] ?? [];
        if (!sel.selections) return names.map((n) => ({ name: n }));
        return names.map((n) => {
          const out: Record<string, unknown> = {};
          for (const p of sel.selections!) {
            if (p.name === 'name') out[p.alias ?? p.name] = n;
            else out[p.alias ?? p.name] = null;
          }
          return out;
        });
      }
      if (sel.name === 'enumValues') {
        if (obj.name !== 'SearchType') return null;
        if (!sel.selections) return SEARCH_ENUM.map((n) => ({ name: n }));
        return SEARCH_ENUM.map((n) => {
          const out: Record<string, unknown> = {};
          for (const p of sel.selections!) {
            if (p.name === 'name') out[p.alias ?? p.name] = n;
            else out[p.alias ?? p.name] = null;
          }
          return out;
        });
      }
      fieldError(ctx, '__Type', sel.name);
      return null;
    }
    case 'MutationIssue': {
      const { repo, issue } = obj;
      switch (sel.name) {
        case 'number': return issue.number;
        case 'id': return issueGid(repo, issue);
        case 'state': return issue.state.toUpperCase();
        case 'title': return issue.title;
        default:
          fieldError(ctx, 'Issue', sel.name);
          return null;
      }
    }
    case 'MutationPull': {
      const { repo, pull } = obj;
      switch (sel.name) {
        case 'number': return pull.number;
        case 'id': return pullGid(repo, pull);
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.head.ref;
        case 'baseRefName': return pull.base.ref;
        default:
          fieldError(ctx, 'PullRequest', sel.name);
          return null;
      }
    }
    case 'CommentEdge': {
      if (sel.name === 'node') {
        if (!sel.selections) return { id: commentGid(obj.repo, obj.commentId), body: obj.body };
        const out: Record<string, unknown> = {};
        for (const p of sel.selections) {
          if (p.name === 'id') out[p.alias ?? p.name] = commentGid(obj.repo, obj.commentId);
          else if (p.name === 'body') out[p.alias ?? p.name] = obj.body;
          else fieldError(ctx, 'IssueComment', p.name);
        }
        return out;
      }
      fieldError(ctx, 'IssueCommentEdge', sel.name);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function doMutations(ctx: Ctx, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    const input = (arg(sel, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
    try {
      if (sel.name === 'createIssue') {
        const repo = repoByGid(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const issue: Issue = {
          number: repo.issues.length + 1,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          comments: [],
          seq: repo.issues.length + 1,
        };
        repo.issues.push(issue);
        const obj: Obj = { __type: 'MutationIssue', repo, issue };
        if (sel.selections) {
          const payload: Record<string, unknown> = {};
          for (const p of sel.selections) {
            if (p.name === 'issue') {
              payload[p.alias ?? p.name] = p.selections
                ? resolveSelections(ctx, obj, p.selections)
                : {};
            } else fieldError(ctx, 'CreateIssuePayload', p.name);
          }
          out[key] = payload;
        }
        continue;
      }
      if (sel.name === 'closeIssue') {
        const d = ungid(String(input.issueId ?? ''));
        if (!d || d.kind !== 'Issue') throw new Error('issue not found');
        const [dbId, num] = d.id.split(':');
        let found: { repo: Repo; issue: Issue } | null = null;
        for (const repo of ctx.store.repos.values()) {
          if (repo.dbId !== parseInt(dbId, 10)) continue;
          const issue = repo.issues.find((i) => i.number === parseInt(num, 10));
          if (issue) { found = { repo, issue }; break; }
        }
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        const obj: Obj = { __type: 'MutationIssue', repo: found.repo, issue: found.issue };
        if (sel.selections) {
          const payload: Record<string, unknown> = {};
          for (const p of sel.selections) {
            if (p.name === 'issue') {
              payload[p.alias ?? p.name] = p.selections
                ? resolveSelections(ctx, obj, p.selections)
                : {};
            } else fieldError(ctx, 'CloseIssuePayload', p.name);
          }
          out[key] = payload;
        } else out[key] = {};
        continue;
      }
      if (sel.name === 'createPullRequest') {
        const repo = repoByGid(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
        const dup = repo.pulls.find((p) => p.state === 'open' && p.head.ref === head);
        if (dup) throw new Error('a pull request is already open for this head');
        const pull: Pull = {
          number: repo.pulls.length + 1,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          head: { ref: head, sha: headSha },
          base: { ref: base, sha: baseSha },
          seq: repo.pulls.length + 1,
        };
        repo.pulls.push(pull);
        const obj: Obj = { __type: 'MutationPull', repo, pull };
        if (sel.selections) {
          const payload: Record<string, unknown> = {};
          for (const p of sel.selections) {
            if (p.name === 'pullRequest') {
              payload[p.alias ?? p.name] = p.selections
                ? resolveSelections(ctx, obj, p.selections)
                : {};
            } else fieldError(ctx, 'CreatePullRequestPayload', p.name);
          }
          out[key] = payload;
        } else out[key] = {};
        continue;
      }
      if (sel.name === 'mergePullRequest') {
        const d = ungid(String(input.pullRequestId ?? ''));
        if (!d || d.kind !== 'PullRequest') throw new Error('pull request not found');
        const [dbId, num] = d.id.split(':');
        let found: { repo: Repo; pull: Pull } | null = null;
        for (const repo of ctx.store.repos.values()) {
          if (repo.dbId !== parseInt(dbId, 10)) continue;
          const pull = repo.pulls.find((p) => p.number === parseInt(num, 10));
          if (pull) { found = { repo, pull }; break; }
        }
        if (!found) throw new Error('pull request not found');
        const { repo, pull } = found;
        const merged = squashMerge(ctx.store, repo, pull);
        if (!merged.ok) throw new Error(merged.message);
        const obj: Obj = { __type: 'MutationPull', repo, pull };
        if (sel.selections) {
          const payload: Record<string, unknown> = {};
          for (const p of sel.selections) {
            if (p.name === 'pullRequest') {
              payload[p.alias ?? p.name] = p.selections
                ? resolveSelections(ctx, obj, p.selections)
                : {};
            } else fieldError(ctx, 'MergePullRequestPayload', p.name);
          }
          out[key] = payload;
        } else out[key] = {};
        continue;
      }
      if (sel.name === 'addComment') {
        const d = ungid(String(input.subjectId ?? ''));
        if (!d || d.kind !== 'Issue') throw new Error('subject not found');
        const [dbId, num] = d.id.split(':');
        let found: { repo: Repo; issue: Issue } | null = null;
        for (const repo of ctx.store.repos.values()) {
          if (repo.dbId !== parseInt(dbId, 10)) continue;
          const issue = repo.issues.find((i) => i.number === parseInt(num, 10));
          if (issue) { found = { repo, issue }; break; }
        }
        if (!found) throw new Error('subject not found');
        const commentId = found.repo.nextCommentId++;
        found.issue.comments.push({ id: commentId, body: String(input.body ?? ''), seq: commentId });
        const edge: Obj = { __type: 'CommentEdge', repo: found.repo, commentId, body: String(input.body ?? '') };
        if (sel.selections) {
          const payload: Record<string, unknown> = {};
          for (const p of sel.selections) {
            if (p.name === 'commentEdge') {
              payload[p.alias ?? p.name] = p.selections
                ? resolveSelections(ctx, edge, p.selections)
                : {};
            } else fieldError(ctx, 'AddCommentPayload', p.name);
          }
          out[key] = payload;
        } else out[key] = {};
        continue;
      }
      fieldError(ctx, 'Mutation', sel.name);
      out[key] = null;
    } catch (e) {
      ctx.errors.push({ message: e instanceof Error ? e.message : 'mutation failed' });
      out[key] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  json: unknown;
}

function runOne(store: Store, doc: { query?: unknown; variables?: unknown }): Record<string, unknown> {
  const errors: Array<{ message: string }> = [];
  const ctx: Ctx = { store, variables: {}, errors };
  if (doc.variables !== null && typeof doc.variables === 'object' && !Array.isArray(doc.variables)) {
    ctx.variables = doc.variables as Record<string, unknown>;
  }
  const query = typeof doc.query === 'string' ? doc.query : '';
  if (!query.trim()) {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  let parsed: { operation: string; selections: Selection[] };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
  }
  const data =
    parsed.operation === 'mutation'
      ? doMutations(ctx, parsed.selections)
      : resolveSelections(ctx, { __type: 'Query' }, parsed.selections);
  const result: Record<string, unknown> = { data };
  if (errors.length) result.errors = errors;
  return result;
}

export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((doc) => runOne(store, doc)) };
  }
  if (body !== null && typeof body === 'object') {
    return { status: 200, json: runOne(store, body as { query?: unknown; variables?: unknown }) };
  }
  return { status: 400, json: { errors: [{ message: 'body must be a JSON object' }] } };
}

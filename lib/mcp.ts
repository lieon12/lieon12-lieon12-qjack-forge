// mcp.ts — the MCP endpoint (POST /mcp, JSON-RPC 2.0, modern era 2026-07-28).
// No handshake, no session: server/discover answers the revision, then
// tools/list and tools/call run against the same store as REST. Every
// request must answer inside 3 seconds; auth is enforced by app.ts before
// this runs (no token -> 401). Unknown method -> -32601, bad params or an
// unknown tool -> -32602, a tool that cannot do its job -> isError: true
// in the result (never HTTP 500). tools/list returns the same tools array
// byte-for-byte on every call: the tools are one constant.

import { squashMerge } from './merge.ts';
import { type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface McpResult {
  status: number;
  json: unknown;
}

const SERVER_NAME = 'qjack-forge';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// The one constant tools array. Required lists hold ONLY properties the
// suite can fill (see checks-mcp.ts mapArguments).
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (the viewer).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewer() || repo.owner;
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
  };
}

type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; message: string };

function argStr(args: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

function argNum(args: Record<string, unknown>, ...names: string[]): number {
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return 0;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = argStr(args, 'name', 'repo', 'repository');
      if (!repoName) return { ok: false, message: 'name is required' };
      const repo = store.createRepo(repoName, args.private === true, argStr(args, 'description'));
      if (!repo) return { ok: false, message: 'name already exists on this account' };
      return { ok: true, result: repoJson(store, repo) };
    }
    case 'get_repo': {
      const owner = argStr(args, 'owner', 'owner_login');
      const repoName = argStr(args, 'repo', 'repository', 'name');
      const repo = store.getRepoForOwner(owner, repoName);
      if (!repo) return { ok: false, message: 'repository not found' };
      return { ok: true, result: repoJson(store, repo) };
    }
    case 'create_issue': {
      const owner = argStr(args, 'owner', 'owner_login');
      const repoName = argStr(args, 'repo', 'repository', 'name');
      const repo = store.getRepoForOwner(owner, repoName);
      if (!repo) return { ok: false, message: 'repository not found' };
      const title = argStr(args, 'title');
      if (!title) return { ok: false, message: 'title is required' };
      const issue: Issue = {
        number: repo.issues.length + 1,
        title,
        body: argStr(args, 'body', 'description'),
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.issues.length + 1,
      };
      repo.issues.push(issue);
      return { ok: true, result: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const owner = argStr(args, 'owner', 'owner_login');
      const repoName = argStr(args, 'repo', 'repository', 'name');
      const repo = store.getRepoForOwner(owner, repoName);
      if (!repo) return { ok: false, message: 'repository not found' };
      const state = argStr(args, 'state') || 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return { ok: true, result: list.map((i) => issueJson(store, repo, i)) };
    }
    case 'create_pull_request': {
      const owner = argStr(args, 'owner', 'owner_login');
      const repoName = argStr(args, 'repo', 'repository', 'name');
      const repo = store.getRepoForOwner(owner, repoName);
      if (!repo) return { ok: false, message: 'repository not found' };
      const title = argStr(args, 'title');
      const head = argStr(args, 'head');
      const base = argStr(args, 'base') || repo.defaultBranch;
      if (!title || !head) return { ok: false, message: 'title and head are required' };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { ok: false, message: 'head or base branch does not exist' };
      const dup = repo.pulls.find((p) => p.state === 'open' && p.head.ref === head);
      if (dup) return { ok: false, message: 'a pull request is already open for this head' };
      const pull: Pull = {
        number: repo.pulls.length + 1,
        title,
        body: argStr(args, 'body', 'description'),
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        seq: repo.pulls.length + 1,
      };
      repo.pulls.push(pull);
      return { ok: true, result: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const owner = argStr(args, 'owner', 'owner_login');
      const repoName = argStr(args, 'repo', 'repository', 'name');
      const repo = store.getRepoForOwner(owner, repoName);
      if (!repo) return { ok: false, message: 'repository not found' };
      const n = argNum(args, 'pull_number', 'number', 'pullNumber');
      const pull = repo.pulls.find((p) => p.number === n);
      if (!pull) return { ok: false, message: 'pull request not found' };
      const merged = squashMerge(store, repo, pull);
      if (!merged.ok) return { ok: false, message: merged.message };
      return { ok: true, result: pullJson(store, repo, pull) };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcp(store: Store, bodyRaw: Buffer): McpResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyRaw.toString('utf8'));
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700, id recovered when possible.
    let id: unknown = null;
    const m = /"id"\s*:\s*("[^"]*"|\d+)/.exec(bodyRaw.toString('utf8'));
    if (m) {
      try {
        id = JSON.parse(m[1]);
      } catch {
        id = null;
      }
    }
    return { status: 400, json: rpcError(id, -32700, 'Parse error') };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, json: rpcError(null, -32600, 'Invalid Request') };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in req ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params =
    req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params)
      ? (req.params as Record<string, unknown>)
      : {};

  // Notifications (no id) are answered 202 with no body.
  if (id === undefined || id === null) {
    if (method.startsWith('notifications/')) return { status: 202, json: null };
    return { status: 400, json: rpcError(null, -32600, 'Invalid Request') };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        json: rpcResult(id, {
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
          supportedVersions: [REVISION],
        }),
      };
    case 'initialize':
      return {
        status: 200,
        json: rpcResult(id, {
          protocolVersion: '2025-11-25',
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        }),
      };
    case 'tools/list':
      return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args =
        params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return { status: 200, json: rpcError(id, -32602, `unknown tool ${toolName}`) };
      }
      // Missing required arguments -> -32602 (invalid params).
      for (const reqArg of tool.inputSchema.required) {
        if (args[reqArg] === undefined || args[reqArg] === null || args[reqArg] === '') {
          return { status: 200, json: rpcError(id, -32602, `missing required argument ${reqArg}`) };
        }
      }
      const outcome = callTool(store, toolName, args);
      if (!outcome.ok) {
        return {
          status: 200,
          json: rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ error: outcome.message }) }],
            isError: true,
          }),
        };
      }
      const text = JSON.stringify(outcome.result);
      return {
        status: 200,
        json: rpcResult(id, {
          content: [{ type: 'text', text }],
          structuredContent: outcome.result,
        }),
      };
    }
    default:
      return { status: 200, json: rpcError(id, -32601, `method not found: ${method}`) };
  }
}

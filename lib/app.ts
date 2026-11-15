// app.ts — the HTTP server: routing, auth, JSON parsing, request ids.
// Routes:
//   GET  /healthz                                  (no auth)
//   GET  /{owner}/{repo}.git/info/refs             (no auth, smart HTTP)
//   POST /{owner}/{repo}.git/git-upload-pack       (no auth, smart HTTP)
//   POST /{owner}/{repo}.git/git-receive-pack      (no auth, smart HTTP)
//   POST /mcp                                      (auth, JSON-RPC 2.0)
//   POST /api/graphql                              (auth, GraphQL)
//   /api/v3/...                                    (auth, REST v3)
//   everything else -> 404 JSON
// Every reply carries a non-empty X-GitHub-Request-Id. Auth: the Bearer
// token must equal MAKEFUN_SHOP_TOKEN when the env sets one; when it does
// not, any non-empty Bearer token is accepted (the dev fallback the kit's
// clients rely on). No token -> 401 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './smart.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function shopToken(): string | null {
  const t = process.env.MAKEFUN_SHOP_TOKEN;
  return t !== undefined && t !== '' ? t : null;
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = shopToken();
  if (expected === null) return true;
  return token === expected;
}

function sendJson(res: ServerResponse, store: Store, status: number, json: unknown, extraHeaders?: Record<string, string>): void {
  const body = json === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': store.nextRequestId(),
    'content-length': String(body.length),
    ...(extraHeaders ?? {}),
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendRaw(res: ServerResponse, store: Store, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': store.nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function createApp(store = new Store()): Server {
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(rawUrl, `http://${host}`);
      const segments = url.pathname
        .split('/')
        .filter((s) => s !== '')
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        });

      // GET /healthz — no auth.
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, store, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (
        segments.length >= 3 &&
        segments[1].endsWith('.git') &&
        (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
      ) {
        const owner = segments[0];
        const repoName = segments[1].slice(0, -'.git'.length);
        // NOTE: do not learn the viewer login here — a 404 probe for a
        // missing repo under an arbitrary owner must not poison it. The
        // handlers learn it from getRepoForOwner, only for existing repos.
        if (segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, store, 400, { message: 'service is required' });
            return;
          }
          const result = handleInfoRefs(store, owner, repoName, service, req.headers['git-protocol']);
          sendRaw(res, store, result.status, result.contentType, result.body);
          return;
        }
        if (segments[2] === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = handleUploadPack(store, owner, repoName, body, req.headers['git-protocol']);
          sendRaw(res, store, result.status, result.contentType, result.body);
          return;
        }
        if (segments[2] === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = handleReceivePack(store, owner, repoName, body);
          sendRaw(res, store, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, store, 404, { message: 'Not Found' });
        return;
      }

      // POST /mcp — auth, raw body (the handler recovers ids from bad JSON).
      if (method === 'POST' && segments.length === 1 && segments[0] === 'mcp') {
        if (!isAuthorized(req)) {
          sendJson(res, store, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        const result = handleMcp(store, body);
        if (result.status === 202) {
          res.writeHead(202, { 'x-github-request-id': store.nextRequestId(), 'content-length': '0' });
          res.end();
          return;
        }
        sendJson(res, store, result.status, result.json);
        return;
      }

      // POST /api/graphql — auth, JSON body.
      if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (!isAuthorized(req)) {
          sendJson(res, store, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        let parsed: unknown = null;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, store, 400, { message: 'malformed JSON' });
            return;
          }
        }
        const result = handleGraphQL(store, parsed);
        sendJson(res, store, result.status, result.json);
        return;
      }

      // /api/v3/... — auth, JSON body when present.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        if (!isAuthorized(req)) {
          sendJson(res, store, 401, { message: 'Requires authentication' });
          return;
        }
        const restSegments = segments.slice(2);
        let parsed: unknown = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const body = await readBody(req);
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, store, 400, { message: 'malformed JSON' });
              return;
            }
          }
        }
        const result = handleRest({
          store,
          method,
          segments: restSegments,
          query: url.searchParams,
          body: parsed,
          baseUrl: `http://${host}`,
        });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, store, result.status, result.json, result.headers);
        return;
      }

      sendJson(res, store, 404, { message: 'Not Found' });
    } catch (err) {
      // Never crash the server on one bad request.
      try {
        sendJson(res, store, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });
  return server;
}

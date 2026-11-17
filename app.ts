// The server: one Node http server wiring git smart HTTP, REST v3,
// GraphQL v4 and MCP onto one in-memory store. Stdlib only.
//
// Routing:
//   GET  /healthz                         200 {ok:true} (no auth; the boot probe)
//   /{owner}/{repo}.git/info/refs         git smart HTTP (auth)
//   /{owner}/{repo}.git/git-upload-pack    git smart HTTP (auth)
//   /{owner}/{repo}.git/git-receive-pack   git smart HTTP (auth)
//   /api/v3/**                            REST v3 (auth)
//   POST /api/graphql                     GraphQL v4 (auth)
//   POST /mcp                             MCP JSON-RPC (auth)
//   everything else                       JSON 404
//
// Every REST reply is application/json with a non-empty
// X-GitHub-Request-Id (a per-process counter, deterministic); errors are
// JSON with a string message; a malformed JSON body is a 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAuthenticated } from './src/auth.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git-http.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns undefined on malformed JSON (when a body was present). */
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handleRequest(store, req, res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;
  const query = url.searchParams;

  // The boot probe: no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const authenticated = isAuthenticated(req.headers.authorization);
  const unauthorized = (): void => sendJson(res, 401, { message: 'Requires authentication' });

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch !== null) {
    if (!authenticated) {
      unauthorized();
      return;
    }
    const owner = decodeURIComponent(gitMatch[1]!);
    const name = decodeURIComponent(gitMatch[2]!);
    const suffix = gitMatch[3]!;
    if (method === 'GET' && suffix === 'info/refs') {
      const service = query.get('service') ?? '';
      const result = handleInfoRefs(store, owner, name, service, req.headers['git-protocol']);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && suffix === 'git-upload-pack') {
      const body = await readBody(req);
      const result = handleUploadPack(store, owner, name, body, req.headers['git-protocol']);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && suffix === 'git-receive-pack') {
      const body = await readBody(req);
      const result = handleReceivePack(store, owner, name, body);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (!authenticated) {
      unauthorized();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    const result = handleGraphQL(store, parsed.value);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      // A session goodbye (legacy close): no body needed.
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!authenticated) {
      unauthorized();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(store, raw.toString('utf8'));
    if (result.body === null) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    if (!authenticated) {
      unauthorized();
      return;
    }
    const restPath = path === '/api/v3' || path === '/api/v3/' ? '' : path.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/');
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return;
        }
        body = parsed.value;
      }
    }
    const result = handleRest({
      store,
      host: req.headers.host ?? '127.0.0.1',
      method,
      segments,
      query,
      body,
    });
    if (result.status === 204) {
      sendJson(res, 204, null, result.headers);
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  // Everything else: a JSON 404, never HTML.
  sendJson(res, 404, { message: 'Not Found' });
}

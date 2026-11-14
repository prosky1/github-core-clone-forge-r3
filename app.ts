// app.ts — request routing for the forge: REST v3, GraphQL, MCP, and git smart HTTP.
//
// The transport is pluggable: node:http (createForgeServer, the fallback) or
// the raw TCP transport in transport.ts (createRawForgeServer, the default).
// Both speak to the handlers through the small ForgeReq/ForgeRes interfaces
// below, which cover exactly the surface the handlers use. node:http's
// IncomingMessage/ServerResponse satisfy these interfaces structurally.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ForgeStore, LazyQuery, type QueryView } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit, parseGitRoute } from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The request headers the handlers read (lowercase names, as both transports store them). */
export interface ForgeReqHeaders {
  authorization?: string;
  host?: string;
  'content-length'?: string;
  'transfer-encoding'?: string;
  [key: string]: string | string[] | undefined;
}

/** The request surface the handlers use. */
export interface ForgeReq {
  method?: string;
  url?: string;
  headers: ForgeReqHeaders;
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}

/** The response surface the handlers use. */
export interface ForgeRes {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  end(chunk?: string | Buffer): void;
}

export function createForgeServer(store: ForgeStore, token: string) {
  return createServer((req, res) => {
    void dispatchRequest(store, token, req as ForgeReq, res as unknown as ForgeRes);
  });
}

/** True when the request's headers prove it carries no body: content-length 0,
 *  or no content-length and no transfer-encoding. Skipping the stream read then
 *  is exactly what the parser would do, without the async-iterator setup cost
 *  on every bodyless GET (the read workload's 2,000 GETs, every advertisement). */
function hasNoBody(req: ForgeReq): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined) return length === '0';
  return req.headers['transfer-encoding'] === undefined;
}

const EMPTY_BODY = Buffer.alloc(0);

async function readBody(req: ForgeReq): Promise<Buffer> {
  // NOTE: do NOT "optimize" this with req.read() first: measured 2026-11-14,
  // a read()-then-iterate path costs ~50 us extra per POST (the stream's 'end'
  // delivery after manual reads goes through a slower path). The plain async
  // iterator is the fast path here.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return chunks.length === 0 ? EMPTY_BODY : Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): unknown | 'malformed' {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return 'malformed';
  }
}

function sendJson(res: ForgeRes, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function bearerOk(token: string, req: ForgeReq): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented.length === 0) return false;
  if (token === '') return true;
  return presented === token;
}

/** Shared empty query view: parsing '' is deterministic, so one instance serves
 *  every query-less request (most hot-path requests carry no query string). */
const EMPTY_QUERY: QueryView = new LazyQuery('');

async function handleRequest(store: ForgeStore, token: string, req: ForgeReq, res: ForgeRes): Promise<void> {
  // Manual path split: `new URL()` per request costs more than the routing it feeds,
  // and the handlers only need the raw path (still percent-encoded, as URL.pathname
  // was) plus a lazily-parsed query string.
  const rawUrl = req.url ?? '/';
  const qmark = rawUrl.indexOf('?');
  const path = qmark === -1 ? rawUrl : rawUrl.slice(0, qmark);
  const query: QueryView = qmark === -1 ? EMPTY_QUERY : new LazyQuery(rawUrl.slice(qmark + 1));
  const method = (req.method ?? 'GET').toUpperCase();

  // Boot check: no auth, always up.
  if (path === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
  // The route regex runs only when the path can possibly be a git route: REST
  // paths (the read/write workloads) skip it entirely.
  if (path.includes('.git/')) {
    const gitRoute = parseGitRoute(path, query);
    if (gitRoute !== null) {
      if (!bearerOk(token, req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const body = hasNoBody(req) ? EMPTY_BODY : await readBody(req);
      const protocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      let result: { status: number; contentType: string; body: Buffer };
      try {
        result = handleGit(store, gitRoute, method, body, protocolV2);
      } catch (err) {
        // A malformed git request must not crash the server: any response is fine.
        sendJson(res, 400, { message: (err as Error).message });
        return;
      }
      res.writeHead(result.status, {
        'content-type': result.contentType,
        'content-length': result.body.length,
      });
      res.end(result.body);
      return;
    }
  }

  if (path === '/api/graphql' && method === 'POST') {
    const body = hasNoBody(req) ? EMPTY_BODY : await readBody(req);
    await handleGraphQL({ store, token }, req, res, body.toString('utf8'));
    return;
  }

  if (path === '/mcp' && (method === 'POST' || method === 'DELETE')) {
    const body = hasNoBody(req) ? EMPTY_BODY : await readBody(req);
    await handleMcp({ store, token }, req, res, body.toString('utf8'));
    return;
  }

  if (path.startsWith('/api/v3')) {
    const body = hasNoBody(req) ? EMPTY_BODY : await readBody(req);
    const handled = await handleRest(
      { store, token },
      req,
      res,
      path,
      method,
      query,
      parseJsonBody(body),
    );
    if (handled) return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** One request, with the never-crash guarantee: a handler throw answers 500
 *  and the process keeps serving. Shared by both transports. */
export async function dispatchRequest(store: ForgeStore, token: string, req: ForgeReq, res: ForgeRes): Promise<void> {
  try {
    await handleRequest(store, token, req, res);
  } catch (err) {
    // One bad request must never kill the process: answer 500 and keep serving.
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    try {
      res.end(JSON.stringify({ message: `Internal Server Error: ${(err as Error).message}` }));
    } catch {
      // The socket is already gone; nothing more to do.
    }
  }
}

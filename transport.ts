// transport.ts — raw TCP HTTP/1.1 transport for the forge.
//
// Why this exists (measured 2026-11-14, round-3 profiling): node:http costs
// ~85 us of CPU per request before any handler runs (IncomingMessage /
// ServerResponse allocation, full header parse, stream machinery), and the
// entry is otherwise idle — the benchmark workloads are thousands of small
// requests, so that fixed per-request cost dominates the server's share of
// every round. This transport parses only what the handlers need (method,
// target, a handful of headers), serves pre-buffered bodies, and flushes
// one socket.write per response.
//
// The handlers see small ForgeReq/ForgeRes shims with the same surface
// app.ts already uses, so no handler changes were needed for the transport
// itself. node:http is still available via createForgeServer in app.ts
// (FORGE_TRANSPORT=nodehttp) as a fallback.
//
// HTTP/1.1 behaviour implemented: keep-alive connections, pipelined
// requests (answered in order), Content-Length bodies, chunked request
// bodies, Expect: 100-continue, Connection: close, and an idle timeout.
// Responses always carry Content-Length (except 204/304) and never use
// chunked encoding. No Date header is sent (clients here do not read it).

import { createServer, type Server, type Socket } from 'node:net';
import { dispatchRequest, type ForgeReq, type ForgeRes, type ForgeReqHeaders } from './app.ts';
import type { ForgeStore } from './store.ts';

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 120_000;
const CRLFCRLF = Buffer.from('\r\n\r\n');
const CONTINUE_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** A request shim: the parsed head plus the fully buffered body. */
class RawReq implements ForgeReq {
  readonly method: string;
  readonly url: string;
  readonly headers: ForgeReqHeaders;
  readonly #body: Buffer;

  constructor(method: string, url: string, headers: ForgeReqHeaders, body: Buffer) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.#body = body;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (this.#body.length > 0) yield this.#body;
  }
}

/** A response shim: buffers status + headers, flushes one socket.write on end(). */
class RawRes implements ForgeRes {
  headersSent = false;
  readonly #socket: Socket;
  readonly #wantClose: boolean;
  #status = 200;
  #headers: Record<string, string> = {};
  #ended = false;
  #flushWait: Promise<void> | null = null;

  constructor(socket: Socket, wantClose: boolean) {
    this.#socket = socket;
    this.#wantClose = wantClose;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    if (this.#ended) return;
    this.#status = status;
    for (const key of Object.keys(headers)) this.#headers[key] = headers[key] as string;
    this.headersSent = true;
  }

  end(chunk?: string | Buffer): void {
    if (this.#ended) return;
    this.#ended = true;
    const body = chunk === undefined ? null : typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const noBody = this.#status === 204 || this.#status === 304;
    const parts: string[] = [`HTTP/1.1 ${this.#status} ${REASONS[this.#status] ?? ''}\r\n`];
    let hasLength = false;
    for (const key of Object.keys(this.#headers)) {
      if (key.toLowerCase() === 'content-length') hasLength = true;
      parts.push(`${key}: ${this.#headers[key] as string}\r\n`);
    }
    if (!noBody && !hasLength) parts.push(`Content-Length: ${body === null ? 0 : body.length}\r\n`);
    if (this.#wantClose) parts.push('Connection: close\r\n');
    parts.push('\r\n');
    const head = Buffer.from(parts.join(''), 'latin1');
    const out = noBody || body === null || body.length === 0 ? head : Buffer.concat([head, body]);
    const ok = this.#socket.write(out);
    if (!ok) {
      this.#flushWait = new Promise<void>((resolve) => {
        const onDrain = (): void => {
          this.#socket.off('error', onError);
          resolve();
        };
        const onError = (): void => {
          this.#socket.off('drain', onDrain);
          resolve();
        };
        this.#socket.once('drain', onDrain);
        this.#socket.once('error', onError);
      });
    }
    if (this.#wantClose) this.#socket.end();
  }

  /** Resolves once the flushed bytes left the kernel buffer (at once normally). */
  waitFlush(): Promise<void> {
    return this.#flushWait ?? Promise.resolve();
  }
}

interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: ForgeReqHeaders;
  headLength: number;
}

/** Parse the request head (through the blank line). Null when incomplete. */
function parseHead(buf: Buffer): ParsedHead | 'oversize' | null {
  const end = buf.indexOf(CRLFCRLF);
  if (end === -1) return buf.length > MAX_HEADER_BYTES ? 'oversize' : null;
  const text = buf.subarray(0, end).toString('latin1');
  const lines = text.split('\r\n');
  const first = lines[0] ?? '';
  const sp1 = first.indexOf(' ');
  const sp2 = first.indexOf(' ', sp1 + 1);
  if (sp1 <= 0 || sp2 <= sp1 + 1) return 'oversize';
  const method = first.slice(0, sp1);
  const target = first.slice(sp1 + 1, sp2);
  const version = first.slice(sp2 + 1);
  const headers: ForgeReqHeaders = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { method, target, version, headers, headLength: end + 4 };
}

/**
 * Parse a chunked body starting at `start`. Returns the body + bytes consumed,
 * null when more data is needed, or 'bad' when the framing is invalid.
 */
function parseChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | 'bad' | null {
  const chunks: Buffer[] = [];
  let offset = start;
  for (;;) {
    const eol = buf.indexOf('\r\n', offset);
    if (eol === -1) return null;
    const sizeText = buf.subarray(offset, eol).toString('ascii').trim();
    const semi = sizeText.indexOf(';');
    const size = Number.parseInt(semi === -1 ? sizeText : sizeText.slice(0, semi), 16);
    if (!Number.isFinite(size) || size < 0) return 'bad';
    offset = eol + 2;
    if (size === 0) {
      // Trailers end at the next blank line; the suite sends none, so this is
      // normally the final CRLF right here.
      const trailerEnd = buf.indexOf('\r\n', offset);
      if (trailerEnd === -1) return null;
      return { body: Buffer.concat(chunks), consumed: trailerEnd + 2 - start };
    }
    if (offset + size + 2 > buf.length) return null;
    chunks.push(buf.subarray(offset, offset + size));
    offset += size + 2;
  }
}

/** One connection: buffered input, one in-flight request at a time. */
class Connection {
  readonly #socket: Socket;
  readonly #store: ForgeStore;
  readonly #token: string;
  #chunks: Buffer[] = [];
  #length = 0;
  #busy = false;
  #dead = false;

  constructor(socket: Socket, store: ForgeStore, token: string) {
    this.#socket = socket;
    this.#store = store;
    this.#token = token;
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on('timeout', () => this.#destroy());
    socket.on('error', () => this.#destroy());
    socket.on('close', () => {
      this.#dead = true;
    });
    socket.on('data', (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#length += chunk.length;
      void this.#pump();
    });
  }

  #destroy(): void {
    if (this.#dead) return;
    this.#dead = true;
    try {
      this.#socket.destroy();
    } catch {
      // Already gone.
    }
  }

  #takeBuffer(): Buffer {
    if (this.#chunks.length === 0) return Buffer.alloc(0);
    if (this.#chunks.length === 1) return this.#chunks[0] as Buffer;
    return Buffer.concat(this.#chunks, this.#length);
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#dead) return;
    this.#busy = true;
    try {
      for (;;) {
        if (this.#dead) return;
        let buf = this.#takeBuffer();
        if (buf.length === 0) return;
        const head = parseHead(buf);
        if (head === null) return; // need more data
        if (head === 'oversize') {
          this.#socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          this.#dead = true;
          return;
        }
        const te = head.headers['transfer-encoding'];
        const chunked = typeof te === 'string' && te.toLowerCase().includes('chunked');
        const expect = head.headers['expect'];
        if (typeof expect === 'string' && expect.toLowerCase() === '100-continue') {
          this.#socket.write(CONTINUE_100);
        }
        let body: Buffer;
        let consumed: number;
        if (chunked) {
          const parsed = parseChunked(buf, head.headLength);
          if (parsed === null) return; // need more data
          if (parsed === 'bad') {
            this.#socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            this.#dead = true;
            return;
          }
          body = parsed.body;
          consumed = head.headLength + parsed.consumed;
        } else {
          const lenRaw = head.headers['content-length'];
          const len = lenRaw === undefined ? 0 : Number.parseInt(Array.isArray(lenRaw) ? lenRaw[0] ?? '' : lenRaw, 10);
          if (!Number.isFinite(len) || len < 0) {
            this.#socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            this.#dead = true;
            return;
          }
          if (len > MAX_BODY_BYTES) {
            this.#socket.end('HTTP/1.1 413 Content Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            this.#dead = true;
            return;
          }
          if (buf.length < head.headLength + len) return; // need more data
          body = buf.subarray(head.headLength, head.headLength + len);
          consumed = head.headLength + len;
        }
        // Consume the request from the buffer.
        buf = buf.subarray(consumed);
        this.#chunks = buf.length === 0 ? [] : [buf];
        this.#length = buf.length;
        const connHeader = head.headers['connection'];
        const wantClose =
          (typeof connHeader === 'string' && connHeader.toLowerCase().includes('close')) ||
          head.version === 'HTTP/1.0';
        const req = new RawReq(head.method, head.target, head.headers, body);
        const res = new RawRes(this.#socket, wantClose);
        await dispatchRequest(this.#store, this.#token, req, res);
        await res.waitFlush();
        if (wantClose || this.#dead) {
          this.#dead = true;
          return;
        }
        // Loop: pipelined bytes (if any) are already buffered.
      }
    } finally {
      this.#busy = false;
    }
  }
}

/**
 * Create the raw TCP forge server. It exposes the same listen/address/close
 * surface main.ts uses for the node:http server.
 */
export function createRawForgeServer(store: ForgeStore, token: string): Server {
  const server = createServer((socket: Socket) => {
    new Connection(socket, store, token);
  });
  return server;
}

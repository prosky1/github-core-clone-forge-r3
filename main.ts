// main.ts — entrypoint: start the forge, register it with the trial env, wait for done.
//
// Lifecycle (the env's contract, in my own words):
//   1. MAKEFUN_ENV_URL must name the env origin. Without it there is nothing to
//      register with, so exit 1 immediately.
//   2. Build the forge server and listen(0) — the kernel picks a free port. Port 8080
//      is never used; the env owns it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. 200 means accepted; 409 means
//      another entry registered first, which is fine — this process still waits.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers at once, so this is a short poll with backoff, never a held request.
//   5. Close the server and exit 0.
//
// The forge itself is in app.ts; this file only owns the lifecycle.

import { createForgeServer } from './app.ts';
import { createRawForgeServer } from './transport.ts';
import { ForgeStore } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet; keep polling.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const store = new ForgeStore();
  // Transport: raw TCP by default (the round-3 performance bet — see
  // transport.ts); FORGE_TRANSPORT=nodehttp selects the node:http fallback.
  const useRaw = (process.env.FORGE_TRANSPORT ?? 'raw').toLowerCase() !== 'nodehttp';
  const server = useRaw ? createRawForgeServer(store, SHOP_TOKEN) : createForgeServer(store, SHOP_TOKEN);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the env to finish the trial\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

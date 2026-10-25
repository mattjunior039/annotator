import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { Bridge, BridgeError } from './bridge.ts';
import { MAX_BYTES, MAX_RESULT_BYTES, originSchema, PORT } from './protocol.ts';

export function validateOptions(port: number, origins: readonly string[]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || origins.length === 0 ||
      origins.some(origin => !originSchema.safeParse(origin).success)) throw new Error('Invalid bridge configuration');
}

async function body(request: IncomingMessage, limit = MAX_BYTES) {
  if (request.headers['content-type'] !== 'application/json' ||
      request.headers['content-encoding'] !== undefined) throw new BridgeError('invalid');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) throw new BridgeError('invalid');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new BridgeError('invalid'); }
}

export async function startBrowserServer(bridge: Bridge, origins: readonly string[], port = PORT): Promise<Server> {
  validateOptions(port, origins);
  const host = `127.0.0.1:${port}`;
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    try {
      // Require exactly one Host and Origin, exact serialized origins, and no URL/query credentials.
      const countHeader = (name: string) => request.rawHeaders.filter((_, i) =>
        i % 2 === 0 && request.rawHeaders[i]?.toLowerCase() === name).length;
      const origin = request.headers.origin;
      if (countHeader('host') !== 1 || countHeader('origin') !== 1 || request.headers.host !== host ||
          !origin || !origins.includes(origin)) { send(403, { error: 'denied' }); return; }
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      bridge.limit('http', 1500);
      if (!['/pair', '/message'].includes(request.url ?? '')) { send(404, { error: 'not-found' }); return; }
      if (request.method === 'OPTIONS') {
        const headers = (request.headers['access-control-request-headers'] ?? '').toLowerCase()
          .split(',').map(value => value.trim()).filter(Boolean);
        if (request.headers['access-control-request-method'] !== 'POST' ||
            headers.some(value => !['authorization', 'content-type'].includes(value))) {
          send(403, { error: 'denied' }); return;
        }
        response.setHeader('access-control-allow-methods', 'POST');
        response.setHeader('access-control-allow-headers', 'authorization, content-type');
        if (request.headers['access-control-request-private-network'] === 'true') {
          response.setHeader('access-control-allow-private-network', 'true');
        }
        response.writeHead(204); response.end(); return;
      }
      if (request.method !== 'POST') { send(405, { error: 'method' }); return; }
      if (request.url === '/pair') {
        const value = await body(request);
        send(200, value && typeof value === 'object' && 'type' in value && value.type === 'pair-check'
          ? bridge.checkPair(origin, value) : bridge.requestPair(origin, value));
        return;
      }
      const auth = request.headers.authorization;
      if (countHeader('authorization') !== 1 || !auth?.match(/^Bearer [A-Za-z0-9_-]{43}$/)) {
        throw new BridgeError('denied');
      }
      const bearer = auth.slice(7);
      bridge.authenticate(origin, bearer);
      // Authenticated before reading: only the paired browser may upload approved images.
      send(200, bridge.browser(origin, bearer, await body(request, MAX_RESULT_BYTES)));
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'invalid';
      send(code === 'denied' ? 403 : code === 'limited' ? 429 : code === 'stale' ? 409 : 400, { error: code });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5000;
  server.timeout = 15_000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  server.maxHeadersCount = 32;
  const expiry = setInterval(() => bridge.sweep(), 1000);
  expiry.unref();
  server.once('close', () => { clearInterval(expiry); bridge.clear(); });
  return new Promise((resolve, reject) => {
    server.once('error', error => { clearInterval(expiry); reject(error); });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

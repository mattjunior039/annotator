import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bridge } from './bridge.ts';
import { startBrowserServer, validateOptions } from './http.ts';
import { MAX_BYTES } from './protocol.ts';
import type { Scope } from './protocol.ts';

const origin = 'http://127.0.0.1:5173';
async function availablePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
function http(port: number, options: {
  path?: string; method?: string; headers?: Record<string, string | string[]>; body?: unknown; raw?: string;
} = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path: options.path ?? '/message', method: options.method ?? 'POST',
      headers: { origin, 'content-type': 'application/json', ...options.headers },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, text }));
    });
    req.on('error', reject);
    req.end(options.raw ?? JSON.stringify(options.body ?? { type: 'poll' }));
  });
}

async function connect(port: number, confirm: (code: string) => Promise<void> | void, scopes: Scope[] = ['metadata', 'pixels', 'propose']) {
  const request = await http(port, { path: '/pair', body: { type: 'pair-request', workspaceId: randomUUID(), scopes } });
  expect(request.status).toBe(200);
  const { code, ticket } = JSON.parse(request.text) as { code: string; ticket: string };
  expect(JSON.parse((await http(port, { path: '/pair', body: { type: 'pair-check', ticket } })).text)).toMatchObject({ state: 'pending' });
  await confirm(code);
  const paired = await http(port, { path: '/pair', body: { type: 'pair-check', ticket } });
  expect(paired.status).toBe(200);
  expect((await http(port, { path: '/pair', body: { type: 'pair-check', ticket } })).status).toBe(403);
  return (JSON.parse(paired.text) as { bearer: string }).bearer;
}

describe('browser loopback boundary', () => {
  let port: number, server: Server, bridge: Bridge, bearer: string;
  beforeAll(async () => {
    port = await availablePort();
    bridge = new Bridge([origin]);
    server = await startBrowserServer(bridge, [origin], port);
    bearer = await connect(port, code => { bridge.confirmPair({ code }); }, ['metadata']);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('listens only on IPv4 loopback and refuses unsafe configuration', () => {
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port });
    for (const invalid of [0, 80, 65536, NaN, 1.5]) expect(() => validateOptions(invalid, [origin])).toThrow();
    for (const invalid of [[], ['*'], ['null'], ['https://app.example/'], ['http://evil.example']]) {
      expect(() => validateOptions(port, invalid)).toThrow();
    }
  });

  it.each([
    { host: 'attacker.example' }, { host: 'localhost:47321' }, { host: '127.0.0.1' },
    { host: '127.0.0.1:1' }, { origin: 'null' }, { origin: '' }, { origin: `${origin}/` },
    { origin: `${origin}.attacker.example` }, { origin: 'https://attacker.example' },
    { origin: [origin, origin] },
  ])('rejects Host/Origin mismatch before authentication: %j', async headers => {
    const response = await http(port, { headers });
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.text).toBe('{"error":"denied"}');
  });

  it('permits only exact-origin bounded CORS preflights, not wildcard or credential sharing', async () => {
    const response = await http(port, { method: 'OPTIONS', headers: {
      'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type',
      'access-control-request-private-network': 'true',
    } });
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-private-network']).toBe('true');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect((await http(port, { method: 'OPTIONS', headers: {
      'access-control-request-method': 'GET',
    } })).status).toBe(403);
  });

  it('authenticates before reading large bodies and never reflects invalid payloads', async () => {
    expect((await http(port, { raw: 'SENSITIVE' })).status).toBe(403);
    expect((await http(port, { path: '/pair', raw: 'x'.repeat(MAX_BYTES + 1) })).status).toBe(400);
    const headers = { authorization: `Bearer ${bearer}` };
    expect((await http(port, { headers, raw: 'SENSITIVE' })).text).toBe('{"error":"invalid"}');
    expect((await http(port, { headers, body: { type: 'read-file', path: 'SENSITIVE' } })).status).toBe(400);
    expect((await http(port, { headers: { ...headers, 'content-type': 'text/plain' } })).status).toBe(400);
    expect((await http(port, { path: '/message?token=SENSITIVE', headers })).status).toBe(404);
    expect((await http(port, { path: '/mcp', headers })).status).toBe(404);
    expect((await http(port, { method: 'GET', headers })).status).toBe(405);
    const response = await http(port, { headers });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.text)).toMatchObject({ authorized: true, jobs: [] });
  });

  it('revokes promptly over HTTP and bounds request rates', async () => {
    const headers = { authorization: `Bearer ${bearer}` };
    expect((await http(port, { headers, body: { type: 'lock' } })).status).toBe(200);
    expect((await http(port, { headers })).status).toBe(403);
    for (let i = 0; i < 1500; i++) await http(port);
    expect((await http(port)).status).toBe(429);
    expect(bridge.status().connected).toBe(false);
  });
});

describe('real MCP stdio client interoperability', () => {
  it('pairs by code, forwards list/view/annotate to the browser, returns image content, and revokes', async () => {
    const port = await availablePort();
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--experimental-strip-types', 'services/bridge/node-server.ts'],
      cwd: process.cwd(), env: { BRIDGE_PORT: String(port), BRIDGE_ORIGINS: origin },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' });
    const call = async (name: string, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      return { error: response.isError, content, text: content[0]?.text ?? '' };
    };
    let polling = true;
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('annotator');
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        'annotate', 'bridge_pair', 'bridge_revoke', 'bridge_status', 'get_annotations', 'list_images', 'view_images',
      ]);
      expect((await call('list_images')).error).toBe(true);
      const bearer = await connect(port, async code => {
        expect((await call('bridge_pair', { code })).error).toBeFalsy();
      });
      const headers = { authorization: `Bearer ${bearer}` };
      const imageId = randomUUID(), classId = randomUUID(), added = randomUUID();
      const jpeg = Buffer.from('fake-jpeg').toString('base64');
      const answers: Record<string, unknown> = {
        list: { total: 1, offset: 0, classes: [{ id: classId, name: 'car' }],
          images: [{ id: imageId, width: 200, height: 100, review: 'unannotated', annotationCount: 0 }] },
        images: { images: [{ id: imageId, width: 200, height: 100, sentWidth: 100, sentHeight: 50, mimeType: 'image/jpeg', data: jpeg }] },
        annotate: { state: 'applied', createdClasses: ['truck'], images: [{ id: imageId, revision: 2, added: [added], updated: 0, removed: 0 }] },
      };
      const seen: unknown[] = [];
      const browser = (async () => {
        while (polling) {
          const poll = await http(port, { headers });
          if (poll.status !== 200) break;
          for (const job of (JSON.parse(poll.text) as { jobs: { id: string; kind: string; args: unknown }[] }).jobs) {
            seen.push(job.args);
            await http(port, { headers, body: { type: 'result', jobId: job.id, ok: true, value: answers[job.kind] } });
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })();
      expect(JSON.parse((await call('list_images', { review: 'unannotated' })).text)).toEqual(answers.list);
      const view = await call('view_images', { imageIds: [imageId] });
      expect(view.error).toBeFalsy();
      expect(view.content[1]).toEqual({ type: 'image', data: jpeg, mimeType: 'image/jpeg' });
      expect(JSON.parse(view.content[0]!.text!)).toMatchObject({ scaleToOriginal: 2 });
      const annotate = { edits: [{ imageId, add: [{ label: 'truck', box: [1, 2, 30, 40] }] }] };
      expect(JSON.parse((await call('annotate', annotate)).text)).toEqual(answers.annotate);
      expect(seen).toContainEqual(annotate);
      expect(JSON.parse((await call('bridge_status')).text)).toMatchObject({ connected: true, browserOnline: true });
      await call('bridge_revoke');
      polling = false;
      await browser;
      expect((await call('list_images')).error).toBe(true);
      expect((await http(port, { headers })).status).toBe(403);
      for (const sensitive of [bearer, imageId]) expect(stderr).not.toContain(sensitive);
      expect(stderr).toBe('');
    } finally { polling = false; await client.close(); }
  }, 20_000);
});

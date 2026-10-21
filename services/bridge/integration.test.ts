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
    req.end(options.raw ?? JSON.stringify(options.body ?? { type: 'status' }));
  });
}

describe('browser loopback boundary', () => {
  let port: number, server: Server, bridge: Bridge, bearer: string;
  beforeAll(async () => {
    port = await availablePort();
    bridge = new Bridge([origin]);
    server = await startBrowserServer(bridge, [origin], port);
    const workspaceId = randomUUID();
    const pairing = bridge.beginPair({ origin, workspaceId, scopes: ['counts'] });
    const response = await http(port, { path: '/pair', body: { type: 'pair', token: pairing.token,
      workspaceId, approved: true, scopes: ['counts'] } });
    expect(response.status).toBe(200);
    bearer = JSON.parse(response.text).bearer as string;
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

  it('authenticates before parsing commands and never reflects invalid payloads', async () => {
    expect((await http(port, { raw: 'SENSITIVE' })).status).toBe(403);
    const headers = { authorization: `Bearer ${bearer}` };
    expect((await http(port, { headers, raw: 'SENSITIVE' })).text).toBe('{"error":"invalid"}');
    expect((await http(port, { headers, body: { type: 'read-file', path: 'SENSITIVE' } })).status).toBe(400);
    expect((await http(port, { headers: { ...headers, 'content-type': 'text/plain' } })).status).toBe(400);
    expect((await http(port, { headers, raw: 'x'.repeat(MAX_BYTES + 1) })).status).toBe(400);
    expect((await http(port, { path: '/message?token=SENSITIVE', headers })).status).toBe(404);
    expect((await http(port, { path: '/mcp', headers })).status).toBe(404);
    expect((await http(port, { method: 'GET', headers })).status).toBe(405);
    const response = await http(port, { headers });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.text)).toMatchObject({ authorized: true, fileVisibility: 'not-observed' });
  });

  it('revokes promptly over HTTP and bounds unauthenticated request rates', async () => {
    const headers = { authorization: `Bearer ${bearer}` };
    expect((await http(port, { headers, body: { type: 'lock' } })).status).toBe(200);
    expect((await http(port, { headers })).status).toBe(403);
    for (let i = 0; i < 120; i++) await http(port);
    expect((await http(port)).status).toBe(429);
    expect(bridge.status().authorized).toBe(false);
  });
});

describe('real MCP stdio client interoperability', () => {
  it('negotiates SDK lifecycle, pairs over HTTP, discloses allowlisted data, queues rather than applies, and revokes', async () => {
    const port = await availablePort();
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--experimental-strip-types', 'services/bridge/node-server.ts'],
      cwd: process.cwd(), env: { BRIDGE_PORT: String(port), BRIDGE_ORIGINS: origin },
      stderr: 'pipe', maxBufferSize: MAX_BYTES,
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' });
    const call = async (name: string, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as { type: string; text: string }[];
      return { error: response.isError, text: content[0]!.text };
    };
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('bounded-annotation-bridge');
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        'annotation_counts', 'annotation_metadata', 'bridge_pair', 'bridge_revoke', 'bridge_status', 'propose_annotation_patch',
      ]);
      expect((await client.listResources().catch(() => ({ resources: [] }))).resources).toEqual([]);
      expect((await call('annotation_counts')).error).toBe(true);
      const workspaceId = randomUUID();
      const pairing = JSON.parse((await call('bridge_pair', {
        origin, workspaceId, scopes: ['metadata', 'counts', 'propose'],
      })).text) as { token: string };
      const approval = { type: 'pair', workspaceId, token: pairing.token, approved: true, scopes: ['metadata', 'counts', 'propose'] };
      const paired = await http(port, { path: '/pair', body: approval });
      expect(paired.status).toBe(200);
      expect((await http(port, { path: '/pair', body: approval })).status).toBe(403);
      const { bearer } = JSON.parse(paired.text) as { bearer: string };
      const headers = { authorization: `Bearer ${bearer}` };
      const classId = randomUUID(), imageId = randomUUID(), id = randomUUID();
      const annotation = { id, imageId, classId, box: [1, 2, 3, 4], review: 'unreviewed' };
      const snapshot = { revision: 7, classes: [classId], images: [{ id: imageId, width: 10, height: 10 }],
        annotations: [annotation] };
      expect((await http(port, { headers, body: { type: 'snapshot', snapshot } })).status).toBe(200);
      expect(JSON.parse((await call('annotation_counts')).text)).toMatchObject({ revision: 7, images: 1, annotations: 1 });
      expect(JSON.parse((await call('annotation_metadata')).text)).toEqual(snapshot);
      const proposal = JSON.parse((await call('propose_annotation_patch', { baseRevision: 7,
        operations: [{ type: 'replace-box', annotation: { ...annotation, box: [2, 2, 3, 4] } }] })).text) as { proposalId: string };
      expect(proposal.proposalId).toBeTruthy();
      expect(JSON.parse((await call('annotation_metadata')).text)).toEqual(snapshot);
      const status = JSON.parse((await http(port, { headers })).text) as { proposals: unknown[] };
      expect(status.proposals).toHaveLength(1);
      await call('bridge_revoke');
      expect((await call('annotation_metadata')).error).toBe(true);
      expect((await http(port, { headers })).status).toBe(403);
      for (const sensitive of [pairing.token, bearer, workspaceId, imageId]) expect(stderr).not.toContain(sensitive);
      expect(stderr).toBe('');
    } finally { await client.close(); }
  }, 15_000);
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Bridge, BridgeError } from './bridge.ts';
import { OFFLINE_AFTER, PAIR_TTL, SESSION_TTL } from './protocol.ts';
import type { Scope } from './protocol.ts';

export const origin = 'http://127.0.0.1:5173';
export function fixture(jobTimeout = 1000) {
  let time = 1000;
  const bridge = new Bridge([origin], () => time, jobTimeout, 0);
  const workspaceId = randomUUID();
  const connect = (scopes: Scope[] = ['metadata', 'pixels', 'propose']) => {
    const request = bridge.requestPair(origin, { type: 'pair-request', workspaceId, scopes });
    bridge.confirmPair({ code: request.code });
    const paired = bridge.checkPair(origin, { type: 'pair-check', ticket: request.ticket });
    if (paired.state !== 'paired') throw new Error('not paired');
    return paired.bearer;
  };
  const poll = async (bearer: string) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    return bridge.browser(origin, bearer, { type: 'poll' }) as { jobs: { id: string; kind: string; args: unknown }[] };
  };
  return { bridge, workspaceId, connect, poll, advance: (ms: number) => { time += ms; } };
}
const listResult = { total: 1, offset: 0, classes: [{ id: randomUUID(), name: 'car' }],
  images: [{ id: randomUUID(), width: 100, height: 80, review: 'unannotated', annotationCount: 0 }] };

describe('code pairing', () => {
  it('requires the website request, the matching code from the editor and the original origin/ticket', () => {
    const f = fixture();
    expect(() => f.bridge.confirmPair({ code: '123456' })).toThrow('denied');
    const request = f.bridge.requestPair(origin, { type: 'pair-request', workspaceId: f.workspaceId, scopes: ['metadata'] });
    expect(request.code).toMatch(/^\d{6}$/);
    expect(f.bridge.checkPair(origin, { type: 'pair-check', ticket: request.ticket })).toMatchObject({ state: 'pending' });
    const wrong = request.code === '000000' ? '111111' : '000000';
    expect(() => f.bridge.confirmPair({ code: wrong })).toThrow('denied');
    expect(f.bridge.confirmPair({ code: `${request.code.slice(0, 3)} ${request.code.slice(3)}` })).toEqual({ connected: true, scopes: ['metadata'] });
    expect(() => f.bridge.checkPair('https://attacker.example', { type: 'pair-check', ticket: request.ticket })).toThrow('denied');
    expect(() => f.bridge.checkPair(origin, { type: 'pair-check', ticket: 'a'.repeat(43) })).toThrow('denied');
    const paired = f.bridge.checkPair(origin, { type: 'pair-check', ticket: request.ticket });
    expect(paired).toMatchObject({ state: 'paired', scopes: ['metadata'] });
    expect(() => f.bridge.checkPair(origin, { type: 'pair-check', ticket: request.ticket })).toThrow('denied');
    if (paired.state !== 'paired') throw new Error('unreachable');
    expect(paired.bearer).not.toBe(request.ticket);
    expect(() => f.bridge.authenticate('https://attacker.example', paired.bearer)).toThrow('denied');
    expect(() => f.bridge.requestPair('https://attacker.example', { type: 'pair-request', workspaceId: f.workspaceId, scopes: ['metadata'] })).toThrow('denied');
  });

  it('expires codes, invalidates after repeated wrong guesses and bounds requests', () => {
    const f = fixture();
    const request = f.bridge.requestPair(origin, { type: 'pair-request', workspaceId: f.workspaceId, scopes: ['metadata'] });
    f.advance(PAIR_TTL);
    expect(() => f.bridge.confirmPair({ code: request.code })).toThrow('denied');
    const next = f.bridge.requestPair(origin, { type: 'pair-request', workspaceId: f.workspaceId, scopes: ['metadata'] });
    const wrong = next.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(() => f.bridge.confirmPair({ code: wrong })).toThrow('denied');
    expect(() => f.bridge.confirmPair({ code: next.code })).toThrow('denied');
    for (let i = 0; i < 9; i++) f.bridge.requestPair(origin, { type: 'pair-request', workspaceId: f.workspaceId, scopes: ['metadata'] });
    expect(() => f.bridge.requestPair(origin, { type: 'pair-request', workspaceId: f.workspaceId, scopes: ['metadata'] })).toThrow('limited');
  });

  it('replaces an old browser session only after a newly confirmed request, and expires sessions', () => {
    const f = fixture();
    const first = f.connect();
    const second = f.connect();
    expect(() => f.bridge.authenticate(origin, first)).toThrow('denied');
    f.bridge.authenticate(origin, second);
    f.advance(SESSION_TTL);
    expect(() => f.bridge.authenticate(origin, second)).toThrow('denied');
    expect(f.bridge.status().connected).toBe(false);
  });
});

describe('editor requests forwarded to the browser', () => {
  it('delivers validated requests once and returns only schema-checked browser results', async () => {
    const f = fixture();
    const bearer = f.connect();
    const pending = f.bridge.call('list', { limit: 10, review: 'unannotated' });
    const { jobs } = await f.poll(bearer);
    expect(jobs).toEqual([{ id: expect.any(String), kind: 'list', args: { limit: 10, review: 'unannotated' } }]);
    expect((await f.poll(bearer)).jobs).toEqual([]);
    f.bridge.browser(origin, bearer, { type: 'result', jobId: jobs[0]!.id, ok: true, value: listResult });
    await expect(pending).resolves.toEqual(listResult);
    expect(() => f.bridge.browser(origin, bearer, { type: 'result', jobId: jobs[0]!.id, ok: true, value: listResult })).toThrow('stale');
  });

  it('refuses results that would leak filenames or other unapproved fields', async () => {
    const f = fixture();
    const bearer = f.connect();
    const pending = f.bridge.call('list', {});
    const job = (await f.poll(bearer)).jobs[0]!;
    const leaked = { ...listResult, images: [{ ...listResult.images[0], name: 'patient-42.png' }] };
    f.bridge.browser(origin, bearer, { type: 'result', jobId: job.id, ok: true, value: leaked });
    await expect(pending).rejects.toMatchObject({ code: 'failed' });
  });

  it('enforces granted scopes, input bounds, browser presence and user decline', async () => {
    const f = fixture();
    const bearer = f.connect(['metadata']);
    await expect(f.bridge.call('images', { imageIds: [randomUUID()] })).rejects.toMatchObject({ code: 'denied' });
    await expect(f.bridge.call('annotate', { edits: [] })).rejects.toMatchObject({ code: 'denied' });
    await expect(f.bridge.call('annotations', { imageIds: [] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.bridge.call('list', { path: '/etc' })).rejects.toMatchObject({ code: 'invalid' });
    const full = fixture();
    const fullBearer = full.connect();
    const tooMany = Array.from({ length: 7 }, () => randomUUID());
    await expect(full.bridge.call('images', { imageIds: tooMany })).rejects.toMatchObject({ code: 'invalid' });
    const viewing = full.bridge.call('images', { imageIds: [randomUUID()] });
    const job = (await full.poll(fullBearer)).jobs[0]!;
    full.bridge.browser(origin, fullBearer, { type: 'result', jobId: job.id, ok: false, error: 'declined', message: 'User declined.' });
    await expect(viewing).rejects.toMatchObject({ code: 'declined', detail: 'User declined.' });
    full.advance(OFFLINE_AFTER);
    await expect(full.bridge.call('list', {})).rejects.toMatchObject({ code: 'offline' });
    expect(bearer).toBeTruthy();
  });

  it('times out unanswered requests and fails pending requests on revoke', async () => {
    const f = fixture(20);
    const bearer = f.connect();
    await expect(f.bridge.call('list', {})).rejects.toMatchObject({ code: 'timeout' });
    const pending = f.bridge.call('list', {});
    f.bridge.browser(origin, bearer, { type: 'revoke' });
    await expect(pending).rejects.toBeInstanceOf(BridgeError);
    await expect(f.poll(bearer)).rejects.toThrow('denied');
  });

  it('validates annotate inputs: unique images, operation bounds and either box or polygon', async () => {
    const f = fixture();
    f.connect();
    const imageId = randomUUID();
    for (const bad of [
      { edits: [{ imageId }] },
      { edits: [{ imageId, add: [{ label: 'car' }] }, { imageId, add: [{ label: 'car' }] }] },
      { edits: [{ imageId, add: [{ label: 'car', box: [0, 0, 1, 1], polygon: [[0, 0], [1, 0], [1, 1]] }] }] },
      { edits: [{ imageId, add: [{ label: '', box: [0, 0, 1, 1] }] }] },
    ]) await expect(f.bridge.call('annotate', bad)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('waits briefly for the browser to pick up a just-confirmed pairing', async () => {
    let time = 1000;
    const bridge = new Bridge([origin], () => time, 1000, 2000);
    const workspaceId = randomUUID();
    const request = bridge.requestPair(origin, { type: 'pair-request', workspaceId, scopes: ['metadata'] });
    bridge.confirmPair({ code: request.code });
    const pending = bridge.call('list', {});
    await new Promise(resolve => setTimeout(resolve, 150));
    const paired = bridge.checkPair(origin, { type: 'pair-check', ticket: request.ticket });
    if (paired.state !== 'paired') throw new Error('not paired');
    let job: { id: string } | undefined;
    for (let i = 0; i < 20 && !job; i++) {
      job = (bridge.browser(origin, paired.bearer, { type: 'poll' }) as { jobs: { id: string }[] }).jobs[0];
      if (!job) await new Promise(resolve => setTimeout(resolve, 50));
    }
    bridge.browser(origin, paired.bearer, { type: 'result', jobId: job!.id, ok: true, value: listResult });
    await expect(pending).resolves.toEqual(listResult);
  });

  it('keeps the audit trail free of identifiers and content', async () => {
    const f = fixture();
    const bearer = f.connect();
    const pending = f.bridge.call('list', {});
    const job = (await f.poll(bearer)).jobs[0]!;
    f.bridge.browser(origin, bearer, { type: 'result', jobId: job.id, ok: true, value: listResult });
    await pending;
    const text = JSON.stringify(f.bridge.status());
    for (const secret of [bearer, f.workspaceId, job.id, 'car']) expect(text).not.toContain(secret);
  });
});

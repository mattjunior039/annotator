import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SerialClient, WorkerClient } from './client';
import type { WorkerTransport } from './client';

class TestWorker implements WorkerTransport {
  onmessage: WorkerTransport['onmessage'] = null;
  onerror: WorkerTransport['onerror'] = null;
  onmessageerror: WorkerTransport['onmessageerror'] = null;
  terminated = false;
  messages: unknown[] = [];
  postMessage(message: unknown): void { this.messages.push(message); }
  terminate(): void { this.terminated = true; }
  reply(value: unknown): void { this.onmessage?.(new MessageEvent('message', { data: value })); }
}
afterEach(() => vi.useRealTimers());
describe('bounded worker RPC', () => {
  it('validates version/ID/result and surfaces controlled worker errors', async () => {
    const worker = new TestWorker(), client = new WorkerClient(worker);
    const result = client.request({ type: 'example' }, z.string());
    expect(worker.messages).toEqual([{ version: 1, id: 1, payload: { type: 'example' } }]);
    worker.reply({ version: 1, id: 1, ok: true, value: 'accepted' });
    await expect(result).resolves.toBe('accepted');
    const failed = client.request({}, z.string());
    worker.reply({ version: 1, id: 2, ok: false, error: 'Storage full.' });
    await expect(failed).rejects.toThrow('Storage full.');
    client.close();
  });
  it('terminates on invalid envelopes, unknown IDs, and invalid response shapes', async () => {
    for (const reply of [
      { version: 2, id: 1, ok: true, value: 'bad version' },
      { version: 1, id: 2, ok: true, value: 'bad id' },
      { version: 1, id: 1, ok: true, value: 123 },
    ]) {
      const worker = new TestWorker(), client = new WorkerClient(worker);
      const result = client.request({}, z.string());
      worker.reply(reply);
      await expect(result).rejects.toThrow();
      expect(worker.terminated).toBe(true); expect(client.isClosed).toBe(true);
    }
  });
  it('bounds in-flight work and rejects pending requests on explicit lock/termination', async () => {
    const worker = new TestWorker(), client = new WorkerClient(worker);
    const result = client.request({}, z.string());
    await expect(client.request({}, z.string())).rejects.toThrow('already in progress');
    client.close('Workspace locked.');
    await expect(result).rejects.toThrow('Workspace locked.');
    await expect(client.request({}, z.string())).rejects.toThrow('Worker is closed');
    expect(worker.messages).toHaveLength(1);
  });
  it('times out without claiming a known commit outcome', async () => {
    vi.useFakeTimers();
    const worker = new TestWorker(), client = new WorkerClient(worker);
    const failure = expect(client.request({}, z.string())).rejects.toThrow('commit outcome must be checked');
    await vi.advanceTimersByTimeAsync(45_000); await failure;
    expect(worker.terminated).toBe(true);
  });
});
describe('serialized storage client', () => {
  it('queues concurrent requests so live-session RPCs never overlap', async () => {
    const worker = new TestWorker(), client = new SerialClient(new WorkerClient(worker));
    const first = client.request({ n: 1 }, z.number()), second = client.request({ n: 2 }, z.number());
    await Promise.resolve();
    expect(worker.messages).toHaveLength(1);
    worker.reply({ version: 1, id: 1, ok: false, error: 'first failed' });
    await expect(first).rejects.toThrow('first failed');
    await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
    worker.reply({ version: 1, id: 2, ok: true, value: 2 });
    await expect(second).resolves.toBe(2);
    client.close();
    expect(client.isClosed).toBe(true);
  });
});

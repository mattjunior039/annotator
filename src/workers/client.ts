import { z } from 'zod';
import { responseEnvelopeSchema } from './protocol';

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export interface WorkerTransport {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface StorageClient {
  readonly isClosed: boolean;
  request<T>(payload: unknown, schema: z.ZodType<T>, transfer?: Transferable[]): Promise<T>;
  close(reason?: string): void;
}

// Queues requests so the live-session host and the local editor can share one
// single-flight storage worker without tripping its concurrency guard.
export class SerialClient implements StorageClient {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: WorkerClient) {}
  get isClosed(): boolean { return this.client.isClosed; }
  request<T>(payload: unknown, schema: z.ZodType<T>, transfer: Transferable[] = []): Promise<T> {
    const next = this.tail.then(() => this.client.request(payload, schema, transfer));
    this.tail = next.catch(() => {});
    return next;
  }
  close(reason?: string): void { this.client.close(reason); }
}

export class WorkerClient implements StorageClient {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly worker: WorkerTransport) {
    worker.onmessage = event => {
      const parsed = responseEnvelopeSchema.safeParse(event.data);
      if (!parsed.success) { this.close('Worker returned an invalid protocol message.'); return; }
      const reply = parsed.data, pending = this.pending.get(reply.id);
      if (!pending) { this.close('Worker returned an unexpected response.'); return; }
      clearTimeout(pending.timer); this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(reply.error));
    };
    worker.onerror = event => {
      event.preventDefault();
      this.close('Worker stopped unexpectedly. Reload or unlock to retry.');
    };
    worker.onmessageerror = () => this.close('Worker message could not be decoded.');
  }
  get isClosed(): boolean { return this.closed; }
  async request<T>(payload: unknown, schema: z.ZodType<T>, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) throw new Error('Worker is closed. Unlock or reload to continue.');
    if (this.pending.size >= 1) throw new Error('A worker operation is already in progress.');
    const id = ++this.sequence;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.close('Worker operation timed out; its commit outcome must be checked after reopening.'), 45_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ version: 1, id, payload }, transfer); }
      catch {
        clearTimeout(timer); this.pending.delete(id);
        reject(new Error('Unable to send the worker request.'));
      }
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      this.close('Worker response failed validation.');
      throw new Error('Worker response failed validation. No result was accepted.');
    }
    return parsed.data;
  }
  close(reason = 'Worker closed.'): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

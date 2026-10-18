import { fromBase64Url, toBase64Url } from './encoding';

const MESSAGES_PER_SECOND = 300;
const CHARS_PER_SECOND = 6 * 1024 * 1024;
const MAX_BUFFERED = 1024 * 1024;

const errorText: Record<string, string> = {
  'no-room': 'This live session has ended or the host has not started it.',
  'room-full': 'This live session is full (8 participants).',
  'room-taken': 'This live session already has a host.',
  'room-closed': 'This live session has ended.',
  'rate-limited': 'The connection sent too much data too quickly.',
};

export function signalingUrl(roomId: string, role: 'host' | 'guest'): string {
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  const url = configured ? new URL(configured, window.location.href) : new URL('/signal', window.location.origin);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.searchParams.set('room', roomId);
  url.searchParams.set('role', role);
  return url.href;
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export class SignalingClient {
  onPeer: ((id: string, event: 'join' | 'leave') => void) | null = null;
  onFrame: ((from: string, frame: Uint8Array<ArrayBuffer>) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private tail: Promise<void> = Promise.resolve();
  private tokens = MESSAGES_PER_SECOND;
  private chars = CHARS_PER_SECOND;
  private refilled = performance.now();
  private closed = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  private constructor(private readonly socket: WebSocket, readonly id: string, readonly hostId: string) {
    this.heartbeat = setInterval(() => this.raw('{"v":1,"t":"ping"}'), 25_000);
    socket.onmessage = event => this.receive(event.data);
    socket.onclose = event => this.finish(errorText[event.reason] ?? (event.reason || 'The live-session connection closed.'));
    socket.onerror = () => this.finish('The live-session connection failed.');
  }

  static connect(roomId: string, role: 'host' | 'guest', timeout = 15_000): Promise<SignalingClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(signalingUrl(roomId, role));
      const timer = setTimeout(() => { socket.close(); reject(new Error('The live-session server did not respond.')); }, timeout);
      socket.onmessage = event => {
        clearTimeout(timer);
        try {
          const message = JSON.parse(String(event.data)) as { t?: string; id?: string; host?: string; code?: string };
          if (message.t === 'welcome' && typeof message.id === 'string' && typeof message.host === 'string') {
            resolve(new SignalingClient(socket, message.id, message.host));
          } else {
            socket.close();
            reject(new Error(errorText[message.code ?? ''] ?? 'The live-session server refused the connection.'));
          }
        } catch { socket.close(); reject(new Error('The live-session server sent an invalid reply.')); }
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Unable to reach the live-session server.')); };
      socket.onclose = event => { clearTimeout(timer); reject(new Error(errorText[event.reason] ?? 'Unable to reach the live-session server.')); };
    });
  }

  get isClosed(): boolean { return this.closed; }

  send(to: string, frame: Uint8Array): Promise<void> {
    const text = JSON.stringify({ v: 1, t: 'send', to, d: toBase64Url(frame) });
    const next = this.tail.then(() => this.transmit(text));
    this.tail = next.catch(() => {});
    return next;
  }

  close(): void {
    if (this.closed) return;
    this.socket.close(1000, 'left');
    this.finish('You left the live session.');
  }

  private async transmit(text: string): Promise<void> {
    for (;;) {
      if (this.closed) throw new Error('The live-session connection is closed.');
      const now = performance.now(), elapsed = (now - this.refilled) / 1000;
      this.refilled = now;
      this.tokens = Math.min(MESSAGES_PER_SECOND, this.tokens + elapsed * MESSAGES_PER_SECOND);
      this.chars = Math.min(CHARS_PER_SECOND, this.chars + elapsed * CHARS_PER_SECOND);
      if (this.tokens >= 1 && this.chars >= text.length && this.socket.bufferedAmount < MAX_BUFFERED) break;
      await sleep(10);
    }
    this.tokens -= 1; this.chars -= text.length;
    this.socket.send(text);
  }

  private raw(text: string): void {
    if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.send(text);
  }

  private receive(data: unknown): void {
    let message: { t?: unknown; from?: unknown; d?: unknown; id?: unknown; event?: unknown; reason?: unknown; code?: unknown };
    try { message = JSON.parse(String(data)) as typeof message; } catch { return; }
    if (message.t === 'msg' && typeof message.from === 'string' && typeof message.d === 'string') {
      let frame: Uint8Array<ArrayBuffer>;
      try { frame = fromBase64Url(message.d); } catch { return; }
      this.onFrame?.(message.from, frame);
    } else if (message.t === 'peer' && typeof message.id === 'string' && (message.event === 'join' || message.event === 'leave')) {
      this.onPeer?.(message.id, message.event);
    } else if (message.t === 'closed') {
      this.finish(message.reason === 'host-left' ? 'The host ended the live session.' : 'The live session ended.');
    } else if (message.t === 'error') {
      this.finish(errorText[String(message.code)] ?? 'The live-session server closed the connection.');
    }
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    try { this.socket.close(); } catch { /* already closed */ }
    this.onClosed?.(reason);
  }
}

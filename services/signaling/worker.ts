// Cloudflare Worker + Durable Object deployment of the signaling relay.
// One Durable Object instance per room keeps all participants on one isolate.
import { MAX_FRAME_CHARS, parseRole, RoomHub, validRoomId } from './room.ts';

interface CloudflareSocket {
  accept(): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}
declare const WebSocketPair: { new(): { 0: CloudflareSocket; 1: CloudflareSocket } };
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface Env { ROOMS: DurableObjectNamespace; ALLOWED_ORIGINS?: string }

function reject(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/signal') return reject(404, 'Not found.');
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return reject(426, 'WebSocket upgrade required.');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(request.headers.get('origin') ?? '')) return reject(403, 'Origin not allowed.');
    const room = url.searchParams.get('room');
    if (!validRoomId(room) || !parseRole(url.searchParams.get('role'))) return reject(400, 'Invalid room.');
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class SignalingRoom {
  private readonly hub = new RoomHub();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get('room'), role = parseRole(url.searchParams.get('role'));
    if (!validRoomId(room) || !role) return reject(400, 'Invalid room.');
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.accept();
    const session = this.hub.connect(room, role, {
      send: text => { try { server.send(text); } catch { /* closed */ } },
      close: (code, reason) => { try { server.close(code, reason); } catch { /* closed */ } },
    });
    if (session) {
      server.addEventListener('message', event => {
        if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_CHARS) { server.close(4001, 'bad-frame'); session.close(); return; }
        session.message(event.data);
      });
      server.addEventListener('close', () => session.close());
      server.addEventListener('error', () => session.close());
    }
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
}

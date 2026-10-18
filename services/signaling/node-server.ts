import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_CHARS, parseRole, RoomHub, validRoomId } from './room.ts';

export interface SignalingOptions {
  port: number;
  host?: string;
  // Origins allowed to open sockets; empty allows any (local testing only).
  origins?: readonly string[];
}

export function startSignalingServer(options: SignalingOptions): Promise<Server> {
  const hub = new RoomHub();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_CHARS * 4, perMessageDeflate: false });
  const server = createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('WebSocket upgrade required.');
  });
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const room = url.searchParams.get('room'), role = parseRole(url.searchParams.get('role'));
    const origin = request.headers.origin ?? '';
    if (url.pathname !== '/signal' || !validRoomId(room) || !role ||
        (options.origins?.length && !options.origins.includes(origin))) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => {
      const signal = { send: (text: string) => { if (ws.readyState === ws.OPEN) ws.send(text); }, close: (code: number, reason: string) => ws.close(code, reason) };
      const session = hub.connect(room, role, signal);
      if (!session) return;
      ws.on('message', (data, binary) => {
        if (binary) { ws.close(4001, 'bad-frame'); return; }
        session.message(data.toString());
      });
      ws.on('close', () => session.close());
      ws.on('error', () => session.close());
    });
  });
  return new Promise(resolve => server.listen(options.port, options.host ?? '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.SIGNALING_PORT ?? 8787);
  const origins = (process.env.SIGNALING_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  await startSignalingServer({ port, host: process.env.SIGNALING_HOST ?? '127.0.0.1', origins });
  process.stdout.write(`Signaling listening on ${process.env.SIGNALING_HOST ?? '127.0.0.1'}:${port}\n`);
}

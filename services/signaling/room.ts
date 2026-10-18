// Zero-knowledge signaling and relay for live sessions. Rooms forward opaque,
// end-to-end encrypted frames between one host and up to seven guests. Nothing
// is persisted or logged; room state lives only in memory while sockets are open.

export const MAX_PARTICIPANTS = 8;
export const MAX_FRAME_CHARS = 40_000;
export const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;
const RATE = { messages: 400, messageBurst: 800, bytes: 8 * 1024 ** 2, byteBurst: 16 * 1024 ** 2 };
const ROOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DATA_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SignalSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}
export type Role = 'host' | 'guest';
export type Clock = () => number;
type Timer = ReturnType<typeof setTimeout>;

interface Member {
  id: string;
  role: Role;
  socket: SignalSocket;
  tokens: number;
  bytes: number;
  refilled: number;
}

export function validRoomId(room: unknown): room is string {
  return typeof room === 'string' && ROOM_PATTERN.test(room);
}
export function parseRole(role: unknown): Role | null {
  return role === 'host' || role === 'guest' ? role : null;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export class Room {
  private host: Member | null = null;
  private readonly members = new Map<string, Member>();
  private readonly expiry: Timer;
  private closed = false;

  private readonly onEmpty: () => void;
  private readonly now: Clock;

  constructor(onEmpty: () => void, now: Clock = Date.now) {
    this.onEmpty = onEmpty;
    this.now = now;
    this.expiry = setTimeout(() => this.close('expired'), ROOM_LIFETIME_MS);
  }

  get size(): number { return this.members.size; }

  // Returns a handler for frames from the joining socket, or null when refused.
  join(role: Role, socket: SignalSocket): ((text: string) => void) | null {
    const refuse = (code: string) => {
      socket.send(JSON.stringify({ v: 1, t: 'error', code }));
      socket.close(4000, code);
      return null;
    };
    if (this.closed) return refuse('room-closed');
    if (role === 'host' && this.host) return refuse('room-taken');
    if (role === 'guest' && !this.host) return refuse('no-room');
    if (this.members.size >= MAX_PARTICIPANTS) return refuse('room-full');
    const member: Member = {
      id: randomId(), role, socket,
      tokens: RATE.messageBurst, bytes: RATE.byteBurst, refilled: this.now(),
    };
    this.members.set(member.id, member);
    if (role === 'host') this.host = member;
    socket.send(JSON.stringify({ v: 1, t: 'welcome', id: member.id, host: this.host!.id }));
    if (role === 'guest') this.host!.socket.send(JSON.stringify({ v: 1, t: 'peer', id: member.id, event: 'join' }));
    return text => this.receive(member, text);
  }

  leave(socket: SignalSocket): void {
    const member = [...this.members.values()].find(item => item.socket === socket);
    if (!member) return;
    this.members.delete(member.id);
    if (member === this.host) { this.close('host-left'); return; }
    this.host?.socket.send(JSON.stringify({ v: 1, t: 'peer', id: member.id, event: 'leave' }));
    if (this.members.size === 0) this.close('empty');
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiry);
    for (const member of this.members.values()) {
      try {
        member.socket.send(JSON.stringify({ v: 1, t: 'closed', reason }));
        member.socket.close(1000, reason);
      } catch { /* socket already gone */ }
    }
    this.members.clear();
    this.host = null;
    this.onEmpty();
  }

  private allow(member: Member, size: number): boolean {
    const now = this.now(), elapsed = Math.max(0, now - member.refilled) / 1000;
    member.refilled = now;
    member.tokens = Math.min(RATE.messageBurst, member.tokens + elapsed * RATE.messages);
    member.bytes = Math.min(RATE.byteBurst, member.bytes + elapsed * RATE.bytes);
    if (member.tokens < 1 || member.bytes < size) return false;
    member.tokens -= 1; member.bytes -= size;
    return true;
  }

  private receive(member: Member, text: string): void {
    const drop = (code: string) => {
      this.members.delete(member.id);
      member.socket.send(JSON.stringify({ v: 1, t: 'error', code }));
      member.socket.close(4001, code);
      if (member === this.host) this.close('host-left');
      else this.host?.socket.send(JSON.stringify({ v: 1, t: 'peer', id: member.id, event: 'leave' }));
    };
    if (typeof text !== 'string' || text.length > MAX_FRAME_CHARS) { drop('frame-too-large'); return; }
    if (!this.allow(member, text.length)) { drop('rate-limited'); return; }
    let message: unknown;
    try { message = JSON.parse(text); } catch { drop('bad-frame'); return; }
    if (typeof message !== 'object' || message === null || (message as { v?: unknown }).v !== 1) { drop('bad-frame'); return; }
    const { t, to, d } = message as { t?: unknown; to?: unknown; d?: unknown };
    if (t === 'ping') { member.socket.send('{"v":1,"t":"pong"}'); return; }
    if (t !== 'send' || typeof to !== 'string' || typeof d !== 'string' || !d || !DATA_PATTERN.test(d)) {
      drop('bad-frame'); return;
    }
    const target = this.members.get(to);
    // Guests may only talk to the host; the host may address any guest.
    if (!target || target === member || (member.role === 'guest' && target !== this.host)) return;
    target.socket.send(JSON.stringify({ v: 1, t: 'msg', from: member.id, d }));
  }
}

export class RoomHub {
  private readonly rooms = new Map<string, Room>();
  private readonly now: Clock;
  constructor(now: Clock = Date.now) { this.now = now; }

  get roomCount(): number { return this.rooms.size; }

  connect(roomId: string, role: Role, socket: SignalSocket): { message(text: string): void; close(): void } | null {
    let room = this.rooms.get(roomId);
    if (!room && role === 'host') {
      const created: Room = new Room(() => { if (this.rooms.get(roomId) === created) this.rooms.delete(roomId); }, this.now);
      room = created;
      this.rooms.set(roomId, room);
    }
    if (!room) {
      socket.send(JSON.stringify({ v: 1, t: 'error', code: 'no-room' }));
      socket.close(4000, 'no-room');
      return null;
    }
    const handler = room.join(role, socket);
    if (!handler) return null;
    const joined = room;
    return { message: handler, close: () => joined.leave(socket) };
  }
}

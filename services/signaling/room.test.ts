import { describe, expect, it } from 'vitest';
import { MAX_FRAME_CHARS, MAX_PARTICIPANTS, RoomHub, parseRole, validRoomId } from './room.ts';

class Socket {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(text: string) { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  close(code: number, reason: string) { this.closed = { code, reason }; }
  last() { return this.sent.at(-1)!; }
  id() { return this.sent.find(item => item.t === 'welcome')!.id as string; }
}
const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const frame = (to: string, d = 'abc') => JSON.stringify({ v: 1, t: 'send', to, d });

describe('zero-knowledge signaling room', () => {
  it('validates room ids and roles', () => {
    expect(validRoomId(ROOM)).toBe(true);
    expect(validRoomId('short')).toBe(false);
    expect(validRoomId('A'.repeat(21) + '/')).toBe(false);
    expect(parseRole('host')).toBe('host');
    expect(parseRole('admin')).toBeNull();
  });

  it('requires a host, relays only host↔guest, and announces membership', () => {
    const hub = new RoomHub();
    const early = new Socket();
    expect(hub.connect(ROOM, 'guest', early)).toBeNull();
    expect(early.closed?.reason).toBe('no-room');
    expect(hub.roomCount).toBe(0);

    const host = new Socket(), a = new Socket(), b = new Socket();
    const h = hub.connect(ROOM, 'host', host)!;
    const ga = hub.connect(ROOM, 'guest', a)!, gb = hub.connect(ROOM, 'guest', b)!;
    expect(host.sent.filter(item => item.t === 'peer' && item.event === 'join')).toHaveLength(2);
    expect(a.last()).toMatchObject({ t: 'welcome', host: host.id() });

    ga.message(frame(host.id()));
    expect(host.last()).toEqual({ v: 1, t: 'msg', from: a.id(), d: 'abc' });
    const before = b.sent.length;
    ga.message(frame(b.id()));
    expect(b.sent).toHaveLength(before);
    h.message(frame(b.id(), 'xyz'));
    expect(b.last()).toEqual({ v: 1, t: 'msg', from: host.id(), d: 'xyz' });

    const second = new Socket();
    expect(hub.connect(ROOM, 'host', second)).toBeNull();
    expect(second.closed?.reason).toBe('room-taken');

    gb.close();
    expect(host.last()).toMatchObject({ t: 'peer', id: b.id(), event: 'leave' });
    h.close();
    expect(a.closed?.reason).toBe('host-left');
    expect(hub.roomCount).toBe(0);
  });

  it('caps participants and drops malformed, oversized, and flooding senders', () => {
    let now = 0;
    const hub = new RoomHub(() => now);
    const host = new Socket();
    const h = hub.connect(ROOM, 'host', host)!;
    const guests = Array.from({ length: MAX_PARTICIPANTS - 1 }, () => new Socket());
    const sessions = guests.map(socket => hub.connect(ROOM, 'guest', socket)!);
    const extra = new Socket();
    expect(hub.connect(ROOM, 'guest', extra)).toBeNull();
    expect(extra.closed?.reason).toBe('room-full');

    sessions[0]!.message('not json');
    expect(guests[0]!.closed?.reason).toBe('bad-frame');
    sessions[1]!.message(frame(host.id(), 'not/base64url'));
    expect(guests[1]!.closed?.reason).toBe('bad-frame');
    sessions[2]!.message('x'.repeat(MAX_FRAME_CHARS + 1));
    expect(guests[2]!.closed?.reason).toBe('frame-too-large');

    for (let index = 0; index < 801 && !guests[3]!.closed; index++) sessions[3]!.message(frame(host.id()));
    expect(guests[3]!.closed?.reason).toBe('rate-limited');
    now += 10_000;
    sessions[4]!.message(frame(host.id()));
    expect(guests[4]!.closed).toBeNull();
    expect(host.closed).toBeNull();
    h.message('{"v":1,"t":"ping"}');
    expect(host.last()).toEqual({ v: 1, t: 'pong' });
  });
});

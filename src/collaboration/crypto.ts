import { concatBytes } from './encoding';
import type { Invite } from './invite';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const SIGNAL_FRAME = 0;
export const RELAY_CHANNEL = 1;
export const DIRECT_CHANNEL = 2;
export type Channel = typeof RELAY_CHANNEL | typeof DIRECT_CHANNEL;

async function hkdf(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bits: number) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}
function aesKey(bytes: Uint8Array<ArrayBuffer>, usage: KeyUsage[]) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usage);
}

// Handshake messages are encrypted with a key derived from the invite so the
// signaling relay only ever sees ciphertext.
export async function signalKey(invite: Invite): Promise<CryptoKey> {
  const bytes = await hkdf(invite.roomKey, encoder.encode(invite.roomId), encoder.encode('annotator/live/v1/signal'), 256);
  return aesKey(bytes, ['encrypt', 'decrypt']);
}

export async function sealSignal(key: CryptoKey, message: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([SIGNAL_FRAME]) },
    key, encoder.encode(JSON.stringify(message))));
  return concatBytes(new Uint8Array([SIGNAL_FRAME]), iv, sealed);
}

export function isSignalFrame(frame: Uint8Array): boolean { return frame[0] === SIGNAL_FRAME; }

export async function openSignal(key: CryptoKey, frame: Uint8Array<ArrayBuffer>): Promise<unknown> {
  if (frame.length < 29 || frame[0] !== SIGNAL_FRAME || frame.length > 8192) throw new Error('Invalid handshake frame.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: frame.subarray(1, 13), additionalData: new Uint8Array([SIGNAL_FRAME]) },
    key, frame.subarray(13));
  return JSON.parse(decoder.decode(plain));
}

export interface Identity { keys: CryptoKeyPair; publicKey: Uint8Array<ArrayBuffer> }

export async function createIdentity(): Promise<Identity> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { keys, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)) };
}

export interface SessionKeys { cipher: SessionCipher; code: string }

// Both sides derive directional keys and a short verification code from an
// ephemeral ECDH exchange bound to the invite key. Comparing the code out of
// band detects a relay (or invite holder) substituting its own keys.
export async function deriveSession(
  own: Identity, peerPublicKey: Uint8Array<ArrayBuffer>, invite: Invite, role: 'host' | 'guest',
): Promise<SessionKeys> {
  if (peerPublicKey.length !== 65 || peerPublicKey[0] !== 4) throw new Error('Invalid participant key.');
  const peer = await crypto.subtle.importKey('raw', peerPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, own.keys.privateKey, 256));
  const [hostKey, guestKey] = role === 'host' ? [own.publicKey, peerPublicKey] : [peerPublicKey, own.publicKey];
  const material = await hkdf(shared, invite.roomKey,
    concatBytes(encoder.encode('annotator/live/v1/session'), hostKey, guestKey), 544);
  const hostToGuest = await aesKey(material.slice(0, 32), role === 'host' ? ['encrypt'] : ['decrypt']);
  const guestToHost = await aesKey(material.slice(32, 64), role === 'host' ? ['decrypt'] : ['encrypt']);
  const value = new DataView(material.buffer, 64, 4).getUint32(0) % 1_000_000;
  const digits = value.toString().padStart(6, '0');
  return {
    cipher: role === 'host' ? new SessionCipher(hostToGuest, guestToHost) : new SessionCipher(guestToHost, hostToGuest),
    code: `${digits.slice(0, 3)} ${digits.slice(3)}`,
  };
}

// Frame: [channel][64-bit counter][AES-GCM ciphertext]. Each channel is ordered,
// so receivers require strictly sequential counters, rejecting replays and drops.
export class SessionCipher {
  private readonly sent = new Map<Channel, bigint>();
  private readonly received = new Map<Channel, bigint>();
  constructor(private readonly sendKey: CryptoKey, private readonly receiveKey: CryptoKey) {}

  private static header(channel: Channel, counter: bigint) {
    const header = new Uint8Array(9);
    header[0] = channel;
    new DataView(header.buffer).setBigUint64(1, counter);
    const iv = new Uint8Array(12);
    iv[0] = channel; iv.set(header.subarray(1), 4);
    return { header, iv };
  }

  // Counters are assigned synchronously, so callers must transmit frames in call order.
  async seal(channel: Channel, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const counter = this.sent.get(channel) ?? 0n;
    this.sent.set(channel, counter + 1n);
    const { header, iv } = SessionCipher.header(channel, counter);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, this.sendKey, plaintext);
    return concatBytes(header, new Uint8Array(sealed));
  }

  // Callers must open frames for one channel sequentially.
  async open(frame: Uint8Array<ArrayBuffer>): Promise<{ channel: Channel; plaintext: Uint8Array<ArrayBuffer> }> {
    const channel = frame[0];
    if (frame.length < 25 || (channel !== RELAY_CHANNEL && channel !== DIRECT_CHANNEL)) throw new Error('Invalid session frame.');
    const counter = new DataView(frame.buffer, frame.byteOffset + 1, 8).getBigUint64(0);
    const expected = this.received.get(channel) ?? 0n;
    if (counter !== expected) throw new Error('Out-of-order or replayed session frame.');
    const { header, iv } = SessionCipher.header(channel, counter);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header },
      this.receiveKey, frame.subarray(9)));
    this.received.set(channel, expected + 1n);
    return { channel, plaintext };
  }
}

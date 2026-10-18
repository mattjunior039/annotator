import { chunkMessage, decodeMessage, encodeMessage, Reassembler } from './codec';
import { DIRECT_CHANNEL, RELAY_CHANNEL } from './crypto';
import type { Channel, SessionCipher } from './crypto';
import type { RtcMessage } from './protocol';
import type { SignalingClient } from './signaling';

export type ConnectionMode = 'relay' | 'direct';
const DIRECT_TIMEOUT_MS = 15_000;

export function iceServers(): RTCIceServer[] {
  const configured = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as unknown;
      if (Array.isArray(parsed)) return parsed as RTCIceServer[];
    } catch { /* fall through to the default */ }
  }
  return [{ urls: 'stun:stun.cloudflare.com:3478' }];
}

// One end-to-end encrypted, ordered message link to a single remote participant.
// All traffic is sealed with session keys; the relay and any TURN server only see ciphertext.
export class SecureLink {
  onMessage: ((message: unknown) => void) | null = null;
  onFailure: ((reason: string) => void) | null = null;
  onDirect: ((open: boolean) => void) | null = null;
  private sendTail: Promise<void> = Promise.resolve();
  private readonly receiveTails = new Map<Channel, Promise<void>>();
  private readonly reassemblers = new Map<Channel, Reassembler>([[RELAY_CHANNEL, new Reassembler()], [DIRECT_CHANNEL, new Reassembler()]]);
  private messageId = 0;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private closed = false;

  constructor(
    private readonly signaling: SignalingClient,
    readonly peerId: string,
    private readonly cipher: SessionCipher,
  ) {}

  get direct(): boolean { return this.channel?.readyState === 'open'; }

  send(message: unknown): Promise<void> {
    const bytes = encodeMessage(message);
    const next = this.sendTail.then(async () => {
      if (this.closed) throw new Error('The live-session link is closed.');
      const channel = this.direct ? this.channel : null;
      for (const chunk of chunkMessage(++this.messageId >>> 0, bytes)) {
        const frame = await this.cipher.seal(channel ? DIRECT_CHANNEL : RELAY_CHANNEL, chunk);
        if (channel) await this.sendDirect(channel, frame);
        else await this.signaling.send(this.peerId, frame);
      }
    });
    this.sendTail = next.catch(() => {});
    return next;
  }

  receive(frame: Uint8Array<ArrayBuffer>): void {
    const channel: Channel = frame[0] === DIRECT_CHANNEL ? DIRECT_CHANNEL : RELAY_CHANNEL;
    const tail = (this.receiveTails.get(channel) ?? Promise.resolve()).then(async () => {
      if (this.closed) return;
      try {
        const opened = await this.cipher.open(frame);
        if (opened.channel !== channel) throw new Error('Session frame arrived on the wrong channel.');
        const complete = this.reassemblers.get(channel)!.accept(opened.plaintext);
        if (complete) this.onMessage?.(decodeMessage(complete));
      } catch (failure) {
        this.fail(failure instanceof Error ? failure.message : 'Invalid live-session data.');
      }
    });
    this.receiveTails.set(channel, tail);
  }

  // Host side: offer a direct DataChannel; traffic stays on the relay until it opens.
  async startDirect(servers: RTCIceServer[]): Promise<void> {
    const peer = this.createPeer(servers);
    this.attach(peer.createDataChannel('live', { ordered: true }));
    await peer.setLocalDescription(await peer.createOffer());
    await this.send({ t: 'rtc', description: { type: 'offer', sdp: peer.localDescription!.sdp } });
    setTimeout(() => { if (!this.direct && this.peer === peer) this.stopDirect(); }, DIRECT_TIMEOUT_MS);
  }

  async handleRtc(message: RtcMessage, servers: RTCIceServer[]): Promise<void> {
    if (message.description?.type === 'offer') {
      const peer = this.createPeer(servers);
      peer.ondatachannel = event => this.attach(event.channel);
      await peer.setRemoteDescription(message.description);
      await peer.setLocalDescription(await peer.createAnswer());
      await this.send({ t: 'rtc', description: { type: 'answer', sdp: peer.localDescription!.sdp } });
    } else if (message.description?.type === 'answer' && this.peer) {
      await this.peer.setRemoteDescription(message.description);
    }
    if (message.candidate && this.peer) await this.peer.addIceCandidate(message.candidate).catch(() => {});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopDirect();
  }

  private createPeer(servers: RTCIceServer[]): RTCPeerConnection {
    this.stopDirect();
    const peer = new RTCPeerConnection({ iceServers: servers });
    peer.onicecandidate = event => {
      if (!event.candidate) return;
      void this.send({ t: 'rtc', candidate: {
        candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex,
      } }).catch(() => {});
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.stopDirect();
    };
    this.peer = peer;
    return peer;
  }

  private attach(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => { this.channel = channel; this.onDirect?.(true); };
    channel.onclose = () => { if (this.channel === channel) { this.channel = null; this.onDirect?.(false); } };
    channel.onmessage = event => {
      if (event.data instanceof ArrayBuffer && event.data.byteLength <= 17 * 1024) this.receive(new Uint8Array(event.data));
      else this.fail('Invalid direct-connection frame.');
    };
  }

  private async sendDirect(channel: RTCDataChannel, frame: Uint8Array<ArrayBuffer>): Promise<void> {
    if (channel.bufferedAmount > 1024 * 1024) {
      await new Promise<void>(resolve => {
        channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
        channel.addEventListener('close', () => resolve(), { once: true });
      });
    }
    if (channel.readyState !== 'open') throw new Error('The direct connection closed while sending.');
    channel.send(frame);
  }

  private stopDirect(): void {
    const had = this.channel !== null;
    this.channel?.close();
    this.peer?.close();
    this.channel = null;
    this.peer = null;
    if (had) this.onDirect?.(false);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.onFailure?.(reason);
  }
}

import { fromBase64Url, toBase64Url } from './encoding';

// The invite secret travels only in the URL fragment, which browsers never send
// to servers. It is removed from the address bar before the app renders.
export interface Invite { roomId: string; roomKey: Uint8Array<ArrayBuffer> }

const FRAGMENT = /^#live=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export function createInvite(): Invite {
  const room = crypto.getRandomValues(new Uint8Array(16));
  return { roomId: toBase64Url(room), roomKey: crypto.getRandomValues(new Uint8Array(32)) };
}

export function inviteFragment(invite: Invite): string {
  return `#live=${invite.roomId}.${toBase64Url(invite.roomKey)}`;
}

export function inviteUrl(invite: Invite, location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}${inviteFragment(invite)}`;
}

export function parseInviteFragment(hash: string): Invite | null {
  const match = FRAGMENT.exec(hash);
  if (!match) return null;
  const roomKey = fromBase64Url(match[2]!);
  return roomKey.length === 32 ? { roomId: match[1]!, roomKey } : null;
}

export function takeInviteFromLocation(): Invite | null {
  if (typeof window === 'undefined' || !window.location.hash.startsWith('#live=')) return null;
  const invite = parseInviteFragment(window.location.hash);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  return invite;
}

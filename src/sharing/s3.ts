import { AwsClient } from 'aws4fetch';
import { fromBase64Url, toBase64Url } from '../collaboration/encoding';
import { invitationSchema, SHARE_BYTES } from './model';
import type { ShareInvitation } from './model';

export interface S3Settings {
  endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; sessionToken: string;
}
export function checkShareUrl(value: string): URL {
  const url = new URL(value);
  const origins = (import.meta.env.VITE_S3_ORIGINS as string | undefined ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && url.origin !== window.location.origin) ||
      (url.origin !== window.location.origin && !origins.includes(url.origin))) {
    throw new Error('This S3 origin is not allowed by this deployment. Configure VITE_S3_ORIGINS with its exact HTTPS origin.');
  }
  return url;
}
export function shareLink(invitation: ShareInvitation): string {
  return `${window.location.origin}${window.location.pathname}#share=${toBase64Url(new TextEncoder().encode(JSON.stringify(invitationSchema.parse(invitation))))}`;
}
export function parseShareLink(text: string): ShareInvitation {
  const url = new URL(text);
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !/^#share=[A-Za-z0-9_-]+$/.test(url.hash) || url.hash.length > 32_768) {
    throw new Error('Paste a workspace invitation from this app.');
  }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(url.hash.slice(7)))); }
  catch { throw new Error('This workspace invitation is damaged.'); }
  const invitation = invitationSchema.parse(data);
  if (invitation.transport === 'file') throw new Error('Open this invitation with its encrypted share file instead.');
  checkShareUrl(invitation.download); checkShareUrl(invitation.upload);
  if (!invitation.expires || Date.parse(invitation.expires) <= Date.now()) throw new Error('This invitation has expired. Ask the owner for a new one.');
  return invitation;
}

export async function createS3Capabilities(settings: S3Settings, id: string) {
  const endpoint = checkShareUrl(settings.endpoint);
  if (endpoint.search) throw new Error('S3 endpoint must not contain a query string.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(settings.bucket) || !/^[a-z0-9-]{1,64}$/.test(settings.region) ||
      !settings.accessKeyId.trim() || !settings.secretAccessKey) throw new Error('Enter a bucket, region, and scoped S3 credentials.');
  const client = new AwsClient({ accessKeyId: settings.accessKeyId.trim(), secretAccessKey: settings.secretAccessKey,
    ...(settings.sessionToken ? { sessionToken: settings.sessionToken } : {}), region: settings.region, service: 's3' });
  const object = (name: string) => new URL(`${endpoint.href.replace(/\/$/, '')}/${encodeURIComponent(settings.bucket)}/annotator-shares/${id}/${name}.enc`);
  const sign = async (name: string, method: string, headers?: Record<string, string>) => {
    const url = object(name); url.searchParams.set('X-Amz-Expires', '86400');
    return (await client.sign(url, { method, ...(headers ? { headers } : {}), aws: { signQuery: true, allHeaders: true } })).url;
  };
  const [snapshotPut, download, upload, reviewUrl] = await Promise.all([
    sign('snapshot', 'PUT', { 'If-None-Match': '*' }), sign('snapshot', 'GET'),
    sign('proposal', 'PUT', { 'If-None-Match': '*' }), sign('proposal', 'GET'),
  ]);
  return { snapshotPut, download, upload, reviewUrl, expires: new Date(Date.now() + 86_400_000).toISOString() };
}

export async function uploadEncrypted(url: string, bytes: ArrayBuffer): Promise<void> {
  checkShareUrl(url);
  const response = await fetch(url, { method: 'PUT', body: bytes, headers: { 'If-None-Match': '*' },
    credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(response.status === 412
    ? 'This invitation already has a submission. Ask the owner for a new invitation.'
    : `S3 upload failed (${response.status}). Check expiry, credentials, conditional-write support, and bucket CORS.`);
}
export async function downloadEncrypted(url: string, limit = SHARE_BYTES): Promise<ArrayBuffer | null> {
  checkShareUrl(url);
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`S3 download failed (${response.status}). Check invitation expiry and bucket CORS.`);
  if (!response.body || Number(response.headers.get('Content-Length')) > limit) throw new Error('Encrypted download exceeds its supported size.');
  const reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error('Encrypted download exceeds its supported size.');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result.buffer;
}

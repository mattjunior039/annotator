import { PROOF_MAX_FILE_BYTES, sanitizeImage } from '../datasets/media';
import { hex } from '../crypto/vault';
import { mediaRequestSchema, requestEnvelopeSchema } from './protocol';

let busy = false;
self.onmessage = async (event: MessageEvent<unknown>) => {
  const envelope = requestEnvelopeSchema.safeParse(event.data);
  if (!envelope.success) {
    self.postMessage({ version: 1, id: 0, ok: false, error: 'Invalid media protocol request.' }); return;
  }
  const { id, payload } = envelope.data;
  if (busy) { self.postMessage({ version: 1, id, ok: false, error: 'Media worker is busy.' }); return; }
  busy = true;
  try {
    const request = mediaRequestSchema.parse(payload);
    if (request.type === 'file-fingerprint') {
      if (request.file.size > PROOF_MAX_FILE_BYTES) throw new Error('Image exceeds the current 8 MiB input limit.');
      const source = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', await request.file.arrayBuffer())));
      const context = new TextEncoder().encode(JSON.stringify(['annotator-intake-v1', source, request.context]));
      const fingerprint = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', context)));
      self.postMessage({ version: 1, id, ok: true, value: { fingerprint } });
      return;
    }
    const result = await sanitizeImage(request.file);
    self.postMessage({ version: 1, id, ok: true, value: result }, { transfer: [result.png] });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const safe = /^(Image exceeds|Lossless |Only |ICC-profiled|16-bit|Animated|Invalid |Truncated |Incomplete |PNG |JPEG |WebP |Sanitized |An sRGB)/.test(message)
      ? message : 'Image sanitization failed. The input may be malformed or unsupported.';
    self.postMessage({ version: 1, id, ok: false, error: safe.slice(0, 512) });
  } finally { busy = false; }
};

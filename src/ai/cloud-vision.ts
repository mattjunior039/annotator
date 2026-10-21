import { z } from 'zod';
import type { Point } from '../domain/editor-geometry';
import { visionEndpoint } from './providers';

const objectSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().gt(0).max(1),
  height: z.number().finite().gt(0).max(1),
  confidence: z.number().finite().min(0).max(1),
}).refine(box => box.x + box.width <= 1 && box.y + box.height <= 1, 'Detection must fit inside the selected crop.');
export const detectionsSchema = z.array(objectSchema).max(32);
export type Detection = z.infer<typeof objectSchema>;
export interface PixelCrop { x: number; y: number; width: number; height: number }
export interface Redaction { x: number; y: number; width: number; height: number }

export function cropSchema(image: { width: number; height: number }, input: PixelCrop): PixelCrop {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width * image.height > 64_000_000 ||
      ![input.x, input.y, input.width, input.height].every(Number.isSafeInteger) ||
      input.x < 0 || input.y < 0 || input.width < 1 || input.height < 1 ||
      input.x + input.width > image.width || input.y + input.height > image.height ||
      input.width * input.height > 4_000_000) {
    throw new Error('Choose an integer image-pixel crop inside the image (maximum 4 megapixels).');
  }
  return input;
}

export function redactionsForCrop(crop: PixelCrop, values: readonly Redaction[]): Redaction[] {
  if (values.length > 64) throw new Error('A crop may contain at most 64 opaque redaction rectangles.');
  return values.map(value => {
    if (![value.x, value.y, value.width, value.height].every(Number.isSafeInteger) ||
        value.width < 1 || value.height < 1 || value.x < crop.x || value.y < crop.y ||
        value.x + value.width > crop.x + crop.width || value.y + value.height > crop.y + crop.height) {
      throw new Error('Every opaque redaction must fit inside the selected crop.');
    }
    return { ...value, x: value.x - crop.x, y: value.y - crop.y };
  });
}

export function detectionsToBoxes(detections: readonly Detection[], crop: PixelCrop): {
  label: string; confidence: number; bounds: { x: number; y: number; width: number; height: number };
}[] {
  const checked = detectionsSchema.parse(detections);
  return checked.map(item => {
    const x1 = Math.max(0, Math.floor(crop.x + item.x * crop.width));
    const y1 = Math.max(0, Math.floor(crop.y + item.y * crop.height));
    const x2 = Math.min(crop.x + crop.width, Math.ceil(crop.x + (item.x + item.width) * crop.width));
    const y2 = Math.min(crop.y + crop.height, Math.ceil(crop.y + (item.y + item.height) * crop.height));
    return { label: item.label, confidence: item.confidence, bounds: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } };
  });
}

export function decodeModelContent(content: string): Detection[] {
  const bounded = content.trim();
  if (!bounded || bounded.length > 32_768) throw new Error('Vision provider returned empty or oversized output.');
  const json = bounded.startsWith('```')
    ? bounded.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : bounded;
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error('Vision provider returned invalid JSON; no annotations were changed.'); }
  const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && 'detections' in parsed
    ? (parsed as { detections: unknown }).detections : parsed;
  return detectionsSchema.parse(values);
}

async function responseText(response: Response, maxBytes = 1_048_576): Promise<string> {
  if (!response.body) throw new Error('Vision provider returned an unreadable response.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Vision provider response exceeds 1 MiB.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(result);
}

export async function requestCloudDetections(input: {
  endpoint: string; model: string; apiKey: string; prompt: string; image: Blob;
  signal?: AbortSignal;
}): Promise<Detection[]> {
  const url = visionEndpoint(input.endpoint, import.meta.env.VITE_AI_ORIGINS as string | undefined ?? '');
  if (!input.apiKey || input.apiKey.length > 4096 || !input.model.trim() || input.model.length > 100 ||
      !input.prompt.trim() || input.prompt.length > 1000 || input.image.type !== 'image/png' || input.image.size > 8 * 1024 * 1024) {
    throw new Error('Provide an API key, model, short prompt and sanitized redacted PNG (maximum 8 MiB).');
  }
  const bytes = new Uint8Array(await input.image.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const dataUrl = `data:image/png;base64,${btoa(binary)}`;
  const timeout = AbortSignal.timeout(90_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      signal,
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model.trim(), max_tokens: 2048,
        messages: [
          { role: 'system', content: 'Return only JSON: {"detections":[{"label":"short object category","x":0,"y":0,"width":0.1,"height":0.1,"confidence":0.9}]}. Boxes use normalized coordinates in [0,1] relative to the supplied image. Include only visible objects requested by the user. Do not infer identity or sensitive attributes. Return an empty detections array if none. This is fallible assistance; never claim certainty.' },
          { role: 'user', content: [{ type: 'text', text: input.prompt.trim() }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] },
        ],
      }),
    });
  } catch {
    throw new Error(signal.aborted
      ? 'Cloud vision was canceled or timed out. No annotations were changed; the provider may already have received the request.'
      : 'Unable to reach the vision provider. Check your connection and whether the provider permits browser requests (CORS). No proxy or fallback was used; no annotations were changed.');
  }
  if (!response.ok) throw new Error(`Cloud vision provider returned HTTP ${response.status}. No annotations were changed.`);
  let payload: unknown;
  try { payload = JSON.parse(await responseText(response)); }
  catch (failure) {
    if (failure instanceof Error && failure.message.includes('1 MiB')) throw failure;
    throw new Error('Cloud vision provider returned an invalid response.');
  }
  const content = z.object({ choices: z.array(z.object({
    message: z.object({ content: z.string().max(32_768) }),
  }).passthrough()).min(1).max(4) }).passthrough().parse(payload).choices[0]!.message.content;
  return decodeModelContent(content);
}

export function buildRedactedPng(
  image: CanvasImageSource,
  imageSize: { width: number; height: number },
  cropInput: PixelCrop,
  redactionInput: readonly Redaction[],
): HTMLCanvasElement {
  const crop = cropSchema(imageSize, cropInput), redactions = redactionsForCrop(crop, redactionInput);
  const canvas = document.createElement('canvas');
  canvas.width = crop.width; canvas.height = crop.height;
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  if (!context) throw new Error('Local opaque-redaction preview is unavailable.');
  context.fillStyle = '#000'; context.fillRect(0, 0, crop.width, crop.height);
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  context.fillStyle = '#000';
  for (const mask of redactions) context.fillRect(mask.x, mask.y, mask.width, mask.height);
  return canvas;
}

export interface SuggestedBox {
  label: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export function boundsCenter(bounds: SuggestedBox['bounds']): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

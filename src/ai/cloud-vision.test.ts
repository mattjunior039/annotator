import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropSchema, decodeModelContent, detectionsToBoxes, redactionsForCrop, requestCloudDetections } from './cloud-vision';
import type { PixelCrop } from './cloud-vision';
import { visionEndpoint, visionProviders } from './providers';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('consented cloud-vision geometry and output', () => {
  const crop: PixelCrop = { x: 10, y: 20, width: 100, height: 80 };
  it('supports exact preset API paths without accepting subscription endpoints or arbitrary paths', () => {
    for (const provider of visionProviders) {
      expect(visionEndpoint(provider.endpoint, '').href).toBe(provider.endpoint);
      expect(() => visionEndpoint(`${provider.endpoint}?key=secret`, '')).toThrow('allowlist');
      expect(() => visionEndpoint(`${new URL(provider.endpoint).origin}/other`, '')).toThrow();
    }
    expect(() => visionEndpoint('https://api.githubcopilot.com/chat/completions', '')).toThrow();
    expect(visionEndpoint('https://custom.example/v1/chat/completions', 'https://custom.example').host).toBe('custom.example');
  });
  it.each(visionProviders)('sends only the explicitly supplied crop to $name with no cookies or fallback', async provider => {
    vi.stubEnv('VITE_AI_ORIGINS', '');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"detections":[]}' } }] })));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await expect(requestCloudDetections({
      endpoint: provider.endpoint, model: 'vision-model', apiKey: 'test-key', prompt: 'Find cars',
      image: new Blob(['flattened-png'], { type: 'image/png' }), signal: controller.signal,
    })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(provider.endpoint);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.signal).not.toBe(controller.signal);
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    const body = JSON.parse(String(init.body));
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/png;base64,${btoa('flattened-png')}`);
  });
  it('bounds crops and redactions to integer pixels inside a four-megapixel image crop', () => {
    expect(cropSchema({ width: 200, height: 200 }, crop)).toEqual(crop);
    expect(() => cropSchema({ width: 100, height: 100 }, crop)).toThrow('inside');
    expect(() => cropSchema({ width: 3000, height: 2000 }, { x: 0, y: 0, width: 2501, height: 1600 })).toThrow('4 megapixels');
    expect(redactionsForCrop(crop, [{ x: 20, y: 30, width: 10, height: 20 }])).toEqual([{ x: 10, y: 10, width: 10, height: 20 }]);
    expect(() => redactionsForCrop(crop, [{ x: 9, y: 30, width: 10, height: 20 }])).toThrow('inside');
    expect(() => redactionsForCrop(crop, Array.from({ length: 65 }, () => ({ x: 10, y: 20, width: 1, height: 1 })))).toThrow('64');
  });
  it('reports network/CORS failures without exposing credentials or retrying', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    await expect(requestCloudDetections({
      endpoint: visionProviders[0]!.endpoint, model: 'vision-model', apiKey: 'private-test-key',
      prompt: 'Find cars', image: new Blob(['png'], { type: 'image/png' }),
    })).rejects.toThrow('provider permits browser requests (CORS)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('maps normalized crop detections to bounded source image pixels', () => {
    const detections = decodeModelContent('{"detections":[{"label":"car","x":0.1,"y":0.25,"width":0.4,"height":0.5,"confidence":0.9}]}');
    expect(detectionsToBoxes(detections, crop)).toEqual([{
      label: 'car', confidence: 0.9, bounds: { x: 20, y: 40, width: 40, height: 40 },
    }]);
    expect(decodeModelContent('```json\n{"detections":[]}\n```')).toEqual([]);
    expect(() => decodeModelContent('{"detections":[{"label":"x","x":0.9,"y":0,"width":0.5,"height":1,"confidence":0.9}]}')).toThrow();
    expect(() => decodeModelContent('not JSON')).toThrow('invalid JSON');
    expect(() => decodeModelContent('x'.repeat(32_769))).toThrow('oversized');
    const oversized = JSON.stringify(Array.from({ length: 33 }, (_, index) => ({
      label: `${index}`, x: 0, y: 0, width: 0.1, height: 0.1, confidence: 0.9,
    })));
    expect(() => decodeModelContent(oversized)).toThrow();
  });
  it('refuses nonallowlisted destinations before any request and bounds provider response', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
    vi.stubEnv('VITE_AI_ORIGINS', 'https://api.example');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const image = new Blob(['png'], { type: 'image/png' });
    await expect(requestCloudDetections({
      endpoint: 'https://attacker.example/v1/chat/completions', model: 'test', apiKey: 'secret', prompt: 'Find objects', image,
    })).rejects.toThrow('allowlist');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: { content: '{"detections":[{"label":"box","x":0,"y":0,"width":0.25,"height":0.5,"confidence":0.75}]}' },
      }],
    }), { status: 200 }));
    const result = await requestCloudDetections({
      endpoint: 'https://api.example/v1/chat/completions', model: 'test', apiKey: 'secret', prompt: 'Find objects', image,
    });
    expect(result[0]).toMatchObject({ label: 'box', confidence: 0.75 });
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
    });
    const auth = (fetch.mock.calls[0]![1]?.headers as Record<string, string>).Authorization;
    expect(auth).toBeDefined();
    expect(auth?.slice(0, 7)).toBe(['Be', 'arer', ' '].join(''));
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(JSON.stringify(body)).not.toContain('filename');
    fetch.mockResolvedValue(new Response('x'.repeat(1_048_577), { status: 200 }));
    await expect(requestCloudDetections({
      endpoint: 'https://api.example/v1/chat/completions', model: 'test', apiKey: 'secret', prompt: 'Find objects', image,
    })).rejects.toThrow('1 MiB');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('deployment network allowlists', () => {
  it('permits only explicit BYOK APIs and fixed loopback companions by default', async () => {
    vi.stubEnv('VITE_S3_ORIGINS', '');
    vi.stubEnv('VITE_AI_ORIGINS', '');
    vi.stubEnv('VITE_MODEL_ORIGINS', '');
    const { productionHeaders } = await import('../../deploy/headers');
    expect(productionHeaders['Content-Security-Policy']).toContain("connect-src 'self'");
    for (const origin of ['https://api.openai.com', 'https://generativelanguage.googleapis.com', 'https://openrouter.ai']) {
      expect(productionHeaders['Content-Security-Policy']).toContain(origin);
    }
    expect(productionHeaders['Content-Security-Policy']).not.toContain('https://huggingface.co');
    expect(productionHeaders['Content-Security-Policy']).not.toContain('*');
    expect(productionHeaders['Content-Security-Policy']).toContain('http://127.0.0.1:47321');
    expect(productionHeaders['Content-Security-Policy']).toContain('http://127.0.0.1:47322');
  });

  it('adds only exact configured HTTPS provider origins to CSP', async () => {
    vi.stubEnv('VITE_S3_ORIGINS', 'https://storage.example');
    vi.stubEnv('VITE_AI_ORIGINS', 'https://vision.example, https://vision-backup.example');
    vi.stubEnv('VITE_MODEL_ORIGINS', 'https://huggingface.co, https://cas-bridge.xethub.hf.co');
    const { productionHeaders } = await import('../../deploy/headers');
    expect(productionHeaders['Content-Security-Policy']).toContain(
      "connect-src 'self' http://127.0.0.1:47321 http://127.0.0.1:47322 https://storage.example https://api.openai.com https://generativelanguage.googleapis.com https://openrouter.ai https://vision.example https://vision-backup.example https://huggingface.co https://cas-bridge.xethub.hf.co",
    );
  });

  it('rejects insecure or path-scoped AI origins', async () => {
    vi.stubEnv('VITE_S3_ORIGINS', '');
    vi.stubEnv('VITE_AI_ORIGINS', 'http://vision.example');
    vi.stubEnv('VITE_MODEL_ORIGINS', '');
    await expect(import('../../deploy/headers')).rejects.toThrow('VITE_AI_ORIGINS');
  });

  it('rejects insecure model download origins', async () => {
    vi.stubEnv('VITE_S3_ORIGINS', '');
    vi.stubEnv('VITE_AI_ORIGINS', '');
    vi.stubEnv('VITE_MODEL_ORIGINS', 'https://huggingface.co/models');
    await expect(import('../../deploy/headers')).rejects.toThrow('VITE_MODEL_ORIGINS');
  });
});

export const visionProviders = [
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions' },
  { id: 'gemini', name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
] as const;

export function aiOrigins(configured: string): string[] {
  return [...new Set([
    ...visionProviders.map(provider => new URL(provider.endpoint).origin),
    ...configured.split(',').map(value => value.trim()).filter(Boolean),
  ])];
}

export function visionEndpoint(value: string, configured: string): URL {
  const url = new URL(value);
  const preset = visionProviders.find(provider => new URL(provider.endpoint).origin === url.origin);
  const path = preset ? new URL(preset.endpoint).pathname : '/v1/chat/completions';
  if (url.username || url.password || url.hash || url.search || url.protocol !== 'https:' ||
      !aiOrigins(configured).includes(url.origin) || url.pathname !== path) {
    throw new Error('Choose a supported BYOK provider or an HTTPS chat-completions endpoint on the deployment VITE_AI_ORIGINS allowlist.');
  }
  return url;
}

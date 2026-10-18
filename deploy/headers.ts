const s3Origins = (process.env.VITE_S3_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
for (const origin of s3Origins) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('VITE_S3_ORIGINS must contain exact HTTPS origins, separated by commas.');
}

export const productionHeaders = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self'${s3Origins.length ? ` ${s3Origins.join(' ')}` : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
} satisfies Record<string, string>;

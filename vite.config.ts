import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { productionHeaders } from './deploy/headers.ts';

function offlineShell(): Plugin {
  let base = '/';
  return {
    name: 'annotator-offline-shell',
    configResolved(config) { base = config.base; },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: productionHeaders['Content-Security-Policy'].split('; ')
          .filter(directive => !directive.startsWith('frame-ancestors ')).join('; '),
      }, injectTo: 'head-prepend' }];
    },
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(file =>
        file === 'index.html' || file === 'manifest.webmanifest' ||
        /^assets\/.+\.(?:js|css|wasm|svg|woff2?)$/.test(file),
      ).sort();
      const hash = createHash('sha256');
      for (const file of files) {
        const output = bundle[file]!;
        hash.update(file).update(output.type === 'chunk' ? output.code : output.source);
      }
      const cacheVersion = hash.digest('hex').slice(0, 24);
      const prefix = `annotator-app-shell-${encodeURIComponent(base)}-`;
      const paths = [...new Set([base, `${base}manifest.webmanifest`, ...files.map(file => `${base}${file}`)])];
      const source = `
const PREFIX = ${JSON.stringify(prefix)};
const CACHE = PREFIX + ${JSON.stringify(cacheVersion)};
const BASE = ${JSON.stringify(base)};
const SHELL_PATHS = ${JSON.stringify(paths)};
const ASSETS = new Set(SHELL_PATHS.map(path => new URL(path, self.location.origin).pathname));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL_PATHS.map(path => new URL(path, self.location.origin)));
  })());
});
self.addEventListener('message', event => {
  if (event.data === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(url.href, { ignoreVary: true })) ||
        (await cache.match(new URL(BASE, self.location.origin).href, { ignoreVary: true })) ||
        fetch(request);
    })());
    return;
  }
  if (ASSETS.has(url.pathname)) {
    event.respondWith((async () =>
      (await caches.open(CACHE)).match(url.href, { ignoreVary: true }) || fetch(request))());
  }
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' });
    },
  };
}

export default defineConfig({
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    headers: {
      ...productionHeaders,
      'Content-Security-Policy': productionHeaders['Content-Security-Policy']
        .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
    },
  },
  preview: { host: '127.0.0.1', strictPort: true, headers: productionHeaders },
  build: { target: 'es2023', sourcemap: false },
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [{ ...offlineShell(), apply: 'build' }],
});

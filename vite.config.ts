import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { productionHeaders } from './deploy/headers.ts';

function offlineShell(): Plugin {
  return {
    name: 'annotator-offline-shell',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(file =>
        file === 'index.html' || file === 'manifest.webmanifest' ||
        /^assets\/.+\.(?:js|css|wasm|svg|woff2?)$/.test(file),
      ).sort();
      const cacheVersion = files.join('|').replace(/[^a-zA-Z0-9|.-]/g, '').slice(-120);
      const paths = ['/', ...files.map(file => `/${file}`)];
      const source = `
const CACHE = ${JSON.stringify(`annotator-app-shell-${cacheVersion}`)};
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
      if (name.startsWith('annotator-app-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(url.href, { ignoreVary: true })) ||
        (await cache.match(new URL('/', self.location.origin).href, { ignoreVary: true })) ||
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
  plugins: [offlineShell()],
});

# Static hosting

Build with `npm run build` and serve `dist/` over HTTPS (or trustworthy localhost during development). Do not launch from `file://`.

The canonical production response headers are in [headers.ts](headers.ts). Apply them to HTML and relevant asset responses through your host's configuration. `npm run preview` applies the same headers for local verification; it is not a production server.

- Serve `.wasm` as `application/wasm`, module scripts as JavaScript, and CSS as `text/css`; preserve `X-Content-Type-Options: nosniff`.
- Self-host every generated asset, including the SQLite WASM and worker dependencies.
- Keep CSP's `wasm-unsafe-eval` permission narrowly for SQLite WASM compilation. There is no general `unsafe-eval` or production `unsafe-inline`.
- `img-src` permits local blob previews. `connect-src 'self'` permits the SQLite asset load, not a privacy air gap.
- This spike selects SAH pool/single-writer SQLite and **does not require COOP/COEP** in verified Chromium. Re-evaluate headers if changing VFS or adding OAuth.
- The app-shell service worker is installed only after an explicit user action. It precaches the versioned static shell and serves cached shell assets for offline use; it does not cache workspace data. Test installation, reload, and update behavior on the actual host because server routing and headers can differ from `npm run preview`.
- Configure SPA fallback to `index.html` only for document routes, not missing worker/WASM assets.
- Do not add analytics, remote CSP reporting endpoints, or crash telemetry. Avoid sensitive access-log fields; the app never intentionally puts dataset names or keys into request URLs.

Verify your actual deployment with the browser suite and inspect response headers. Build success alone does not verify hosting behavior.

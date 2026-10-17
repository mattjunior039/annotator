# Static hosting

Build with `npm run build` and serve `dist/` over HTTPS (or trustworthy localhost during development). Do not launch from `file://`.

## GitHub Pages

The repository includes [a Pages deployment workflow](../.github/workflows/pages.yml). In GitHub, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. Push the changes to `master` or `main`, or run **Deploy GitHub Pages** manually from **Actions**. The workflow installs locked dependencies, runs unit tests and a Pages-style browser test, builds for the base path returned by GitHub, uploads only `dist/`, and deploys through the `github-pages` environment.

For `mattjunior039/annotator`, the default site address is **https://mattjunior039.github.io/annotator/**. Custom domains and user/organization root sites use the base path reported by Pages instead. Repository/organization policy and plan must permit Pages and Actions; environment protection rules may require approval. The repository's Pages setting is a one-time GitHub configuration, not something committed application files can enable.

Vite rewrites assets and the web manifest for the selected path. Worker/WASM assets remain self-hosted, and the service worker registers only inside that path. Cache names and cleanup are scoped by the build base path, so a sibling Pages app's shell cache is not deleted. The manifest uses relative launch/scope URLs. `.nojekyll` is included for static hosting. The current app has no URL-based workspace routes, so it needs no custom 404/SPA redirect hack.

To reproduce a subpath build manually:

```sh
npm run build -- --base /annotator/
npm run preview
```

Or set `VITE_BASE_PATH=/annotator/` when building. Keep the leading/trailing slash. The default remains `/` for localhost or root-domain hosting. Run `npm run test:pages` to test `/annotator/` on a static server without custom security headers, including local persistence and offline reload. The test uses port 4186 by default (`PAGES_TEST_PORT` overrides it).

**Security-header limitations:** GitHub Pages does not support this app's custom response headers. Production HTML therefore includes the supported CSP directives in an early `<meta http-equiv="Content-Security-Policy">`, plus the existing no-referrer meta policy. `frame-ancestors`, `X-Content-Type-Options`, `Permissions-Policy`, and response-level cache controls cannot be enforced this way; worker responses also lack the custom header policy. The richer headers below still apply to Vite preview or a configurable host. Use a host/reverse proxy with header support if those controls are required. Pages compatibility is not independent security certification or a stronger offline/privacy guarantee.

**Data remains local:** deploying publishes app assets, not browser workspaces. GitHub serves the app and can observe normal asset requests; image intake/annotation remains local. Workspaces at localhost do not automatically appear at the Pages origin. Make an encrypted backup locally, then restore it in a new workspace on Pages. Browser storage is origin-scoped, not repository-path-scoped: other apps at the same `username.github.io` origin share that trust boundary. Use a dedicated origin/custom domain for stronger separation; a repository subpath is not security isolation. Changing domains also changes which local storage is accessible.

## Configurable static hosts

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

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

## Live share signaling relay

For persistent, approval-based S3 sharing instead of live sessions, configure exact allowed storage origins and bucket CORS as described in [persistent-sharing.md](../docs/persistent-sharing.md#s3-deployment). The Pages build reads the repository Actions variable `VITE_S3_ORIGINS`; no external S3 origin is enabled by default. No backend accounts or bucket credentials are deployed.

Cloud vision is opt-in per crop. Built-in BYOK presets permit `https://api.openai.com`, `https://generativelanguage.googleapis.com` and `https://openrouter.ai` by default, without initiating requests. Custom OpenAI-compatible destinations additionally require an exact HTTPS origin in `VITE_AI_ORIGINS`. Configure it at build and hosting time so the app's endpoint allowlist and CSP `connect-src` match; the Pages workflow reads the same Actions variable. Each request still requires a user-supplied API key, vision model ID and explicit preview consent. Provider billing, availability and browser CORS apply; there is no server proxy or editor-subscription login.

The optional MCP browser connection permits only `http://127.0.0.1:47321` (Copilot) and `http://127.0.0.1:47322` (Antigravity) in the default CSP. The app does not start the companion. Follow [its installation and pairing instructions](../services/bridge/README.md), using the exact deployed origin in the generated editor configuration. Real HTTPS-to-loopback permission behavior must be verified on the deployed site and browser; never bypass browser security.

Encrypted file exchange needs no storage service or extra CSP origins. Users transfer the downloaded ciphertext themselves and communicate its secret separately. See [the file workflow](../docs/persistent-sharing.md#send-images-or-a-folder-to-a-friend-without-an-account).

Local object detection is opt-in and downloads a pinned 20.9 MB Apache-2.0 model from Hugging Face only after a separate user action and license acknowledgment. Configure `VITE_MODEL_ORIGINS` with exact HTTPS origins required by the model host and its redirects (at minimum `https://huggingface.co`); a current browser test also required `https://us.aws.cdn.hf.co`. Redirect hosts can vary, so inspect network requests during staging and allow only observed hosts. The Pages workflow reads the same Actions variable. The model is cached by browser storage and remains subject to browser eviction. The 26.9 MB ONNX WASM runtime is bundled and self-hosted; it is fetched and cached by the service worker only when inference is explicitly invoked. Inference itself runs in a dedicated local worker; no crop is sent by this path.

Live share needs a small WebSocket relay at `/signal` on the app's origin. The static site cannot provide it, so it runs as a separate Cloudflare Worker with a Durable Object, on a route of the same domain. `easyannotate.online` already uses Cloudflare nameservers and is proxied, so a route works without changing DNS or Pages.

One-time deploy:

```sh
cd services/signaling
npx wrangler login          # opens a browser to authorize your Cloudflare account
npx wrangler deploy         # publishes worker.ts and the SignalingRoom Durable Object
```

[wrangler.toml](../services/signaling/wrangler.toml) sets these:

- **Route** `easyannotate.online/signal*`. Only this path goes to the Worker; every other request still goes to GitHub Pages.
- **`ALLOWED_ORIGINS`** `https://easyannotate.online`. WebSocket upgrades from other origins get a 403. Use a comma-separated list to add staging origins.
- **Durable Object** `SignalingRoom`, using the free-tier-compatible SQLite class. One instance per room.

To verify the deployment, `curl -i https://easyannotate.online/signal` should return `426 WebSocket upgrade required.` Then start a live session in the app and open the invite link in a second browser.

Notes:

- The CSP `connect-src 'self'` already covers `wss://easyannotate.online/signal`. No CSP change is needed.
- Direct mode uses `stun:stun.cloudflare.com:3478`. To use your own STUN/TURN servers, build with `VITE_ICE_SERVERS='[{"urls":"turn:…","username":"…","credential":"…"}]'`. Do not bundle long-lived TURN secrets.
- To point a build at a relay on a different host, set `VITE_SIGNALING_URL`, and also allow that origin in `connect-src`.
- For local development, run `npm run signaling` (port 8787). The Vite dev and preview servers proxy `/signal` to it; `SIGNALING_PORT` overrides the port.
- The relay keeps no data. Cloudflare can still observe connection IPs, timing, room IDs, and ciphertext sizes. See [live-collaboration.md](../docs/live-collaboration.md).

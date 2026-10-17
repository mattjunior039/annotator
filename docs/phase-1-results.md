# Phase 1 results and handoff

## Delivered

- Runnable React/TypeScript foundation lab with real capability detection, explicit proof controls, production CSP/headers, local assets, and VS Code build/preview tasks.
- Minimal photo-first setup UI with Detection, Segmentation, Classification, and Keypoints choices; storage/browser proofs are hidden in a collapsed developer section. The selection is setup-only and does not imply drawing tools exist.
- Strict versioned domain schemas for workspaces, datasets, images, classes, skeletons, all planned annotation kinds, and review states.
- Canonical geometry and revision-bound command/undo/redo contracts, independent of rendering libraries.
- Real worker-owned SQLite WASM `opfs-sahpool` persistence with encrypted records/media, passphrase wrapping, purpose-separated HKDF keys, authenticated chunk framing, single-writer exclusion, and interrupted-write recovery.
- Worker-based JPEG/PNG/WebP rendered-sRGB-to-lossless-PNG sanitizer with structural checks, metadata allowlist, pixel comparison, and independent fixture validation.
- Reproducible synthetic fixture/reference-corpus generators and a dependency/license inventory command.
- Architecture, privacy, experimental-format, hosting, and verification documentation.

## Validation

| Check | Result |
|---|---|
| Strict TypeScript check | Pass |
| Type-checked Vite production build | Pass |
| Vitest | 24 tests across 4 files pass |
| Playwright, production build | 8 Chromium tests pass |
| Actual OPFS persistence and SQLite WASM under production CSP | Pass, without COOP/COEP |
| Wrong passphrase and authenticated-object tampering | Rejected |
| Single-writer contention and worker/tab termination | Pass |
| Interrupted media write before SQL commit | Unreferenced ciphertext recovered; committed record retained |
| Closed app storage canary scan | No test note, passphrase, source filename, camera/serial canary, or PNG signature found |
| Orientation | All eight EXIF transforms match independent expected color samples/dimensions |
| Accepted rendered image round trips | Zero RGBA difference, excluding hidden RGB under fully transparent pixels |
| Uncertified ICC/16-bit/animated images | Explicitly rejected |
| Reference manifest | 10,000 descriptors generated; full dataset images not materialized or imported |
| Dependency inventory | CycloneDX generation verified; 55 components on the validation installation |

Initial package installation reported no known vulnerabilities. This is package-manager advisory output, not a security audit. Runtime dependencies React/React DOM/Zod are MIT; the SQLite WASM package wrapper is Apache-2.0 with upstream notices preserved. Sharp is an Apache-2.0 development-only fixture tool; its bundled libvips/native dependencies have their own license notices and are not shipped in the browser bundle.

## Reference feasibility measurement

Single test run, Chromium 156.0.8078.4 headless, Apple M5 Pro / 15 logical cores / 24 GiB RAM, Darwin 27.0.0. Fixture `synthetic-blocks-v1`, 2048 x 1536 pixels:

| Measurement | Observed |
|---|---|
| Encoded source PNG | 74,743 bytes |
| Sanitized PNG | 66,678 bytes |
| Maximum rendered-pixel difference | 0 |
| Create/open/wrap UI wall time | About 232 ms |
| Sanitization UI wall time | About 184 ms |
| Save UI wall time | About 51 ms |
| Worker-reported acknowledged commit | 10 ms |
| Reopen/unlock UI wall time | About 211 ms |
| Restored sanitized object | Byte-identical |

These are feasibility observations, **not p95 guarantees or throughput/memory benchmarks**. UI wall times include Playwright interactions and initialization. This is one compressible image, not a representative 10,000-image import. Re-running tests naturally changes timings. The browser JSON report includes the run's raw measurement attachment.

## Deliberate proof limits

- Synthetic/disposable data only; experimental format, not independently audited.
- One proof vault, at most 100 records, one in-flight operation per worker, 45-second deadline.
- 4-megapixel/8-MiB media and 8-MiB authenticated object bounds.
- Browser-rendered sRGB fidelity only, not archival, wide-gamut, or diagnostic-medical fidelity.
- Crypto and storage share one dedicated worker in the spike; media owns its own worker.
- Objects are chunk-authenticated but bounded in memory; a full streaming file interface is not yet implemented.
- Recovery proof covers a specific media-before-record boundary and committed tab-close persistence, not exhaustive physical power loss or every migration/write boundary.
- No folder workspace, drawing tools, durable search catalog, backup/restore feature, service-worker offline installation, connected modes, or AI.
- Task-type selection is setup UI only; it does not create or draw annotations.
- OPFS loss, a lost passphrase, compromised runtime, and original source files remain outside vault guarantees.

## Phase 2 handoff

Phase 1 establishes feasibility for the explicit certified subset. Before handling real datasets, Phase 2 must implement the planned dataset/vault lifecycle: bounded folder intake, quota/persistence handling, staged migrations, backups/restoration, catalog/gallery, derivatives, broader codec certification or explicit supported-format gates, and expanded crash testing.

Do not infer release-scale memory or performance compliance from these proofs. Phase 2 has not started; continue only on explicit user direction.

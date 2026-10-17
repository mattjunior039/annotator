# Verification and benchmark method

## Automated coverage

- Unit tests: eight EXIF geometry transforms, 1,000 viewport round trips, polygon constraints, strict schemas/references/bounds, mask/keypoint/label contracts, revision-bound undo/redo ordering and limits.
- Shared-schema tests: name-based reconciliation with stable canonical IDs, keypoint remapping by name, absent added points, additive/idempotent merges, no input mutation, and explicit rejection of conflicting definitions, duplicate names, stale revisions, and destructive edits.
- Crypto tests: AES-256-GCM NIST empty-input vector, wrapping/unlock, wrong passphrase, header binding, no-password device-key reopen/non-extractable import/wrong-key rejection, empty/exact/partial chunks, fresh generations, mutation, truncation, reordering, substitution, and trailing bytes.
- Structural media tests: PNG CRC vector, output allowlist, malformed/truncated headers, animation/color/depth rejection, source/decoded size guards.
- Worker lifecycle tests: one in-flight request, validated envelopes/results, unexpected IDs, controlled errors, lock termination, and deadline behavior with unknown commit outcome.
- Workspace-dashboard browser regression: separate named protected/no-password datasets, password confirmation, direct opening after creation, exit/reload/reopen, wrong password isolation, independent annotations/removal, honest Sharing disclosure, no-password security disclosure, no initial photo picker, and desktop/tablet/narrow-screen layout with a maximum-length workspace name.
- Legacy migration browser regressions: a catalog-free schema-3 dataset and a schema-4 SQL catalog migrate to the independent JSON catalog and encrypted shared schema. Preparation is interrupted before schema publication, then restarted on reload; image-by-image scanning runs again rather than accepting a partial schema. **Existing workspace** retains its original passphrase, annotations, and byte-identical encrypted media; previous UUID workspaces remain accessible with their original protection settings.
- Shared-schema browser regression: define classes before intake, import multiple images, add skeleton points on different images, verify exact preservation of the originally saved point coordinates, add later images, and reopen after reload. Every exported document has identical class/skeleton definitions. Direct worker calls reject stale/destructive schema changes and per-image schema overwrites. Empty-dataset encrypted backup/restore preserves otherwise unreferenced classes after destination reload.
- Storage-lock browser regressions: closing developer tools releases the legacy writer without losing committed proof data; the dashboard lists/creates workspaces while another tab edits; different datasets edit concurrently with annotations surviving reopen; simultaneous creation in two tabs retains both catalog entries after reload; a second editor of the same dataset is rejected and can retry after exit/termination without reloading. No editing lease is forcibly taken over.
- Production browser tests: real SQLite SAH pool and WASM loading under CSP without COOP/COEP; worker lock/reload; wrong keys; synthetic interruption and actual orphan-file cleanup with committed media/record survival; no plaintext sensitive canaries or PNG signature in closed OPFS; no unexpected localStorage, sessionStorage, IndexedDB, or Cache Storage. Ciphertext canary checks apply to password-protected storage, not access protection for a locally persisted no-password key.
- Media browser tests: JPEG EXIF orientations 1-8, PNG/WebP metadata, alpha, independent output inspection with Sharp, and explicit unsupported-input failures.
- YOLOv8 browser test: folder import pairs split images and normalized detection labels, preserves class names/splits, adds images later, exports new sanitized PNG/label folders, and removes workspace copies while verifying the source labels remain unchanged.
- Editor browser test: measurable desktop/laptop canvas dimensions, overlapping box creation, move/resize and undo/redo, drawing at zoom, panning/fit, saved-image navigation, polygon vertex editing, keyboard deletion, and narrow-screen overflow checks. Geometry unit tests verify bounded translation and all four box resize corners.
- Mixed-mode browser test: image-label toggle, multi-point skeleton placement and handle editing, image URL validity after repeated saves, review/search filters, all six export formats, image-inclusive versus annotations-only output, current-image versus whole-dataset scope, and no files created for incompatible annotations. XML is parsed with the browser parser and aggregate COCO JSON is parsed as a complete document. Export unit tests verify normalized polygons, COCO IDs/areas/bounds, VOC coordinates/escaping/boolean flags, CSV quoting, native document preservation, empty annotations, and explicit rejection of incompatible mask formats.
- Reference feasibility test: one 2048 x 1536 synthetic image, timed create/sanitize/save/unlock actions, byte-identical media restoration, and raw measurements attached to the JSON browser report.
- Hosting tests check production CSP/referrer/nosniff and lack of third-party requests during the checked path.
- `npm run test:pages` builds at `/annotator/` and serves plain static files with no custom response headers or SPA fallback. It verifies the early HTML CSP, repository-relative manifest launch/scope, module/worker/WASM requests staying under the repository path, real SQLite/OPFS image/annotation persistence, path-scoped app-shell installation/cache contents, and offline reload/reopen. It does not certify GitHub's actual deployment settings, headers, availability, or all browsers; the workflow must first be enabled as the Pages source.
- Encrypted-backup unit tests: mixed annotation/schema/revision/path/split round trip, no plaintext canaries, wrong passphrase, missing completion header, corrupted/truncated manifest/record/media, cross-object/archive substitution, duplicate writer records, failed write readback, media dimension mismatch, mask-reference rejection, empty archive, destination-key/media rebinding, bounded/versioned/KDF header rejection, immutable completion, and refusal to overwrite an existing completion header. Manifest authentication is tested even after updating its unkeyed public ciphertext digest.
- Backup/lifecycle production Chromium test: actual structured-cloned directory handles and OPFS files (the picker alone is redirected to a synthetic test folder); backup passphrase confirmation; separate destination vault/passphrase; wrong backup passphrase; damaged-media rejection and staged-file cleanup; reload after the first staged image before publication; cancellation after staging without publishing any images; complete verified restore surviving reload; nonempty-destination rejection at the worker boundary; premature finalization, wrong session, out-of-order steps, and active-session mutation rejection; no completion header on cancellation; workspace passphrase-change failure/success; old passphrase rejection; saved images surviving rewrap. Crypto tests verify saved ciphertext remains readable after passphrase change, fresh wrapping salt/nonce, and archive/workspace purpose separation.
- Binary-mask unit/browser tests: exact 256 x 256 binary tile sizes, cross-tile strokes, boundary padding, immutable paint/erase, invalid radii/coordinates/pixels, exact column-major RLE area/counts, undo/redo, visibility/locking/attributes, reload, native sidecars, encrypted backup/restore, and root rotation. Missing/corrupt backup tiles fail rather than produce empty masks.
- Interchange tests: native IDs/properties/attributes and exact binary payloads; COCO boxes/polygons/keypoint visibility and exact RLE round trips with crowd semantics; normalized YOLO detection/segmentation; rejection of duplicate/missing IDs, unsafe paths, dimensions, compressed RLE, multipart topology, and custom COCO attributes. A real staged import with a valid first document and invalid later dimensions publishes neither; reload retains the original review states. A valid batch publishes together. Browser VOC tests reject DTDs and check one-based inclusive coordinates.
- Lifecycle tests: manual and clock-driven inactivity lock; revoked recovery-secret rejection followed by successful new-file recovery and old/new passphrase checks; staged key rotation with exact mask preservation, old-passphrase rejection, and thumbnail regeneration; reload after the first staged rotation image preserves the old passphrase and cleans newly encrypted objects.
- Catalog/resource-bound tests: 101 synthetic small images, full-dataset search beyond the first page, at most 100 gallery/editor rows, gallery/editor-search pagination, and access to the last matching image. This verifies bounds and correctness, **not** 10,000-image latency/memory performance.
- Derivative tests: explicit page-limited preview generation, persisted `thumbnail` envelopes, byte-identical cached ciphertext on reopen, revoked blob URLs on lock, and no remaining image/thumbnail files after image removal.
- Intake tests: an almost-full estimated origin refuses intake before adding images; interrupted intake after the first committed image resumes from encrypted input checkpoints after reload, retains subsequent annotations, and imports changed same-name bytes as a different input. Quota estimates are not reservations; actual mid-write quota/permission/power-loss fault matrices remain open.
- Deletion tests: exact-name confirmation, active-editor refusal, removal of the selected dataset's explicit SQLite/media namespaces, catalog preservation, and no reappearance after reload. Retry markers are implemented; every possible deletion boundary still requires fault injection.
- Offline all-tools path: physically disabled Playwright context networking after shell installation; unlock, box/polygon/label/keypoint/mask/erase/undo, reload with committed shapes, encrypted previews, and native export with mask sidecars. It is a tested Chromium path, not a universal browser or air-gap claim.

The VS Code test tool may not discover Vitest in a fresh installation; `npm test` is the repository's authoritative unit runner.

## Image fidelity contract

The worker decodes once using the browser's color/orientation handling, draws to an sRGB canvas, creates fresh PNG bytes, independently checks container chunks/CRCs, re-decodes the PNG, and compares rendered RGBA.

Accepted output has zero difference from the initial sRGB canvas readback, ignoring RGB beneath fully transparent pixels. This verifies a rendered-pixel round trip, not equality to original compressed bytes, hidden RGB under alpha, unconverted source color values, or diagnostic/archival fidelity.

Orientation tests additionally check known source color blocks and dimensions independently; they do not merely compare the sanitizer to itself. ICC and 16-bit input require a future certified codec/color decision and are rejected.

Generated fixtures contain artificial camera serial, timestamp, artist, and GPS EXIF. Output inspection uses Sharp metadata (a separate parser) and raw canary searches in addition to the runtime chunk allowlist.

## Reference corpus v1

`npm run benchmark:corpus` writes a manifest for 10,000 deterministic 2048 x 1536 synthetic PNGs. Generation algorithm `synthetic-bands-v1`:

```text
seed = index + 1
R = (floor(x/64)*17 + seed) mod 256
G = (floor(y/64)*23 + seed*7) mod 256
B = (floor((x+y)/128)*31 + seed*11) mod 256
```

Optional materialization uses Sharp PNG compression level 6, adaptive filtering off, one image at a time. The manifest captures Sharp/libvips versions, OS/CPU/RAM/Node, exact total encoded bytes, and per-file SHA-256 when images are actually generated. Output is a fixed scoped directory under `benchmarks/generated`; existing images are never overwritten. Retain that manifest with benchmark results.

The default manifest-only run is a catalog fixture, **not an import or decode benchmark**. The high-compressibility synthetic corpus must eventually be supplemented with documented non-sensitive higher-entropy and large-image cases.

## Measurement protocol for subsequent phases

Record the exact browser version, headless/headed mode, hardware, fixture manifest, production build version, and cold/warm state. Measure renderer and workers/WASM, byte-budgeted caches, and decoded bitmaps where platform instrumentation permits. Do not report main-thread JS heap alone as total memory.

Later gates remain: first-image readiness, the 768 MiB reference memory budget, p95 pointer-to-render below 50 ms, p95 ordinary edit commits below 250 ms, and no growing resources after repeated navigation. The current editor/catalog exists but has not passed these 10,000-image release measurements. Archive tests use a small synthetic dataset, not a quota/power-loss/large-backup certification.

Use a new browser profile for isolation and explicit network capture for stronger no-egress checks. This suite is not host-level packet inspection, and absence of tested requests does not prove a mathematical air gap.

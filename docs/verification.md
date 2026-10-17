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
- Mixed-mode browser test: image-label toggle, multi-point skeleton placement and handle editing, image URL validity after repeated saves, review/search filters, all six export formats, image-inclusive versus annotations-only output, current-image versus whole-dataset scope, and no files created for incompatible annotations. XML is parsed with the browser parser and aggregate COCO JSON is parsed as a complete document. Export unit tests verify normalized polygons, COCO IDs/areas/bounds, VOC coordinates/escaping, CSV quoting, native document preservation, empty annotations, and explicit mask rejection.
- Reference feasibility test: one 2048 x 1536 synthetic image, timed create/sanitize/save/unlock actions, byte-identical media restoration, and raw measurements attached to the JSON browser report.
- Hosting tests check production CSP/referrer/nosniff and lack of third-party requests during the checked path.
- Encrypted-backup unit tests: mixed annotation/schema/revision/path/split round trip, no plaintext canaries, wrong passphrase, missing completion header, corrupted/truncated manifest/record/media, cross-object/archive substitution, duplicate writer records, failed write readback, media dimension mismatch, mask-reference rejection, empty archive, destination-key/media rebinding, bounded/versioned/KDF header rejection, immutable completion, and refusal to overwrite an existing completion header. Manifest authentication is tested even after updating its unkeyed public ciphertext digest.
- Backup/lifecycle production Chromium test: actual structured-cloned directory handles and OPFS files (the picker alone is redirected to a synthetic test folder); backup passphrase confirmation; separate destination vault/passphrase; wrong backup passphrase; damaged-media rejection and staged-file cleanup; reload after the first staged image before publication; cancellation after staging without publishing any images; complete verified restore surviving reload; nonempty-destination rejection at the worker boundary; premature finalization, wrong session, out-of-order steps, and active-session mutation rejection; no completion header on cancellation; workspace passphrase-change failure/success; old passphrase rejection; saved images surviving rewrap. Crypto tests verify saved ciphertext remains readable after passphrase change, fresh wrapping salt/nonce, and archive/workspace purpose separation.

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

# Verification and benchmark method

## Automated coverage

- Unit tests: eight EXIF geometry transforms, 1,000 viewport round trips, polygon constraints, strict schemas/references/bounds, mask/keypoint/line/label contracts, revision-bound undo/redo ordering and limits.
- Shared-schema tests: name-based reconciliation with stable canonical IDs, keypoint remapping by name, absent added points, additive/idempotent merges, no input mutation, and explicit rejection of conflicting definitions, duplicate names, stale revisions, and unapproved destructive edits. Migration tests cover used-class remapping versus unused removal, label-merge conflicts without annotation deletion, legacy IDs/point orders, reorder/rename/removal coordinate preservation, occupied versus absent placeholders, and invalid remaps/point definitions.
- Migration storage/browser tests: injected second-record staging failure and publication failure roll back every record/schema and clear ciphertext-only staging; successful rewrites increment revisions while preserving named coordinates, image identity, review, paths, media references, and annotation counts. Production Chromium exercises no-confirmation unused removal/class merge/reorder, exact per-image loss counts, required coordinate-discard confirmation, cancellation, reload, stale preview after image edits, replay rejection, and old-save refusal. These targeted faults do not certify every quota/power-loss boundary.
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
- Editor browser test: measurable desktop/laptop canvas dimensions, overlapping box creation, move/resize and undo/redo, drawing at zoom, panning/fit, saved-image navigation, polygon draft fill/closing-edge preview and click-first-vertex closure, polygon vertex editing, line endpoint and whole-line editing, keyboard deletion, and narrow-screen overflow checks. Geometry unit tests verify bounded translation and all four box resize corners.
- Mixed-mode browser test: image-label toggle, multi-point skeleton placement and handle editing, image URL validity after repeated saves, review/search filters, all six export formats, image-inclusive versus annotations-only output, current-image versus whole-dataset scope, and no files created for incompatible annotations. XML is parsed with the browser parser and aggregate COCO JSON is parsed as a complete document. Export unit tests verify normalized polygons, COCO IDs/areas/bounds, VOC coordinates/escaping/boolean flags, CSV quoting, native document preservation, empty annotations, and explicit rejection of incompatible mask formats.
- Reference feasibility test: one 2048 x 1536 synthetic image, timed create/sanitize/save/unlock actions, byte-identical media restoration, and raw measurements attached to the JSON browser report.
- Hosting tests check production CSP/referrer/nosniff and lack of third-party requests during the checked path.
- `npm run test:pages` builds at `/annotator/` and serves plain static files with no custom response headers or SPA fallback. It verifies the early HTML CSP, repository-relative manifest launch/scope, module/worker/WASM requests staying under the repository path, real SQLite/OPFS image/annotation persistence, path-scoped app-shell installation/cache contents, and offline reload/reopen. It does not certify GitHub's actual deployment settings, headers, availability, or all browsers; the workflow must first be enabled as the Pages source.
- Encrypted-backup unit tests: mixed annotation/schema/revision/path/split round trip, no plaintext canaries, wrong passphrase, missing completion header, corrupted/truncated manifest/record/media, cross-object/archive substitution, duplicate writer records, failed write readback, media dimension mismatch, mask-reference rejection, empty archive, destination-key/media rebinding, bounded/versioned/KDF header rejection, immutable completion, and refusal to overwrite an existing completion header. Manifest authentication is tested even after updating its unkeyed public ciphertext digest.
- Backup/lifecycle production Chromium test: actual structured-cloned directory handles and OPFS files (the picker alone is redirected to a synthetic test folder); backup passphrase confirmation; separate destination vault/passphrase; wrong backup passphrase; damaged-media rejection and staged-file cleanup; reload after the first staged image before publication; cancellation after staging without publishing any images; complete verified restore surviving reload; nonempty-destination rejection at the worker boundary; premature finalization, wrong session, out-of-order steps, and active-session mutation rejection; no completion header on cancellation; workspace passphrase-change failure/success; old passphrase rejection; saved images surviving rewrap. Crypto tests verify saved ciphertext remains readable after passphrase change, fresh wrapping salt/nonce, and archive/workspace purpose separation.
- Binary-mask unit/browser tests: exact 256 x 256 binary tile sizes, cross-tile strokes, boundary padding, immutable paint/erase, invalid radii/coordinates/pixels, exact column-major RLE area/counts, undo/redo, visibility/locking/attributes, reload, native sidecars, encrypted backup/restore, and root rotation. Missing/corrupt backup tiles fail rather than produce empty masks.
- Interchange tests: native IDs/properties/attributes and exact binary payloads; CSV line geometry; COCO boxes/polygons/keypoint visibility and exact RLE round trips with crowd semantics; normalized YOLO detection/segmentation; rejection of duplicate/missing IDs, unsafe paths, dimensions, compressed RLE, multipart topology, and custom COCO attributes. A real staged import with a valid first document and invalid later dimensions publishes neither; reload retains the original review states. A valid batch publishes together. Browser VOC tests reject DTDs and check one-based inclusive coordinates.
- Lifecycle tests: manual and clock-driven inactivity lock; revoked recovery-secret rejection followed by successful new-file recovery and old/new passphrase checks; staged key rotation with exact mask preservation, old-passphrase rejection, and thumbnail regeneration; reload after the first staged rotation image preserves the old passphrase and cleans newly encrypted objects.
- Catalog/resource-bound tests: 101 synthetic small images, full-dataset search beyond the first page, at most 100 gallery/editor rows, gallery/editor-search pagination, and access to the last matching image. This verifies bounds and correctness, **not** 10,000-image latency/memory performance.
- Derivative tests: explicit page-limited preview generation, persisted `thumbnail` envelopes, byte-identical cached ciphertext on reopen, revoked blob URLs on lock, and no remaining image/thumbnail files after image removal.
- Intake tests: an almost-full estimated origin refuses intake before adding images; interrupted intake after the first committed image resumes from encrypted input checkpoints after reload, retains subsequent annotations, and imports changed same-name bytes as a different input. Quota estimates are not reservations; actual mid-write quota/permission/power-loss fault matrices remain open.
- Deletion tests: exact-name confirmation, active-editor refusal, removal of the selected dataset's explicit SQLite/media namespaces, catalog preservation, and no reappearance after reload. Retry markers are implemented; every possible deletion boundary still requires fault injection.
- Offline all-tools path: physically disabled Playwright context networking after shell installation; unlock, box/polygon/label/keypoint/mask/erase/undo, reload with committed shapes, encrypted previews, and native export with mask sidecars. It is a tested Chromium path, not a universal browser or air-gap claim.

The VS Code test tool may not discover Vitest in a fresh installation; `npm test` is the repository's authoritative unit runner.

### Dataset-migration focused snapshot (2026-10-17)

- `npm test -- src/domain/dataset-schema.test.ts src/storage/schema-migration.test.ts`: **14 tests passed**.
- `npm run check`: passed.
- `PLAYWRIGHT_PORT=45689 npx playwright test --grep 'schema migrations|dataset classes and skeletons stay shared|schema [34] catalogs|encrypted backup restores shared definitions' --output .schema-migration-results --reporter list --trace off`: **6 Chromium tests passed**, including the production build/type check. The isolated output directory avoids interference from other concurrent browser runs.
- This validates only the listed migration/shared-schema/legacy/empty-backup paths, not the complete release fault matrix or scale gates.

### Complete local verification snapshot (2026-10-17; refreshed after schema migration and accessibility updates)

- `npm run check`, `npm run build`, and `npm test -- --run`: passed; 78 unit tests across 12 files.
- `npm run test:browser`: **37 Chromium tests passed**. This includes the browser migration/failure cases, shared-schema preservation, supported image codecs, and the corrected export/keypoint/mask flows.
- `npm run test:pages`: **1 passed**, covering repository-relative static hosting and offline reload.
- `npm run test:accessibility`: **1 passed**, including axe WCAG 2.2 AA checks on the workspace dashboard, dataset gallery/schema controls, export dialog, and editor, plus keyboard focus/shortcut checks. The expanded checks found and fixed invalid gallery list semantics and insufficient small-text contrast. This is automated coverage, not a manual screen-reader certification.
- Independent source security review: **no vulnerabilities found**. This is not a production penetration test or cryptographic certification.
- The full browser suite's synthetic PNG/JPEG/WebP coverage includes independent Sharp output inspection, metadata/alpha checks, EXIF orientation/color samples, and explicit unsupported-input rejection. ICC-profiled, 16-bit, and animated inputs remain rejected by policy; broader source-color fidelity is not claimed.

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

## Production browser resource benchmark

```sh
# Requires the existing npm dependencies and Playwright Chromium installation.
npm run benchmark:browser
# Quick automation check; deliberately NOT a reference-scale result:
npm run benchmark:browser -- --count 101 --size compact --edits 6 --navigation 6 --budget-seconds 180
```

`scripts/benchmark-browser.mjs` is independent of application source. It builds the
production application, starts a dedicated loopback preview (`--strictPort`), and
drives the normal UI in a fresh, password-protected Chromium workspace. It never
seeds application storage or substitutes worker responses. Defaults are **10,000
2048 × 1536 images**, batches of 100, 50 sequential image-label edits, and 30
distant-image navigations. A 1,800-second browser-work budget closes the browser
and records partial progress on timeout. Build/fixture preparation is outside
that browser budget. `--count`, `--size reference|compact`, `--batch` (1–100),
`--edits` (1–200), `--navigation` (1–200), `--budget-seconds`, and `--port` are
explicit run parameters. Reduced counts or `compact` (256 × 192) cannot satisfy
the reference workload.

Each invocation creates a fresh timestamp/UUID directory in
`benchmarks/generated/browser-*`; it does not touch `reference-corpus` or replace
previous reports. `report.json` contains raw batch/edit/resource samples, options,
browser/Node/Sharp/OS/CPU/host RAM/viewport metadata, and SHA-256 fingerprints of
the actual production build. `fixture.json` records reproducible image dimensions,
generator parameters, total logical encoded bytes and per-seed PNG hashes.
Generation uses the exact reference bands algorithm above. Its channels repeat
every 256 seeds, so only 256 encoded files are needed; subsequent catalog filenames
are hard links to identical pixel/PNG variants. One raw image is generated at a
time and Playwright receives at most 100 disk paths per selection. This avoids
allocating 10,000 raw buffers or serializing one huge browser upload. The benchmark
still sanitizes and stores **every image** through real UI intake; physical
fixture-file deduplication does not bypass application work.

Profiles, runtime scratch files, and fixture links are kept within the run
directory and removed after completion/failure. Raw reports, fixture hashes, and
build logs remain. Runtime reports are periodically checkpointed during intake;
a killed host/process can leave a `running` report and its isolated profile.
Such a report is incomplete, not a pass. Do not run concurrent builds against
the same checkout. Reserve the chosen port; another preview on it is rejected.

### Measurements and assertions

- **Intake:** per-batch wall time/rate from file selection to successful worker
  import acknowledgements and the completed UI notice. Overall wall time/rate
  additionally includes the first-image editor visit and resource checkpoints;
  summed batch-work time/rate is reported separately. This is bounded batched
  intake, not a single 10,000-file picker selection.
- **First-image readiness:** elapsed intake time until the first batch has
  completed and the first editor SVG image is visible and independently decoded.
  Editor-open/decode time is also separate. This is not first-image readiness
  during an ongoing intake batch.
- **Edit commit:** trusted UI label toggles, with request-to-worker-ack and
  click-to-worker-ack raw samples. Each edit waits for its acknowledgement,
  render opportunity, and the saved indicator before the next edit. A final
  reload/unlock verifies the tail image and the final label state. Acknowledgement
  does not establish power-loss/fsync durability.
- **Input/render opportunity:** capture a trusted click, observe the expected
  label DOM change, then wait two animation frames. This safely measurable proxy
  includes React scheduling but is **not** hardware input-to-photon, actual
  painted pixels, or continuous pointer-to-render latency. No claim is made for
  the pointer-drag release gate.
- **p95:** nearest-rank `ceil(0.95*N)` over all samples, including initial edits.
  Reports compare click-to-ack with 250 ms and click-to-render-opportunity with
  50 ms; slow timings remain recorded results, not rewritten as passes.
- **Rendered/catalog bounds:** sample after the first image, intake milestones,
  every navigation, and reload. Assert at most 100 gallery rows, 100 editor
  catalog results, one annotation SVG, four image elements, four live main-window
  object URLs, and two live workers. Navigate via distant filename searches,
  restore all matching results, and verify the catalog tail. Report URL creation/
  revocation/active/high-water counts, live workers, DOM counters, main-renderer
  JS heap, origin storage estimates, and whether URL/worker counts at the last
  navigation exceed the first navigation. Storage estimates are origin disk/quota
  estimates, not RAM. Samples are not continuous resource peaks.
- **Isolation:** new browser profile/origin, no preloaded app cache, and blocked/
  recorded off-origin browser requests. This is a synthetic local test, not
  host-level packet inspection.

### Memory and certification limits

CDP `Performance.getMetrics` JS heap and `Memory.getDOMCounters` are explicitly
labelled **main renderer only**. They exclude worker/WASM heaps, decoded bitmap
storage, GPU allocations, browser processes, and other native memory. Object URL
instrumentation covers the main window, not workers. The benchmark therefore
reports **no total-process-memory figure** and leaves the 768 MiB reference-memory
gate unmeasured. Host RAM is environment metadata only. A bounded rendered result
page is not proof of a bounded internal catalog allocation or absence of leaks.
Retain the raw navigation series rather than interpreting GC-dependent JS/DOM
counts as total memory.

The highly compressible synthetic corpus, one Chromium environment, automation
overhead, and sampled counters cannot certify release performance across devices,
large/high-entropy photographs, quota failures, pointer drags, or total memory.
Reports always keep `releaseCertification: false`; timing outcomes and incomplete
runs must be reported independently.

### Recorded local reference run — 2026-10-17

Raw results: [`benchmarks/results/2026-10-17-reference.json`](../benchmarks/results/2026-10-17-reference.json).
Command: `npm run benchmark:browser -- --budget-seconds 900`.
This completed all 10,000 reference-size images, 50 measured label edits, 30
distant-image navigations, and reload/unlock verification in headless Chromium
156.0.8078.4 on an Apple M5 Pro, Darwin 27.0.0, Node v26.10.0. This is one local
run on a shared host, not a controlled cross-device certification.

| Observation | Result |
| --- | --- |
| Logical encoded fixture bytes selected | 1,098,674,425 |
| Intake wall time / throughput | 750.95 s / 13.32 images/s |
| First decoded editor image from intake start | 7,983 ms |
| First editor open plus independent decode | 88.49 ms |
| p95 edit request → worker commit acknowledgement | 17.10 ms |
| p95 trusted click → worker commit acknowledgement | 17.20 ms |
| p95 trusted click → render-opportunity proxy | 49.80 ms |
| Maximum sampled gallery / editor catalog rows | 100 / 100 |
| Active main-window object URLs during all 30 navigations | 1 |
| Live workers during all 30 navigations | 2 |
| Maximum sampled main-renderer JS heap | 37,191,500 bytes; **not total memory** |

All 43 resource snapshots stayed within the documented rendered-resource bounds;
the run recorded no page runtime errors or blocked off-origin requests. The
50-ms proxy comparison was narrowly met and is not a pointer-drag result. Total
process memory and the 768 MiB gate remain unmeasured. A separate 101-image compact
smoke run validated the final runner's atomic report checkpoints and URL/worker
endpoint-growth reporting; its smaller timings are not reference-scale evidence.

## Remaining release measurements

Record the exact browser version, headless/headed mode, hardware, fixture manifest, production build version, and cold/warm state. Measure renderer and workers/WASM, byte-budgeted caches, and decoded bitmaps where platform instrumentation permits. Do not report main-thread JS heap alone as total memory.

The measured 88.49 ms editor-open/decode interval begins after the first 100-image
batch has completed, within the plan's 5-second post-intake readiness target.
The measured 17.20 ms click-to-worker-ack p95 is below the 250 ms ordinary-edit
target. The 49.80 ms click-to-render-opportunity proxy is not the plan's
1,000-vector pointer-to-paint measurement and is not counted as passing that
gate. Remaining release gates include the 768 MiB total reference-memory budget,
actual p95 pointer-to-render below 50 ms with 1,000 visible vectors, and
non-growing worker/WASM/decoded/GPU/native resources after repeated navigation.
These are not certified by main-renderer heap or DOM counters. Archive tests use
a small synthetic dataset, not a quota/power-loss/large-backup certification.

Use a new browser profile for isolation and explicit network capture for stronger no-egress checks. This suite is not host-level packet inspection, and absence of tested requests does not prove a mathematical air gap.

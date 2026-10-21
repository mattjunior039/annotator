# Private Annotator

A local-first image annotator under active development. The current build starts with a minimal workspace dashboard: create a named workspace, choose whether to password-protect it, then import and annotate its dataset. It is **not yet a complete or independently audited release**; use synthetic or non-sensitive data only.

## Current features

- Create separate named workspaces and reopen them from the dashboard. **Exit workspace** closes its workers and returns to the workspace list without deleting data.
- Choose password protection when creating each workspace. Protected workspaces require their passphrase when reopened; no-password workspaces open automatically in this browser profile. Their key is stored locally, so they do not protect against someone with access to that profile.
- Import a dataset folder or JPEG, PNG, and WebP images inside the selected workspace; the empty dataset also accepts image-file drops. Use **Add folder** for folders, including nested datasets.
- Import folders as a local dataset, add images later, and remove individual images from the encrypted workspace without deleting source files.
- Import YOLOv8 detection `data.yaml` class names and paired `images/` + `labels/` box annotations. Train/val/test splits are retained when detected.
- Export YOLO detection, YOLO polygon segmentation, COCO JSON, Pascal VOC XML, CSV, or native annotation JSON. Choose the whole dataset or current image, with sanitized PNG images or annotations only; export does not overwrite the source folder.
- Annotate with bounding boxes, polygons, straight line segments, tiled binary masks, image labels, and named keypoints; add classes, undo/redo, and set review state.
- Brush/erase masks with copy-on-write encrypted tiles. Selected instances have visibility, locking, primitive JSON attributes, polygon vertex controls, and keypoint visibility controls.
- Atomically import native JSON with mask sidecars, COCO boxes/simple polygons/uncompressed mask RLE/keypoints, Pascal VOC boxes, YOLO detection, and YOLO segmentation onto existing images.
- Manage shared dataset classes and named skeleton points. Additions apply to all images and future imports; existing keypoint coordinates are preserved.
- Use Dataset / Annotate / Export navigation, search/review filters, a compact drawing-tool rail, a large canvas, an active-class panel, zoom/pan, and previous/next image navigation. The Select tool moves shapes, resizes boxes, and adjusts polygon, line, and keypoint vertices.
- Store encrypted records and media in worker-owned SQLite WASM/OPFS storage. The app limits a workspace to 10,000 images, but that scale has not been performance-certified.
- Explicitly cache the static app shell for tested Chromium offline use. Dataset media and workspace records are not placed in Cache Storage.
- Inspect storage usage and optionally request persistent browser storage.
- Create encrypted dataset backups with an independent passphrase, and verify/stage a restore into an empty workspace before publishing it atomically.
- Change a protected workspace's passphrase without rewriting saved images; backups retain their own independent passphrases.
- Lock protected workspaces manually or after session-configurable inactivity; optionally generate a recovery-secret file and rotate the complete workspace root key through staged re-encryption.
- Search the entire catalog with at most 100 gallery/editor rows rendered at once. **Load page previews** lazily generates encrypted, cached, at-most-160-pixel thumbnails for that page only.
- Resume interrupted intake by reselecting files with **Resume intake** enabled. Encrypted per-image checkpoints bind original bytes, paths, and supplied labels/classes; exact repeats are skipped without overwriting later edits.
- Delete a whole workspace from the dashboard after typing its name. Active editors block deletion; incomplete deletion stays marked for an explicit retry.
- Share a workspace live with verified guests, or send an encrypted snapshot through **Share workspace** as a downloadable file (no storage account) or a 24-hour S3 invitation. Friends keep password-protected local copies and return encrypted annotation proposals for owner review even while you are offline. Independent owner edits merge and conflicts block approval. File secrets travel separately; file access has no expiry or revocation. See [persistent sharing](docs/persistent-sharing.md) for steps, the 64 MiB limit and S3 configuration.
- Open the dashboard's privacy-flow explorer for truthful local, live, S3, MCP, and AI data-path descriptions.
- Use **AI suggestions** on the current image: select a bounded pixel crop, add opaque black redactions and inspect the flattened local preview. A pinned Apache-2.0 RT-DETR model can be explicitly downloaded and run in a worker; its 26.9 MB WASM runtime is self-hosted and cached only after inference is invoked. Website BYOK includes OpenAI, Google Gemini and OpenRouter presets, plus deployment-configured OpenAI-compatible endpoints. Supply your own provider API key and vision model ID; provider billing and browser CORS apply. Keys remain in dialog memory, each transmission requires preview consent, and suggestions need review. Local model download origins still require deployment configuration.
- Connect **GitHub Copilot in VS Code** or **Google Antigravity** using **Local MCP companion → Set up Copilot or Antigravity**. The panel generates each editor's standard stdio configuration and pairing parameters for the separately installed [companion](services/bridge/README.md). A manually entered single-use token authorizes only the current image's visible box metadata and counts; proposed edits require browser review and one undoable transaction. The website does not embed editor subscriptions or turn their logins into BYOK API keys.

Dataset content leaves the app only through explicit sharing, exports or approved cloud crops. The default CSP permits same-origin connections, the three built-in BYOK API origins and loopback companion ports 47321/47322; permissions do not themselves start requests. S3, custom AI and model-download origins require explicit deployment configuration. An offline service worker is not a mathematical air-gap guarantee. See [the privacy contract](docs/privacy.md).

## Known limitations

- Masks are binary instance masks, not multichannel semantic maps. Limits are 128 current tiles/image, 64 changed tiles/stroke, 512 retained historical tiles/image, and 256 x 256 bytes/tile. Reopen the workspace to prune unreferenced history tiles when its history budget is reached.
- COCO compressed RLE, polygon holes/multipart objects, and mixed segmentation/keypoints in a single COCO instance are rejected. Imports replace annotations on matched images after confirmation; they do not add image pixels. CSV import is not implemented.
- Annotation imports have an 8-MiB text-file and 128-MiB selected-input budget. They are parsed into bounded batches, not a fully streaming parser or a certified large-dataset importer.
- **Dataset classes and skeletons → Migrate dataset schema** previews class removal/merging and skeleton point reorder/rename/removal. Used classes require a surviving replacement; unused classes can be removed without one. Surviving point names retain coordinates; renaming replaces a point rather than transferring its coordinates. Only discarded, non-placeholder coordinates require confirmation, with affected annotation/image counts shown first. Schema and encrypted documents commit together; stale previews are rejected. Conflicting image-label merges are refused, never deduplicated by deleting annotations. Older per-image IDs and point orders are reconciled by exact name before migration. Unused skeletons can be removed; removing a skeleton referenced by saved annotations is rejected.
- TURN-backed relay-only WebRTC and continuous encrypted cloud sync are not implemented. Hugging Face/Drive adapters are bounded provider components, not a complete sync engine or certified provider deployment. Live share and approval-based encrypted file/S3 snapshots are implemented; these are different sharing modes, not automatic cloud synchronization.
- The local detector and cloud vision have not been certified for model accuracy, device support, or sensitive-data anonymization. The fixed model is COCO-oriented; provider/model output may be wrong. Local inference requires a separately configured download origin and can consume substantial memory, storage, and device power. Cloud vision sends the selected crop and prompt to the explicitly chosen provider.
- The MCP companion's standard stdio interoperability was verified with the official MCP SDK, but third-party editor compatibility, HTTPS local-network permissions, and deployment origins are not certified. It exposes only the current image's visible box metadata and does not prove actual dataset-file visibility.
- Workspace names, protection settings, and creation times are public local catalog metadata. Avoid sensitive workspace names. S3 shares have a 64 MiB snapshot limit, 8 MiB receipt/proposal limit and one submission per invitation; image/schema/mask changes cannot be proposed. Invitations and review URLs expire after 24 hours or earlier if temporary credentials expire.
- The media pipeline currently has conservative 4-megapixel/8-MiB limits and rejects uncertified ICC-profiled, 16-bit, animated, and unsupported input.
- Browser storage can be cleared or evicted. OPFS is not a backup; recovery requires an enabled recovery file and surviving local data. Header scrubbing does not remove identifying content burned into image pixels.
- Protection-mode conversion uses encrypted backup/restore into a separate workspace, not an in-place toggle. Exhaustive write-boundary/migration/quota failure tests, accessibility certification, wider media certification, streaming import, and the 10,000-image resource/performance gate remain unfinished. Changing a passphrase is not data-key rotation.

Do not use this build for sensitive medical or proprietary data until the remaining security, compatibility, recovery, and release gates have been completed and independently reviewed.

### Use a YOLOv8 folder

1. Choose **New workspace**, enter a name, optionally enable **Password protect this workspace**, and choose **Create workspace**. No individual photo is required. Existing local data appears as **Existing workspace** and retains its previous passphrase.
2. Select a YOLOv8 dataset folder containing `data.yaml` and matching split folders such as `train/images`, `train/labels`, `valid/images`, and `valid/labels`. Use **Add folder** or **Add images** inside the workspace to add more files later.
3. Imported labels appear as editable bounding boxes. Remove an image from the workspace with its **Remove** control; this deletes the encrypted workspace copy and annotations, not the original file.
4. Choose **Export dataset**, select **YOLO detection**, choose whether to include PNG images, then choose **Choose destination & export**. The app creates a uniquely named new folder. This export is a plaintext copy outside workspace encryption.

The current cap is 10,000 images per workspace and 10,000 per import; per-image sanitizer and storage limits are currently 4 megapixels and 8 MiB. These are bounded prototype limits, not unlimited storage or a 10,000-image performance certification. Import is additive; it does not sync later source-folder changes automatically. Intake checks origin quota first, but cannot reserve storage or predict PNG expansion. Completed per-image commits survive cancellation/quota failure. To resume, reselect the folder with **Resume intake** checked; old imports/restored backups lacking checkpoints cannot be skipped automatically. Leave it unchecked to intentionally add duplicate copies.

### Annotate an image

Open an image in the dataset. In the left tool rail, choose **Box** and drag to draw a box, **Line** and drag between two endpoints to draw a line, or **Polygon** and click vertices. The draft previews its fill and closing edge; click the highlighted first vertex to close it, or press **Enter** / **Finish polygon**. **Image labels** toggles whole-image labels in the right panel; it does not draw shapes. **Keypoint** places points in the dataset's skeleton.

Use **Dataset classes and skeletons** on the dataset page or the editor's **Add a class** / **Add point name** controls. Definitions are encrypted separately and shared across every image. Adding a point preserves existing coordinates and marks the new point absent until placed. Schema changes reset the current image's in-memory undo history so undo cannot overwrite shared definitions. Backups preserve shared definitions even when the dataset contains no images.

Choose **Select** to move an annotation, resize a box with its corner handles, adjust polygon/keypoint vertices, move a line endpoint, or change the selected annotation's class. Edits save locally after each completed action. Invalid polygons are rejected visibly without replacing the saved shape.

Shortcuts (when not typing in a field): **1–4** select box/polygon/label/keypoint tools, **L** selects line, **5 / 6** select mask brush/erase, **V** selects editing, **H** selects pan, **+ / -** zoom, **0** fits the image, **Enter** finishes a polygon, **Escape** cancels an unfinished gesture, **Delete** removes the selected annotation, and **Left / Right** changes images. **Ctrl/Cmd+Z** undoes; **Ctrl/Cmd+Shift+Z** redoes. Undo history is in memory for the currently open image, not persisted across image navigation. Choose **Dataset** to return to file management without locking the workspace.

Brush an existing selected mask to extend it; otherwise brushing creates an instance. Erase affects the selected mask. Hidden instances are omitted from the canvas but remain in exports; visibility is not deletion. Locked instances reject edits until explicitly unlocked. JSON attributes accept at most 64 primitive string/number/boolean fields. Select a named keypoint to place it or set absent/occluded/visible status.

Choose **Exit workspace** to close the current dataset and return to the dashboard, where you can create or open another workspace. Each workspace has independent storage and keys; the original source folders remain untouched.

The dashboard remains available while other tabs edit, and different workspaces can be edited in separate tabs. Only the **same workspace** is limited to one editor at a time. If it is already open elsewhere, exit it in that tab (or close the tab), then choose **Retry opening workspace**; or return to the dashboard and open a different dataset. Returning focus to the dashboard refreshes its workspace list. Do not clear browser storage to resolve a lock.

The first load of this version migrates the previous workspace list into a separate local catalog without moving datasets. If a tab running the older version still holds the legacy database, exit/reload that older tab and retry the one-time upgrade. Developer proof tools share the **Existing workspace** database and therefore its editing lock; they do not block other datasets or the upgraded dashboard.

### Encrypted backup and restore

1. In **Dataset**, choose **Encrypted backup**. Enter and confirm a separate backup passphrase of at least 12 characters, then select a local destination. A new `annotator-backup-{UUID}` folder contains only encrypted dataset objects and public key-wrapping metadata. Save the entire folder, not just its `backup.json` header. Prefer an independent disk/location and keep the passphrase separately.
2. Backups include all dataset images, supported annotations, classes, skeletons, attributes, source paths, splits, review states, and revisions. They do not include developer proof records, in-memory undo history, original source bytes, or workspace/UI settings. Work proceeds one image at a time with progress and cancellation; an incomplete folder is not acknowledged as a completed backup.
3. To restore, create or open an **empty workspace**, choose **Restore backup**, enter the backup passphrase, and select the backup folder. The current workspace passphrase may be different, or the workspace may have no password. Existing images are never replaced or merged; restore is disabled for nonempty workspaces. Exit and create another workspace to keep the datasets separate; do not clear your current site data.
4. Each restored record and image is authenticated, checked against its manifest and canonical dimensions, re-encrypted under the current workspace key, and staged privately. Only after all items pass does one database transaction make them visible. Errors/cancellation leave the dataset unchanged; reopening cleans media left by interrupted staging.
5. **Workspace security** changes a protected workspace's passphrase. This rewraps the existing root key, not its image ciphertext. **Rotate workspace encryption key** instead stages fresh-key encryption of every current record, image, mask, and schema before switching the header atomically. Interrupted/cancelled staging retains the old key; completion activates the new passphrase and invalidates old recovery files. Cached thumbnails are discarded and regenerated. Old backups, copied headers/data, and forensic remnants are not revoked.

### Locking, recovery, and protection conversion

Protected workspaces have **Lock workspace** and an inactivity interval (15 minutes by default; session-only). Lock terminates workers, revokes image/mask/thumbnail/recovery URLs, and discards unfinished gestures and in-memory undo, not completed edits. Active storage operations finish before an inactivity lock; JavaScript cannot guarantee physical memory erasure.

**Recovery secret** verifies your current passphrase, creates a separate root-key wrapper, and offers a plaintext secret file for explicit download. Keep it securely outside this browser profile: possession of this file plus the workspace data bypasses the passphrase. Generating another file revokes the previous wrapper. From the locked screen, **Recover with a recovery file** sets a new passphrase. The file is not a data backup and cannot recover cleared browser storage. Normal passphrase changes preserve recovery; full key rotation invalidates it.

To change password-protection mode, make an encrypted backup, create a separate workspace with the desired protection, restore there, and verify its images/annotations before deleting the old workspace. Restore stages every image and mask under a fresh destination key; the source workspace remains intact until you explicitly delete it. Keeping an old unprotected copy defeats protection of that copy. There is no in-place protection toggle or guaranteed forensic erasure.

Backup/restore requires desktop Chromium's local directory access and the same current 10,000-image, 4-megapixel, and 8-MiB object limits. This is a tested prototype, not independently audited backup certification. Public metadata reveals opaque IDs, object counts/sizes, and KDF parameters, not filenames or labels. A backup written into a cloud-synchronized local folder may be uploaded by that separate sync application; choosing that location is your responsibility.

### Export formats and modes

| Format | Supported annotations | Output |
| --- | --- | --- |
| YOLO detection | Boxes | Split `images/` and `labels/*.txt`, normalized centers/sizes, `data.yaml` |
| YOLO segmentation | Polygons | Split `images/` and `labels/*.txt`, normalized vertices, `data.yaml` |
| COCO JSON | Boxes, simple polygons, binary masks, keypoints | Per-split `_annotations.coco.json`; uncompressed column-major mask RLE, non-crowd by default (boolean `iscrowd` preserves imported crowd status); one consistent named skeleton per category |
| Pascal VOC XML | Boxes | Per-image XML; one-based inclusive integer boxes enclosing subpixel coordinates |
| CSV annotations | Boxes, polygons, lines, image labels, keypoints | `annotations.csv` with JSON pixel geometry, skeleton, attributes, and review columns; this is an app-defined CSV schema, not a universal trainer format |
| Native annotation JSON | All currently editable annotation types | Versioned per-image documents plus raw mask `.bin` sidecars preserving classes, IDs, skeletons, attributes, instance properties, and review state; importable onto existing images, not an encrypted vault backup |

Unsupported annotation types stop preflight before any export files are created; they are never silently omitted or converted. All exports include `export-manifest.json` with original-to-exported image paths, class names, dimensions, and splits. Training formats preserve their supported training geometry/classes, not every editor field.

Exports always create a new folder. With **Include sanitized PNG images** unchecked, files refer to logical PNG paths listed in the manifest; supply corresponding sanitized images yourself. **Current image only** is available while annotating; entire-dataset export ignores search/review filters. CSV has one row per annotation, so images without annotations appear only in the manifest. CSV text fields may contain user content; import them as text if opening in spreadsheet software.

Aggregate COCO/CSV annotations stream one image at a time; the app does not gather all image pixels in memory. A failed disk write is reported and may leave a partial newly created export folder. Only a completed export receives the manifest and success notice. No ZIP download or cloud export is implemented.

## Run

Requires Node.js 22.12+ (Node 24 LTS recommended) and npm.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. For production-header verification:

```sh
npm run build
npm run preview
```

The VS Code **Build annotator** task runs the type-checked production build. Development permits Vite's inline stylesheet injection; production does not. Runtime dependencies, workers, and SQLite WASM are self-hosted; no remote fonts, CDNs, telemetry, or automatic model downloads are included. Cloud AI and public model downloads are opt-in and deployment-allowlisted.

### Publish on GitHub Pages

In the repository's **Settings → Pages**, select **GitHub Actions** as the deployment source, then push these changes to `master`/`main` or manually run **Deploy GitHub Pages**. The included [workflow](.github/workflows/pages.yml) tests and publishes the static build with the correct repository path. For this repo, the default URL is **https://mattjunior039.github.io/annotator/**.

Pages serves the app, not your datasets. Existing localhost workspaces stay on that origin; use encrypted backup/restore to move them to the Pages site. Pages cannot set custom security headers, so the build includes an HTML CSP fallback with documented limitations. See [deployment instructions and hosting trust boundaries](deploy/README.md) before using real data.

## Validate

```sh
npm run check
npm test
npm run test:browser
npm run test:pages
```

The browser suite builds and tests the production app in Chromium. The first browser run requires `npx playwright install chromium` if Chromium is missing. Synthetic fixtures are generated locally; do not substitute private or third-party images.

```sh
npm run benchmark:corpus
# Optional: materialize all 10,000 images (disk/CPU-intensive; fresh output only).
npm run benchmark:corpus -- --write-images
# Real production UI intake, edit, and bounded-resource measurements (synthetic only).
npm run benchmark:browser
# Smaller smoke check, not a 10,000-image performance certification:
npm run benchmark:browser -- --count 101 --size compact --edits 6 --navigation 6 --budget-seconds 180
npm run --silent inventory > sbom.cdx.json
```

The default corpus command writes only a reproducible 10,000-image descriptor manifest under `benchmarks/generated/reference-corpus`; it is not an import or decode benchmark. See [verification](docs/verification.md).

The browser benchmark uses a fresh isolated production Chromium workspace and
10,000 reference-size synthetic images by default. Each run preserves raw
`report.json`, fixture hashes, build fingerprints, and environment metadata in a
new `benchmarks/generated/browser-*` directory without replacing earlier runs.
It measures bounded-batch intake, first decoded editor image, label-edit
acknowledgements, an input-to-render-opportunity proxy, and sampled rendered
catalog/media resources. It does **not** measure total process memory or certify
the 768 MiB/pointer-drag release gates. See the verification document for exact
definitions, smaller-run options, browser budget, and limitations.

## Architecture and policy

- [Architecture and phase boundaries](docs/architecture.md)
- [Privacy and threat model](docs/privacy.md)
- [Proof format and recovery contract](docs/storage-format.md)
- [Verification and benchmark method](docs/verification.md)
- [Phase 1 feasibility results](docs/phase-1-results.md)
- [Static deployment](deploy/README.md)

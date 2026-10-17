# Private Annotator

A local-first image annotator under active development. The current build starts with a minimal workspace dashboard: create a named workspace, choose whether to password-protect it, then import and annotate its dataset. It is **not yet a complete or independently audited release**; use synthetic or non-sensitive data only.

## Current features

- Create separate named workspaces and reopen them from the dashboard. **Exit workspace** closes its workers and returns to the workspace list without deleting data.
- Choose password protection when creating each workspace. Protected workspaces require their passphrase when reopened; no-password workspaces open automatically in this browser profile. Their key is stored locally, so they do not protect against someone with access to that profile.
- Import a dataset folder or JPEG, PNG, and WebP images inside the selected workspace; the empty dataset also accepts image-file drops. Use **Add folder** for folders, including nested datasets.
- Import folders as a local dataset, add images later, and remove individual images from the encrypted workspace without deleting source files.
- Import YOLOv8 detection `data.yaml` class names and paired `images/` + `labels/` box annotations. Train/val/test splits are retained when detected.
- Export YOLO detection, YOLO polygon segmentation, COCO JSON, Pascal VOC XML, CSV, or native annotation JSON. Choose the whole dataset or current image, with sanitized PNG images or annotations only; export does not overwrite the source folder.
- Annotate with bounding boxes, polygons, image labels, and basic keypoints; add classes, undo/redo, and set review state.
- Manage shared dataset classes and named skeleton points. Additions apply to all images and future imports; existing keypoint coordinates are preserved.
- Use Dataset / Annotate / Export navigation, search/review filters, a compact drawing-tool rail, a large canvas, an active-class panel, zoom/pan, and previous/next image navigation. The Select tool moves shapes, resizes boxes, and adjusts polygon/keypoint vertices.
- Store encrypted records and media in worker-owned SQLite WASM/OPFS storage. The app limits a workspace to 10,000 images, but that scale has not been performance-certified.
- Explicitly cache the static app shell for tested Chromium offline use. Dataset media and workspace records are not placed in Cache Storage.
- Inspect storage usage and optionally request persistent browser storage.
- Create encrypted dataset backups with an independent passphrase, and verify/stage a restore into an empty workspace before publishing it atomically.
- Change a protected workspace's passphrase without rewriting saved images; backups retain their own independent passphrases.

The app does not send dataset images or annotations to a remote service. Production CSP and browser tests cover the implemented paths; `connect-src 'self'` and an offline service worker are not a mathematical air-gap guarantee. See [the privacy contract](docs/privacy.md).

## Known limitations

- Segmentation currently means vector polygons; tiled pixel-mask editing is not implemented.
- Keypoint editing and skeleton controls are basic.
- Annotation import currently reads YOLO detection labels only. Additional export formats are not additional import formats. Encrypted dataset backup/restore is a separate feature; pixel masks, COCO keypoint export, and automatic format conversion are not implemented.
- Dataset schema edits currently support additions, not destructive class removal/renaming or skeleton reordering. Older per-image definitions are reconciled by exact name on unlock; conflicting IDs or exclusive groups stop migration explicitly.
- Live collaboration, signaling/TURN, encrypted cloud sync, Hugging Face/Drive adapters, and the privacy-flow explorer are not implemented.
- AI integration is intentionally excluded.
- Workspace names, protection settings, and creation times are public local catalog metadata. Avoid sensitive workspace names. A workspace's **Sharing** panel currently explains manual export/backup only; it does not create live rooms or upload data.
- The media pipeline currently has conservative 4-megapixel/8-MiB limits and rejects uncertified ICC-profiled, 16-bit, animated, and unsupported input.
- Browser storage can be cleared or evicted. OPFS is not a backup; a forgotten passphrase cannot be reset. Header scrubbing does not remove identifying content burned into image pixels.
- Inactivity lock, recovery secrets, full data-key rotation, encryption conversion, and the complete local release failure/performance matrix remain unfinished. Changing a passphrase is not data-key revocation.

Do not use this build for sensitive medical or proprietary data until the remaining security, compatibility, recovery, and release gates have been completed and independently reviewed.

### Use a YOLOv8 folder

1. Choose **New workspace**, enter a name, optionally enable **Password protect this workspace**, and choose **Create workspace**. No individual photo is required. Existing local data appears as **Existing workspace** and retains its previous passphrase.
2. Select a YOLOv8 dataset folder containing `data.yaml` and matching split folders such as `train/images`, `train/labels`, `valid/images`, and `valid/labels`. Use **Add folder** or **Add images** inside the workspace to add more files later.
3. Imported labels appear as editable bounding boxes. Remove an image from the workspace with its **Remove** control; this deletes the encrypted workspace copy and annotations, not the original file.
4. Choose **Export dataset**, select **YOLO detection**, choose whether to include PNG images, then choose **Choose destination & export**. The app creates a uniquely named new folder. This export is a plaintext copy outside workspace encryption.

The current cap is 10,000 images per workspace and 10,000 per import; per-image sanitizer and storage limits are currently 4 megapixels and 8 MiB. These are bounded prototype limits, not unlimited storage or a 10,000-image performance certification. Import is additive; it does not sync later source-folder changes automatically.

### Annotate an image

Open an image in the dataset. In the left tool rail, choose **Box** and drag to draw a box, or choose **Polygon** and click vertices, then **Finish polygon**. **Image labels** toggles whole-image labels in the right panel; it does not draw shapes. **Keypoint** places points in the dataset's skeleton.

Use **Dataset classes and skeletons** on the dataset page or the editor's **Add a class** / **Add point name** controls. Definitions are encrypted separately and shared across every image. Adding a point preserves existing coordinates and marks the new point absent until placed. Schema changes reset the current image's in-memory undo history so undo cannot overwrite shared definitions. Backups preserve shared definitions even when the dataset contains no images.

Choose **Select** to move an annotation, resize a box with its corner handles, adjust polygon/keypoint vertices, or change the selected annotation's class. Edits save locally after each completed action. Invalid polygons are rejected visibly without replacing the saved shape.

Shortcuts (when not typing in a field): **1–4** select drawing/labeling tools, **V** selects editing, **H** selects pan, **+ / -** zoom, **0** fits the image, **Enter** finishes a polygon, **Escape** cancels an unfinished gesture, **Delete** removes the selected annotation, and **Left / Right** changes images. **Ctrl/Cmd+Z** undoes; **Ctrl/Cmd+Shift+Z** redoes. Undo history is in memory for the currently open image, not persisted across image navigation. Choose **Dataset** to return to file management without locking the workspace.

Choose **Exit workspace** to close the current dataset and return to the dashboard, where you can create or open another workspace. Each workspace has independent storage and keys; the original source folders remain untouched.

The dashboard remains available while other tabs edit, and different workspaces can be edited in separate tabs. Only the **same workspace** is limited to one editor at a time. If it is already open elsewhere, exit it in that tab (or close the tab), then choose **Retry opening workspace**; or return to the dashboard and open a different dataset. Returning focus to the dashboard refreshes its workspace list. Do not clear browser storage to resolve a lock.

The first load of this version migrates the previous workspace list into a separate local catalog without moving datasets. If a tab running the older version still holds the legacy database, exit/reload that older tab and retry the one-time upgrade. Developer proof tools share the **Existing workspace** database and therefore its editing lock; they do not block other datasets or the upgraded dashboard.

### Encrypted backup and restore

1. In **Dataset**, choose **Encrypted backup**. Enter and confirm a separate backup passphrase of at least 12 characters, then select a local destination. A new `annotator-backup-{UUID}` folder contains only encrypted dataset objects and public key-wrapping metadata. Save the entire folder, not just its `backup.json` header. Prefer an independent disk/location and keep the passphrase separately.
2. Backups include all dataset images, supported annotations, classes, skeletons, attributes, source paths, splits, review states, and revisions. They do not include developer proof records, in-memory undo history, original source bytes, or workspace/UI settings. Work proceeds one image at a time with progress and cancellation; an incomplete folder is not acknowledged as a completed backup.
3. To restore, create or open an **empty workspace**, choose **Restore backup**, enter the backup passphrase, and select the backup folder. The current workspace passphrase may be different, or the workspace may have no password. Existing images are never replaced or merged; restore is disabled for nonempty workspaces. Exit and create another workspace to keep the datasets separate; do not clear your current site data.
4. Each restored record and image is authenticated, checked against its manifest and canonical dimensions, re-encrypted under the current workspace key, and staged privately. Only after all items pass does one database transaction make them visible. Errors/cancellation leave the dataset unchanged; reopening cleans media left by interrupted staging.
5. **Workspace security** on the Dataset page changes a protected workspace's passphrase. Confirm the current and new passphrases. This rewraps the existing root key, not the image ciphertext. Existing backups and copies of the previous vault header remain decryptable with their previous passphrases; a leaked data key requires full rotation, which is not yet implemented. Protection mode is chosen at creation, not toggled in place. To move a no-password dataset into a protected workspace, use encrypted backup/restore into a new protected workspace.

Backup/restore requires desktop Chromium's local directory access and the same current 10,000-image, 4-megapixel, and 8-MiB object limits. This is a tested prototype, not independently audited backup certification. Public metadata reveals opaque IDs, object counts/sizes, and KDF parameters, not filenames or labels. A backup written into a cloud-synchronized local folder may be uploaded by that separate sync application; choosing that location is your responsibility.

### Export formats and modes

| Format | Supported annotations | Output |
| --- | --- | --- |
| YOLO detection | Boxes | Split `images/` and `labels/*.txt`, normalized centers/sizes, `data.yaml` |
| YOLO segmentation | Polygons | Split `images/` and `labels/*.txt`, normalized vertices, `data.yaml` |
| COCO JSON | Boxes and polygons | Per-split `_annotations.coco.json`; `file_name` is relative to that split |
| Pascal VOC XML | Boxes | Per-image XML; one-based inclusive integer boxes enclosing subpixel coordinates |
| CSV annotations | Boxes, polygons, image labels, keypoints | `annotations.csv` with JSON pixel geometry, skeleton, attributes, and review columns; this is an app-defined CSV schema, not a universal trainer format |
| Native annotation JSON | All currently editable annotation types | Versioned per-image documents preserving classes, IDs, skeletons, attributes, and review state; not an encrypted vault backup or a currently importable restore format |

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

The VS Code **Build annotator** task runs the type-checked production build. Development permits Vite's inline stylesheet injection; production does not. Runtime dependencies, workers, and SQLite WASM are self-hosted; no remote fonts, CDNs, telemetry, cloud services, or AI integrations are included.

## Validate

```sh
npm run check
npm test
npm run test:browser
```

The browser suite builds and tests the production app in Chromium. The first browser run requires `npx playwright install chromium` if Chromium is missing. Synthetic fixtures are generated locally; do not substitute private or third-party images.

```sh
npm run benchmark:corpus
# Optional: materialize all 10,000 images (disk/CPU-intensive; fresh output only).
npm run benchmark:corpus -- --write-images
npm run --silent inventory > sbom.cdx.json
```

The default corpus command writes only a reproducible 10,000-image descriptor manifest under `benchmarks/generated/reference-corpus`; it is not an import or decode benchmark. See [verification](docs/verification.md).

## Architecture and policy

- [Architecture and phase boundaries](docs/architecture.md)
- [Privacy and threat model](docs/privacy.md)
- [Proof format and recovery contract](docs/storage-format.md)
- [Verification and benchmark method](docs/verification.md)
- [Phase 1 feasibility results](docs/phase-1-results.md)
- [Static deployment](deploy/README.md)

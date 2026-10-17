# Architecture and Phase 1 boundary

## Ownership

| Component | Authority |
|---|---|
| React application | Capability display, explicit proof actions, ephemeral input/preview, error/status feedback |
| Domain | Versioned schemas, canonical image coordinates, validated commands, bounded per-image history |
| Storage worker | Single-writer Web Lock, official SQLite WASM OPFS SAH pool, commit acknowledgments, intent recovery |
| Crypto module inside storage worker | Passphrase derivation, root key lifecycle, purpose/context-bound object encryption |
| Media worker | Header checks, decode, orientation, fresh PNG encoding, output inspection, rendered-pixel comparison |

Storage and crypto share one dedicated worker **for this spike**, keeping keys off the application thread without a second worker/key-transfer protocol. Keys are non-extractable after import. Lock terminates storage and media workers and drops preview/note references; JavaScript cannot guarantee erasure. This is a deliberate simplification, not a commitment that later high-throughput media encryption must share the database worker.

Workers exchange versioned, runtime-validated request IDs and discriminated payloads. There is at most one in-flight request per worker, a 45-second deadline, explicit errors, transferable media buffers, and termination on fatal protocol/worker errors. Timeout means the operation's commit outcome must be checked after reopening; it never means "saved".

## Domain contracts

- Schema version 1; UUID entity IDs, strict objects, finite numbers, bounded strings/collections.
- Canonical image coordinates follow EXIF orientation. Image bounds are `[0,width] x [0,height]` pixel edges. Boxes use top-left plus positive width/height, with exclusive far edges for raster/export conventions.
- Polygons have clockwise winding in a y-down image coordinate system, omit a repeated closing vertex, and reject crossings, repeated adjacent vertices, and collinear adjacent edges. Holes are deferred.
- Instance masks use a 256-pixel tile grid with opaque blob references; dense pixel payloads are not model fields. Actual mask editing/storage is Phase 3.
- Keypoint order follows a validated skeleton. Visible/occluded points must be in bounds; absent points may be outside the frame.
- Image labels support explicit exclusive groups. Class/skeleton IDs and mask dimensions are validated against the document.
- Every mutation goes through a runtime-validated command with an expected image revision. Undo/redo retains changed annotations, not dataset snapshots, preserves instance ordering, and never silently accepts stale edits.
- The model is a contract, not a safe unlimited parser. Later file/network adapters must enforce byte budgets before schema parsing and must stage incoming state.

## Current implementation boundary

The entry point is a named-workspace dashboard, not a photo picker. A short-lived catalog worker lists/creates workspaces using a separate public OPFS JSON catalog under a short, queued catalog Web Lock. Dataset editing does not hold that lock. Each new workspace has its own SQLite SAH pool, media directory, editing lock, and independently generated root key. The previous SQL catalog is migrated on first use; existing single-workspace data is adopted as **Existing workspace** without moving or deleting records. SQLite VFS access handles are explicitly released when closing a store, before releasing its lock. Exit terminates workers and returns to the dashboard; saved datasets remain local.

Password protection is optional at creation. Protected workspaces use the passphrase wrapper and require unlock on reentry; no-password workspaces persist a local device-key header and auto-open. The latter does not provide access protection from the browser-profile owner. Names, protection flags, and creation times are public catalog metadata. Different datasets can be edited in separate tabs while dashboards list/create workspaces; only the same dataset rejects concurrent editing. The legacy dataset and developer proof tools share their original editing lock. A tab running the previous version may need to exit/reload before the one-time catalog migration can access that legacy database; no lock is forcibly stolen. The Sharing panel states that collaboration/cloud sync are unavailable and points to manual export/backup.

Inside a workspace, additive folder/image intake, image-file drops, a paged encrypted image catalog, individual removal from the app-managed dataset, and Dataset / Annotate / Export navigation are available. Folder drops are rejected visibly with guidance to use **Add folder**. The editor separates its drawing-tool rail, image list, class/annotation panel, and undo/redo controls. Search and review filters operate on loaded catalog entries; counts are explicitly labeled when page-local.

Classes and skeletons have one encrypted dataset-wide schema with its own optimistic revision. Old per-image definitions are scanned one record per worker request and merged by exact name before publication; interrupted preparation can resume or restart without rewriting records or media. Reads and exports overlay canonical IDs and map keypoints by name, preserving coordinates and marking added points absent. Import commits any expanded shared definitions with the new image row. Ordinary image saves cannot mutate or overwrite shared definitions. Additions reset current-image undo; destructive schema edits fail until explicit migrations are implemented.

YOLO detection datasets can be imported with their class names, paired box labels, and detected train/validation/test splits. Explicit exports support YOLO detection, YOLO polygon segmentation, COCO box/polygon JSON, Pascal VOC boxes, app-defined CSV annotations, and versioned native per-image JSON. The last two support mixed editable annotation types; masks are not exportable without their tile storage. Export preflights compatibility before creating files, can cover the whole dataset or current image, and can omit images. COCO/CSV aggregate annotations stream from one document at a time. All export modes create a new local folder and completion manifest; failure can leave an incomplete new folder, never a success acknowledgment. Source folders remain unchanged. Native JSON is not a restorable vault backup.

It uses the same worker-owned storage and media-sanitization boundaries described above. The app-shell service worker can be installed explicitly and has a production Chromium test for offline reload/unlock without caching workspace data.

Encrypted dataset backup/restore is separate from plaintext exports. Directory handles are structured-cloned to the storage worker, never sent to a remote endpoint. A backup session uses an independently generated root key and passphrase wrapper, purpose-separated record/media/manifest objects, and an authenticated completion manifest. Sequential per-image worker requests bound work instead of holding a dataset-sized plaintext archive or using a single unbounded worker request. Other workspace operations are blocked while an archive session is active.

Restore requires an empty workspace. Each authenticated document/media pair is re-encrypted under the destination root and a new media ID, with an intent preceding the file write. Encrypted records live in `restore_staging` until one transaction publishes every record, the merged dataset schema, and clears the matching intents. Reopen/cancellation discards staging and recovers unreferenced media. Database publication, not a partially written file tree, determines success. Image/annotation IDs and revisions survive restore; dataset/media bindings change and shared class/skeleton IDs reconcile by name with any preconfigured destination definitions. The encrypted manifest preserves shared definitions even for empty datasets. Older backups without this optional field rebuild definitions from their records. Developer proof records and UI/undo state are outside dataset backups.

Protected-workspace passphrase changes verify the current wrapper, unwrap only inside the worker, and atomically replace the public wrapper using fresh salt/nonce and current KDF parameters. Saved object keys/ciphertext are unchanged. This is not full root-key rotation and cannot revoke a previously copied header or backup. Protection mode is not converted in place; encrypted backup/restore can move a dataset into a new protected workspace.

Still not implemented: tiled pixel-mask editing, complete/native training-format interchange, recovery-secret/rotation/conversion/inactivity-lock lifecycle, production-scale search/thumbnails, live collaboration, connected cloud providers, model downloads, user accounts, and AI/MCP integration. Polygon annotation is not a substitute for pixel masks. The 10,000-image ceiling is a storage limit, not a performance certification.

## Feasibility decisions

- **SQLite:** Official `opfs-sahpool`, single writer, no SharedArrayBuffer/COOP/COEP required in tested Chromium. Open fails visibly if real OPFS initialization is unavailable; there is no in-memory success fallback.
- **Encryption:** Sensitive records are encrypted before SQL binding. SQLite's structural tables, workspace catalog, and public vault header are not encrypted. No-password headers deliberately contain the locally accessible root key. Media is an independently authenticated OPFS object.
- **Intake:** A fresh PNG generated from browser-rendered sRGB pixels avoids retaining EXIF/XMP/IPTC/camera data and avoids a second lossy JPEG encode. This can expand disk usage substantially. Exact source-file or medical-diagnostic fidelity is not claimed.
- **Color:** ICC and 16-bit cases are rejected pending certification, rather than silently changed. Gamma-tagged fixtures are exercised; the color contract remains the tested browser's rendered sRGB result, not independently certified color science. Wider color support is a future codec gate.
- **Durability:** An intent precedes media writes, verified immutable media precedes a SQL reference, and the intent deletion and record commit are one SQL transaction.
- **Network:** Same-origin app assets and SQLite WASM load normally. Dataset import and export are local browser file operations; no remote dataset transport exists. Production CSP is a fixed maximum, not an air-gap guarantee.

## Next-phase gates

Before a real workspace release: staged migrations, quota/persistence UX, full backup/restore, media derivatives, bounded 10,000-image queues, safe sanitization for the intended color/format matrix, all write-boundary crash tests, and explicit maintenance/offline readiness. Phase 1 measurements do not substitute for those gates.

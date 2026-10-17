# Phase 1 proof format (experimental)

This format is versioned but **not an independently audited production cryptographic format**. Do not use the lab with real sensitive data. Changes before the actual vault release may require discarding disposable proofs.

## Key hierarchy

- Generate a random 32-byte root. Import as a non-extractable HKDF key in the storage worker; clear the temporary raw byte buffer.
- Derive a non-extractable wrapping key from a 12-1024-character passphrase using PBKDF2-HMAC-SHA-256, 600,000 iterations, and a random 16-byte salt.
- AES-256-GCM encrypts the root with a fresh 12-byte nonce and 128-bit tag. The version, workspace ID, algorithm, iterations, salt, and nonce are bound as canonical ordered JSON AAD.
- Public vault metadata stores those parameters and the wrapped key only. KDF parsing caps iterations at 2,000,000 to bound header abuse. Workspace passphrase change verifies the current passphrase, rewraps the same root using fresh salt/nonce and the current iteration minimum, and transactionally replaces the header. Raw root bytes are temporary inside the worker and cleared in `finally`. This does not revoke a copied old header or rotate the data key.
- The preceding wrapper applies to password-protected workspaces. An explicitly no-password workspace instead stores `{version:1, mode:"device", workspaceId, key}` with the 32-byte raw root encoded as 64 hex characters. It imports that key as non-extractable HKDF on open. The stored key is readable by the browser-profile owner; encryption in this mode is not at-rest access protection. Backup keys always use the independent passphrase wrapper, never this device header.
- Each immutable object gets a fresh 16-byte HKDF salt and random UUID generation, deriving an AES-256-GCM key with info `annotator/v1/{purpose}/{workspaceId}/{objectId}/{generation}`. Workspace purposes are `record`, `media`, `mask`, `thumbnail`, and `schema`; backups use `backup-record`, `backup-media`, `backup-mask`, and `backup-manifest`. Purpose is checked by the reader as well as bound in AAD. Future network formats must use separate labels.

## Binary object

All integer fields use unsigned big-endian encoding.

```text
u32 header length (<= 2048)
UTF-8 JSON header
zero or more data frames
one authenticated final frame

frame:
  12-byte nonce
  u32 ciphertext length
  ciphertext including 16-byte authentication tag
```

Ordered header fields: `version`, `workspaceId`, `objectId`, `generation`, `salt` (hex), `chunkBytes` (65536), `length`, `chunks`, `contentType` (always `application/octet-stream`), `purpose` (one of the workspace or backup labels above). These categories are public, not image MIME types or semantic labels. Reader authenticates the actual header bytes, so equivalent reordered JSON is not interchangeable.

Frame AAD is the header bytes followed by ASCII `|{index}|chunk` or `|{index}|final`. The final plaintext is exactly ASCII `complete`. Header length/count plus a required authenticated final frame detect truncation, duplication, substitution, reordering, and appended bytes.

Every frame has a fresh random nonce; generation checks reject repeats within an object. Object keys are fresh for each seal, and no object exceeds 8 MiB/128 data frames in this proof. The empty object consists of a header and authenticated final frame. Retry must reuse identical sealed bytes or generate a wholly new object generation/salt.

The proof bounds the whole object in memory; **it is not yet a full streaming file API**. A later TransformStream and larger-scale key/nonce limits require separate review. Do not reuse this prototype unquestioningly for WebRTC/cloud protocols.

## SQLite and OPFS

- Legacy SAH pool directory `.annotator-phase1-sql`, logical `/proof.sqlite3`; legacy media directory `annotator-phase1-media`.
- New workspaces use SAH pool name `annotator-{workspaceUUID}`, directory `.annotator-{workspaceUUID}-sql`, logical `/proof.sqlite3`, and media directory `annotator-{workspaceUUID}-media`. Media filenames are `{random UUID}.enc`. Catalog workspace IDs are separate from the cryptographic workspace IDs bound into object headers.
- The current public catalog is `annotator-workspaces.json` at the OPFS root: a validated array of `{id,name,passwordProtected,createdAt,deleting?}` descriptors, at most 100 entries and 128 KiB when read. Names are trimmed, limited to 100 characters, and must not contain sensitive information. Reads and atomic `createWritable` replacements are serialized by the short-lived `annotator-workspace-catalog` Web Lock, independent of all dataset editing locks.
- `workspace_catalog`: the previous SQL catalog's public `id`, `name`, `password_protected`, and `created_at`. On first use, when the JSON catalog does not exist, the legacy database is opened under its editing lock and these descriptors are copied to the new catalog. A preexisting legacy vault is registered as `legacy` / **Existing workspace**, retaining all original storage and its passphrase. The old SQL catalog is retained, not deleted; the JSON catalog becomes authoritative. Malformed catalogs fail explicitly rather than silently returning an empty workspace list.
- `vault`: singleton public passphrase-wrapped-key or no-password device-key JSON.
- `records`: opaque ID, encrypted payload, opaque media reference.
- `workspace_records`: opaque image ID, encrypted annotation document/source path/split/optional intake fingerprint, and opaque media reference. Older workspace records without a path or split read as image name and `train`. The optional encrypted intake fingerprint binds SHA-256 of original input bytes and a canonical JSON context of path/classes/normalized supplied boxes. It supports explicit resumption without comparing or overwriting later edits; it is not a global plaintext content index. Backups omit this intake-only checkpoint.
- `intents`: opaque media IDs for incomplete media writes.
- `restore_staging`: encrypted unpublished workspace records with opaque image/media IDs. Deleted on reopen before recovering their media intents.
- `dataset_schema`: singleton encrypted version-1 dataset classes/skeletons and independent revision, authenticated under purpose `schema` with the cryptographic workspace ID as its object ID. Legacy definitions scan one encrypted image record per request, reconcile by exact name, and publish only after completion. Original records/media are unchanged; reads overlay shared definitions. Imports and restore publish schema changes in the same transaction as their new image rows. Per-image writes cannot change the schema.
- `mask_objects`: opaque tile UUID, owning image UUID, and a staged/live flag. Each immutable 256 x 256 tile is exactly 65,536 binary bytes encrypted under purpose `mask`. Image documents hold grid coordinates and tile UUIDs. Writes validate exact referenced payloads, ownership, and zero padding outside canonical dimensions. Copy-on-write tiles retain undo history; unreferenced history is pruned on the next schema-open after unlock. Limits: 128 current tiles/image, 64 new tiles/update, 512 retained tiles/image.
- `thumbnails`: image UUID and opaque media UUID. Derivatives are at most 160 x 160 PNGs and 128 KiB, purpose `thumbnail`, generated lazily in the storage worker from verified canonical media. Creation/deletion uses the same intent/transaction discipline. Backups omit regenerable thumbnails; full key rotation invalidates and removes them.
- `vault_recovery`: optional singleton passphrase-style root wrapper, independently wrapped under a generated 256-bit recovery secret. Only the wrapper is persisted; the plaintext secret is offered through an explicit download.
- `rotation_proof`: unpublished encrypted proof records used during full root-key rotation. Dataset records reuse `restore_staging`; masks use staged registry entries.
- `user_version=9`. Versions 2/3/4/5 add workspace records/restore staging/SQL catalog/shared schema; versions 6/7/8/9 add masks/recovery/rotation staging/thumbnails. Earlier supported versions gain the missing structural tables without rewriting committed ciphertext. A newer unknown version fails visibly before schema changes. Comprehensive migration-boundary coverage remains a release gate.
- `journal_mode=DELETE`, `synchronous=FULL`, `temp_store=MEMORY`. Sensitive record plaintext never enters SQL. This is ciphertext-only storage, **not whole-file encrypted SQLite**.
- Each dataset holds a Web Lock for its worker lifetime: `annotator-workspace-{workspaceUUID}` for new workspaces, or the original `annotator-phase1-writer` for legacy/proof data. A second editor of the same dataset fails explicitly, without blocking the dashboard or a different dataset. Closing a store closes its DB and pauses its SAH VFS to release physical access handles. Reopening unpauses it; worker termination also releases handles and the editing lease. A scoped workspace worker cannot switch scope or operate the catalog.

Workspace creation writes the independent key/header into a fresh scoped store before publishing the descriptor in the JSON catalog. A crash before catalog publication can leave an unused empty namespace; no dataset imports have occurred at that point. Initial catalog migration opens the legacy store and runs its recovery; subsequent catalog access does not open any dataset database. If an older tab holds the legacy database during initial migration, the app explicitly asks to exit/reload that tab and retry the upgrade. No editing lock is forcibly taken over.

Workspace deletion acquires that workspace's exclusive editing lock, checks the typed exact name, and publishes `deleting:true` before removing only its explicitly resolved media and SQLite namespaces. Open refuses marked workspaces. Only after both directories are removed is the descriptor removed. An interruption/failure leaves a visible retry state rather than reopening a partially deleted dataset. Other namespaces, originals, and exports/backups are untouched. Legacy deletion includes its developer proof data, which shares the legacy store. This is browser-file deletion, not secure forensic erasure.

## Commit and recovery

1. Encrypt media completely in memory.
2. Commit an intent containing only the opaque media ID.
3. Write and close the immutable ciphertext file; verify size and readback.
4. Encrypt the record (proof note or annotation document, source path/split where present, and authenticated media reference).
5. In one SQLite transaction insert the record and delete its intent.
6. Only then return the saved acknowledgment.

On reopen, each intent is checked against committed media references. A referenced intent is an integrity error, not permission to delete live data. Remove only the explicitly named unreferenced file (missing is an expected pre-write crash outcome), then delete its intent. Cleanup errors stop opening; they are not swallowed.

The built-in interruption uses only synthetic bytes and deliberately stops after media close but before record commit. Browser tests terminate/reopen afterward and also verify already committed media survives. Exhaustive power-loss, journal-corruption, and migration-boundary testing remain later gates.

Web Locks and local transactions are not protection against a malicious same-origin script or raw profile modification. Physical disk durability remains subject to browser/OS guarantees.

## Encrypted dataset backup v1

Each backup creates a fresh random root and backup UUID, independently wrapped with a separate passphrase using the same PBKDF2/AES-GCM hierarchy. The workspace root is not exported. A new folder holds:

- `{imageUUID}.record.enc`: `backup-record` envelope, bound to the backup UUID and original image UUID. Plaintext is a strict object containing the complete versioned annotation document, source path, and split.
- `{mediaUUID}.media.enc`: `backup-media` envelope, bound to the backup UUID and original media UUID. Plaintext is the canonical sanitized PNG.
- `{tileUUID}.mask.enc`: `backup-mask` envelope, bound to the backup UUID and tile UUID. Plaintext is the exact binary tile. Optional per-entry `tiles:[{id,object:{bytes,sha256}}]` descriptors bind membership/digests; old backups without tiles remain supported. Restore validates padding and rebinds tile IDs under the destination key.
- `manifest.enc`: `backup-manifest` envelope with backup UUID as workspace/object ID. Its encrypted JSON is `{version:1, backupId, entries:[{id, mediaId, record:{bytes,sha256}, media:{bytes,sha256}}], datasetSchema?}`. Ordered entries bind the entire image set, unique IDs, exact ciphertext sizes, and SHA-256 digests. The optional encrypted shared schema preserves definitions even with zero images. New readers accept older manifests without it and reconcile definitions from image records. Older strict readers cannot read manifests containing the new field.
- `backup.json`: final public completion header `{format:"annotator-encrypted-backup", version:1, key, manifest:{bytes,sha256}}`; `key` is the wrapped backup root. Written only after all objects and manifest have been written, closed, and read back for verification.

The manifest's AES-GCM authentication, not the unkeyed digest alone, authenticates object membership/digests. Replacing public header/digest values cannot forge the manifest. There is no external identity/freshness authority: a complete older backup or a different valid backup whose passphrase is known cannot be distinguished from a deliberately selected archive. Backups are not synchronization or rollback protection.

Before reading content, enforce 4-KiB bootstrap, 8-MiB plaintext/record/media/manifest, bounded envelope, and 10,000-entry limits. Reject duplicate IDs, malformed schema/geometry, missing/damaged/substituted files, unsupported versions, incorrect purpose/context, incomplete envelope markers, mismatched references/dimensions, and masks without tile payloads. No original filenames are used as filesystem paths. Extra unreferenced files are ignored and never restored.

Backup and restore process one image per validated worker request, with ordered session/index checks and no concurrent workspace mutation. Metadata descriptors scale with image count; image/document plaintext is bounded to the current item, not the full dataset. A cancelled write can leave an incomplete newly created backup folder; the app does not delete user-selected destination folders.

Restore requires an unlocked, empty workspace. Authenticate each source pair, preserve image/annotation IDs and revisions, rebind the dataset ID, allocate a fresh destination media UUID, and re-encrypt under the current root. Shared class/skeleton IDs reconcile by exact name with any destination definitions. Write intent, verified media, and staged encrypted row in that order. After every item succeeds, a single transaction copies staged rows into the live index, publishes the merged encrypted schema with an incremented destination schema revision, and deletes their intents/staging. Existing developer proof records are preserved. Cancellation/reopen discards staged rows and removes named unreferenced media using the normal intent recovery rules; committed records are never removed to resolve an error.

The initial format is directory-based, not a ZIP or single-file download. Browser disk closure/readback and SQLite FULL synchronous are the available durability evidence, not a universal physical-disk flush guarantee. Backup verification here is automated prototype coverage, not independent cryptographic certification.

## Recovery, key rotation, and annotation imports

Generating recovery verifies the current passphrase and stores a new independent wrapper. The downloaded `{format:"annotator-recovery-secret",version:1,workspaceId,secret}` contains a plaintext 64-hex-character secret, not a backup. Regeneration replaces the wrapper; an old file no longer unlocks. Recovery validates workspace binding and authenticates the persisted wrapper before atomically replacing the normal passphrase wrapper. Normal passphrase changes preserve recovery; full rotation deletes it.

Full rotation verifies the current passphrase, generates a fresh root, and re-encrypts current images, mask tiles, annotation records, proof records/media, and shared definitions in ordered bounded steps. New immutable media/tile IDs avoid overwriting committed bytes. One transaction switches records/schema/header, promotes masks, schedules old objects/derivatives for deletion, and removes recovery. Cancellation/reopen before publication discards staging under the old active key. After publication the new passphrase is active even if cleanup fails: the response explicitly reports `cleanupPending` and the UI instructs reopening under the new passphrase. Backups and previously copied ciphertext/headers are not revoked.

Annotation imports stage existing-image replacements in `restore_staging` and rebind incoming tile UUIDs. Each image must exist, match canonical dimensions, and occur once in the ordered session. One final transaction updates every selected record, publishes shared definitions and new masks, and clears staged intents. Cancellation/reopen or a later invalid item publishes none of the batch. Original pixels/media bindings remain unchanged. The UI parses at most 128 MiB of selected input (8 MiB/text file); this is bounded batching, not a streaming parser.

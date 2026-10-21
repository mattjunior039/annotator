# Privacy-first image annotator: implementation plan

## 1. Problem, approach, and confirmed decisions

Build a capable image annotator that keeps datasets local by default, makes network disclosure explicit, and later supports encrypted collaboration, bring-your-own-storage sync, and controlled AI integration.

At planning time the inspected project directory, `/Users/matthew/annotate`, was empty. This is a greenfield build, not a refactor of an existing application. No repository files were changed during planning. Phase 1 implementation and verification are complete; Section 19 is its historical handoff. Section 20 records the current, partially implemented local-workspace/tool stages.

Delivery order:

1. Local-first annotator, including offline operation, complete annotation tools, encrypted local persistence, and interchange.
2. Live peer collaboration.
3. Encrypted asynchronous cloud sync, then additional provider adapters.
4. AI integration, starting with metadata-only local bridge access.

Execution is phase-based: complete and verify one phase, report its deliverables and remaining limitations, and obtain explicit direction before starting the next phase. Approval of this roadmap alone does not authorize implementing every phase at once.

Decisions confirmed with the user:

- Desktop Chromium is the primary supported platform. Firefox and Safari get explicit capability checks and documented limited fallbacks, not silently weaker guarantees.
- Still images: boxes, polygons, instance masks, keypoints, and image-level labels. Video tracking and DICOM/medical-volume viewing are out of scope initially.
- TypeScript/React static-first application; workers own expensive rendering, media, storage, and crypto work. Optional self-hosted signaling/TURN infrastructure is introduced later.
- Intake produces sanitized app-managed copies by default. Original files are never modified. Retaining GPS requires explicit per-workspace opt-in.
- Locking protects all app-managed sensitive bytes, including images, thumbnails, annotations, filenames, indexes, and recovery data.
- SQLite persists encrypted records, not plaintext sensitive rows. Opaque identifiers, ciphertext sizes, file counts, and storage activity remain observable. Literal whole-file SQLite encryption is not required.
- Network features use convenient in-page switches. This deliberately provides a weaker assurance than a separate immutable, network-denying offline document.
- Live rooms initially support at most eight participants, including the creator.
- S3-compatible storage (AWS S3, R2, MinIO) comes before Hugging Face and Google Drive.

### Product language

Use "Open folder", "Import locally", "Stored on this device", "Share live", and "Sync encrypted data", not "upload" for local intake. Show where bytes are stored and when they may leave the device.

Do not adopt the stray names in the supplied concept as product branding. Branding remains outside this technical plan.

## 2. Correctness boundaries: promises we must not make

| Concept | Implementable contract |
|---|---|
| "Zero-copy" from SSD to GPU | File handles avoid eagerly reading the whole dataset. Decoding, sanitizing, encryption, browser internals, and GPU upload may copy bytes. Promise bounded-memory, lazy processing, not literal zero-copy. |
| "100% mathematical offline guarantee" | Prove offline functionality and absence of application-initiated egress under tested conditions. Browser extensions, compromised dependencies/runtime/OS, and malicious future app code are outside this guarantee. |
| `connect-src 'self'` prevents disclosure | It still permits same-origin requests. CSP alone is not a complete WebRTC or general exfiltration boundary. Runtime modes cannot relax an already restrictive CSP. |
| OPFS is encrypted/private from the computer owner | OPFS is origin-isolated browser storage, not an encrypted vault by itself. Protect locked workspaces with application encryption. |
| Web Crypto transparently encrypts SQLite | It does not. Encrypt sensitive payloads before SQLite/OPFS writes, including journals and migration scratch data. |
| A URL fragment is secret from everyone | Fragments are omitted from HTTP request targets, but page scripts, extensions, clipboard tools, screenshots, history, and link-sharing systems can expose them. |
| Signaling disappears forever after handshake | Existing peers can continue after signaling disconnects, but joining, reconnection, and ICE restart can require signaling again. |
| TURN provides complete anonymity | Relay-only connections hide direct peer addresses from other peers when correctly configured. TURN/signaling operators still observe connection metadata; "zero-log" is an operational claim, not a cryptographic property. |
| Encryption hides everything in a bucket | It protects content, not object sizes, counts, access timing, endpoints, account identity, or all traffic relationships. |
| Coordinates-only means no sensitive information | Labels and geometry may still reveal medical or proprietary facts. Minimize fields and require explicit sharing consent. |
| Blurring guarantees anonymization | Detectors miss objects; blur can retain identifying information. Require preview, manual correction, and consent; offer opaque masking as the stronger default. |

## 3. Threat model and trust boundaries

Protect against accidental uploads; third-party network services reading shared content; stolen browser-profile storage while a workspace is locked; accidental metadata exposure; unauthorized room joins; malformed imported media/documents; and ordinary crash/restart/data-loss scenarios.

Explicitly outside the guarantee:

- A compromised browser, OS, extension, app origin, or malicious application update running while the user unlocks.
- An authorized collaborator copying plaintext or taking screenshots.
- Erasure of SSD remnants, OS swap, crash dumps, GPU memory, or user-exported plaintext.
- Recovery of lost passphrases/keys without a user-created recovery mechanism.
- HIPAA/GDPR or medical-device certification simply because encryption exists.
- Preventing an external AI assistant from forwarding information that the user has intentionally disclosed to it.

Security posture:

- No analytics, ad scripts, remote fonts, CDN runtime dependencies, automatic crash uploads, or third-party model downloads.
- Render imported filenames/labels as text, never executable HTML. Use strict schema validation, safe URL handling, and size limits everywhere.
- Self-host dependencies, WASM, workers, icons, and approved models. Maintain a lockfile, dependency/license inventory, SBOM, and release provenance.
- Keep secrets out of logs, URLs other than the deliberate invite fragment, diagnostic exports, and persistent browser preferences.
- Document residual leakage rather than claiming literal zero knowledge.

## 4. Architecture and proposed project organization

Use a single repository and avoid a monorepo framework until separate deployables need it.

```text
src/
  app/                  Shell, routing, capability checks, network-mode controller
  domain/               Versioned entities, geometry, schemas, commands, validation
  editor/               Tools, selection, transforms, history, shortcuts, rendering
  datasets/             Intake queues, catalog, metadata policies, review workflow
  storage/              SQLite worker client, blob store, migrations, recovery
  crypto/               Versioned envelopes, key wrapping, chunk codec, test vectors
  workers/              Storage, media/sanitizer, crypto, raster rendering
  interchange/          Native backup, COCO, YOLO, Pascal VOC, compatibility reports
  privacy/              Disclosure policy, network permissions, scrubbed diagnostics
  collaboration/        Later: room membership, transport, Yjs binding, transfer
  sync/                 Later: manifests, revisions, S3/HF/Drive adapters
  ai/                   Last: local bridge client, consent UI, pixel export boundary
public/                 Self-hosted static assets only
services/signaling/     Later: bounded room discovery/handshake service
services/bridge/        Last: localhost companion/MCP integration
tests/                  Unit, browser, protocol, fixture, and failure-injection tests
deploy/                 Static headers, signaling/TURN examples, operator guidance
docs/                   Architecture, threat model, formats, privacy, user recovery
```

Initial tooling: React, TypeScript strict mode, Vite, Vitest, Playwright, and SQLite's official WASM package. Use a small schema-validation library after checking bundle size/license. Use browser-native Web Crypto. Pick a maintained BLAKE3 implementation only when encrypted cloud object addressing is implemented.

Rendering:

- React manages UI, not pointer-frequency geometry state.
- Use explicit domain commands and an independent editor store. Convert screen coordinates through one tested image/world transform.
- Prefer native canvas rendering with separate image, geometry, selection, and brush layers. Start with Canvas2D/OffscreenCanvas and bitmap caching; add GPU-specific complexity only if measured budgets fail.
- Keep canonical annotations independent of a canvas library and GPU resources.
- Workers use typed, versioned messages, transferable buffers/bitmaps, cancellation IDs, timeouts, and explicit errors. Bound all queues and allocations.
- Feature-detect OffscreenCanvas and image decoding behavior; keep a tested main-thread rendering fallback without moving large storage/crypto work there.

State ownership:

- Domain commands are the mutation boundary; imports, UI, collaboration, and later AI all use it.
- The storage worker owns persistence and reports actual commit acknowledgments.
- The media worker owns sanitization and derivatives.
- The crypto worker owns workspace keys and cryptographic transforms; plaintext necessarily exists transiently in processing/rendering workers while unlocked.
- Later, Yjs becomes the authority for shared annotation state; SQLite stores encrypted checkpoints/updates. Do not create two competing annotation authorities.

## 5. Local annotator UX and data model

### Workspace and dataset workflow

- Workspace creation chooses lock policy before any dataset bytes are persisted.
- Folder picker, drag-and-drop directory traversal, and explicit multi-file selection. Handle drag API differences and permission loss.
- Intake preview reports supported/unsupported files, expected storage, metadata policy, and copy behavior.
- Virtualized gallery and dataset list; searchable/filterable catalog, deterministic ordering, class counts, unlabeled/review filters, and per-item errors.
- Editor: pan/zoom, fit, actual pixels, image navigation, selection, multi-select, duplicate/delete, visible/locked instances, class assignment, and attributes.
- Schema editor: stable class IDs, colors, attributes, skeleton definitions, class rename/merge, and validation before destructive schema edits.
- Review states: unannotated, in progress, annotated, reviewed. Local manual editing does not automatically imply review.
- Keyboard-first controls with discoverable shortcuts, focus management, screen-reader UI labels, adequate contrast, and no color-only status.
- Display "Saving", "Saved on this device", "Storage full", and recoverable error states accurately. Never show saved before commit acknowledgment.

### Annotation tools

- Axis-aligned boxes: create, resize, move, clamp, minimum size, multi-select.
- Polygons: create/close, insert/remove/move vertices, cancel unfinished work, reject self-intersection/degenerate shapes for the initial simple-polygon tool.
- Instance masks: bounded tiled raster representation, brush/erase, opacity, undoable strokes, deterministic edge behavior. Polygon and mask representations remain distinct, not silently converted.
- Keypoints: schema-defined names, visibility/occlusion states, skeleton edges, out-of-frame rules.
- Image-level labels: explicit multi-label support and optional exclusive groups.
- Per-instance attributes and optional user text stay encrypted and are excluded from later bridge disclosure by default.
- Per-image history with coalesced drag/stroke commands, redo invalidation, and a workspace-level history policy. Do not implement undo by copying entire datasets.
- Later collaboration undo is scoped to the local user's edits and tested against concurrent changes.

### Canonical data contract

- Versioned workspace, dataset, image, class, skeleton, instance, review, and annotation entities with random stable IDs.
- Images store raw-source dimensions separately from canonical oriented dimensions and any derived preview dimensions.
- Canonical geometry uses finite original-resolution pixel coordinates after EXIF orientation; origin at the top-left, x rightward, y downward. Specify box edge convention and polygon winding explicitly.
- Persist coordinate transforms for orientation and preview rendering; all import/export paths use the same conversions.
- Validate bounds, NaN/infinity, point counts, class references, mask dimensions, skeleton references, and schema versions.
- Content hashes are internal dedup/integrity hints, not public media identifiers. Do not persist plaintext fingerprints in locked stores.
- Retain import provenance inside encrypted records. Disable cross-workspace dedup by default to avoid correlation and deletion hazards.

## 6. Intake, metadata policy, and bounded memory

### Initial media support and limits

- JPEG, PNG, and WebP still images.
- Reject SVG, animation/multi-frame inputs, archives, RAW, HEIC, TIFF, DICOM, and unknown formats initially with explicit per-file reasons. Do not import only the first frame silently.
- Check magic bytes rather than trusting extensions or MIME labels.
- Initial guardrails: at most 64 megapixels and 256 MiB encoded bytes per input image; also apply runtime canvas/texture limits. Exceeding a limit produces a visible error, not a silent downsample.
- If a decoded image exceeds texture limits, use a tiled/downsampled display path while keeping canonical source-resolution coordinates. Fail explicitly if no safe path exists.
- Use structural parsing limits before decode, decoder concurrency limits, timeouts, cancellation, and bounded cumulative queued bytes. Browser codecs are a trust dependency, not a sandbox guarantee against every decoder vulnerability.

### Sanitization pipeline

1. Enumerate lazily and stream file descriptors into a bounded queue. Do not decode 10,000 images at once.
2. Inspect dimensions/container metadata safely.
3. Decode orientation correctly and apply a documented color-management policy. Test all eight EXIF orientations and ICC/gamma/alpha cases.
4. Produce a canonical sanitized image plus separately generated thumbnails. No original file bytes enter durable app storage or outbound paths.
5. Verify output with an independent metadata parser before caching. Strip EXIF identifiers, GPS by default, timestamps, XMP, IPTC, comments, PNG text chunks, WebP metadata, embedded thumbnails, and unknown ancillary payloads according to an allowlist.
6. Preserve only rendering-critical color information under a defined policy, not arbitrary profiles with unexamined payloads. Do not blindly strip color data and silently alter images.
7. Encrypt before durable writes for locked workspaces; expose content only after the manifest commit.

Prefer a thoroughly tested metadata parser/codec over ad-hoc header removal. Make pixel fidelity a release gate: use lossless sanitized output where supported, and do not silently introduce lossy JPEG re-encoding. If browser codecs cannot meet the chosen fidelity/color contract, use a vetted self-hosted worker/WASM codec or reject that case visibly.

Geospatial opt-in:

- Preserve only an explicit GPS/geospatial allowlist in encrypted sidecar metadata; never "preserve all EXIF".
- Keep camera serials, timestamps, and identifying metadata scrubbed even in this mode unless a separately documented requirement is introduced.
- Sharing/export requires separate consent to include geospatial sidecars.

Operational details:

- Original source folders remain untouched and outside vault protection. Folder handles are permissions, not byte copies.
- Hold original handles only as needed for intake/retry. Do not persist source paths/handles by default; require deliberate permission for a future reference-mode optimization.
- Persist resumable intake checkpoints without claiming that browser file access survives restart. Re-selection may be necessary.
- Show sanitized-copy storage cost and quota estimates before import. A no-copy/reference mode is deferred because its durability and sanitization guarantees differ.
- Revoke object URLs, close ImageBitmaps, dispose GPU textures, and release unused buffers. Maintain byte-budgeted LRU caches.
- Deduplicate sanitized content only inside a workspace with a report; preserve separate logical image identity when the user needs duplicate images.

## 7. Persistence, durability, and recovery

### SQLite and media layout

- Run SQLite WASM in a dedicated worker. Prefer the official OPFS synchronous-access-handle pool VFS for a single-writer model; verify the exact selected version and hosting requirements in a spike.
- Persist fixed-schema tables containing opaque IDs, ciphertext envelopes, encrypted event/checkpoint payloads, and minimal non-sensitive migration/version fields.
- Store large encrypted media and mask objects in OPFS, not as giant SQL blobs. Small encrypted annotation records and indexes stay in SQLite.
- Build sensitive searchable indexes in memory from decrypted catalog records after unlock, in bounded batches. No plaintext FTS tables, filenames, labels, thumbnails, or SQL parameters may spill to disk/WAL/temp files.
- For unlocked workspaces, plaintext persistence is allowed only under an explicit "Not protected at rest" state. Schema/envelope versioning supports both states without ambiguous interpretation.
- Prevent two tabs from writing the same workspace using Web Locks and an explicit single-writer lease/fencing scheme. Additional tabs are read-only or offer deliberate takeover after detecting the old writer has stopped.
- Do not rely on unload handlers for saving.

### Atomicity across SQLite and OPFS

- Write a new opaque blob to a temporary identifier, finish encryption, close/flush the supported handle, verify expected length/hash, then commit the SQLite reference.
- Acknowledge durability only after the database transaction succeeds.
- On recovery, finish or discard incomplete operations using a versioned intent record. Garbage-collect unreferenced blobs only after a grace period and reference scan.
- Immutable blob replacement avoids partial overwrite. Migration/rekey operations use new generations and atomic manifest/reference switches.
- Crash injection must cover each boundary, including a tab killed during a brush stroke, media commit, migration, and key rotation.

### Storage lifecycle

- Request persistent storage with `navigator.storage.persist()` and display the result. Check `estimate()` before large work; handle quota errors even after a successful estimate.
- OPFS is not a backup. User-cleared site data, profile loss, and unsupported/private browsing storage can destroy local work.
- Provide encrypted native workspace backups, restoration verification, storage usage, and explicit deletion with explanation of secure-erasure limitations.
- If persistence is unavailable, show a prominent temporary-session state with manual export, or block workflows requiring durable storage. Never silently substitute ephemeral memory for an apparently saved workspace.
- Test migrations from every supported version, transactional failure recovery, and forward-version rejection.

## 8. Vault encryption and key lifecycle

### Key hierarchy

- Generate a random 256-bit workspace root key using `crypto.getRandomValues`.
- Derive purpose-separated encryption keys with HKDF using explicit context labels for records, media, backups, and later cloud/room operations.
- Derive a passphrase wrapping key with PBKDF2-HMAC-SHA-256, a random salt of at least 16 bytes, and a versioned iteration count. Start at a 600,000-iteration minimum, benchmark on supported hardware, and review guidance before release. Do not use the originally proposed 150,000 as an unquestioned permanent setting.
- Wrap the workspace root key with AES-256-GCM. Store only the salt, KDF parameters, nonce, version, and wrapped key; never the passphrase or plaintext root key.
- Use non-extractable CryptoKeys where operations permit. Initial import/wrapping and explicit recovery export still require carefully controlled key handling.
- Offer an optional downloadable recovery secret with a clear loss warning and a tested recovery flow. No server-side reset can decrypt a lost vault.

### Versioned authenticated chunk format

- Web Crypto encrypts individual buffers; it is not a streaming AEAD primitive. Build a bounded TransformStream that frames independently authenticated chunks.
- Use a fresh random object salt/identifier and derive a new object encryption key for every new immutable object/version. Enforce a fresh random 12-byte nonce per chunk and track per-key message/byte limits; regenerate/rekey before limits.
- Authenticate format version, workspace binding, object ID, object generation, chunk index, declared total chunks, plaintext length, and content type through canonical AAD.
- Authenticate a final manifest of chunk counts/lengths and object integrity so truncation, duplication, substitution, and reordering are detected, not merely per-chunk corruption.
- Reject malformed envelopes and unauthenticated plaintext. Do not partially commit a corrupt image or dataset.
- Encrypted empty objects, aborted transfers, partial final chunks, retries, and multi-writer uniqueness require explicit tests.
- Keep crypto format design small and reviewable, publish test vectors, and obtain independent cryptographic review before describing cloud/live modes as production-ready E2EE.

### Lock/unlock and conversion

- Lock drains or cancels edits safely, commits queued changes, ends sharing/sync/AI operations, terminates key-bearing workers, drops app key references, clears visible sensitive UI, and disposes plaintext image/mask caches.
- Never promise provable memory erasure in JavaScript. Explain residual browser/OS risks.
- Offer manual lock and configurable inactivity lock; define behavior for hidden tabs and interrupted saves. Avoid discarding unsaved work silently.
- Changing a passphrase rewraps the root key; revoking a leaked root key requires full key rotation and new ciphertext.
- Enabling encryption on a previously plaintext workspace uses a verified encrypted replacement generation. Warn that prior plaintext remnants/backups may remain; do not claim retroactive secure erasure.
- Disabling encryption requires an explicit disclosure warning and staged migration.
- On shared machines, a strong passphrase plus separate OS accounts is preferable. Remembering an unlocked key across browser restarts is off by default.

## 9. Offline operation and network permissions

The user chose in-page convenience, so "Local" is an application-enforced state, not an immutable network air gap.

### Modes and allowed operations

| State | Allowed application data traffic |
|---|---|
| Local | None. No signaling, TURN/STUN, cloud, AI, model downloads, or telemetry. |
| Live enabled | Only explicitly approved signaling/ICE/peer endpoints and encrypted room payloads. |
| Cloud enabled | Only approved provider endpoints and encrypted objects/manifests. |
| AI enabled, last stage | Only approved loopback bridge and/or separately consented external provider request. |
| Locked | No dataset transmission or pending background work with workspace keys. |

- Network permissions are per workspace/session/capability, default off, visibly displayed, and reset on reload unless the user explicitly configures otherwise.
- Implement one network-policy boundary for fetch/WebSocket/RTC/provider clients and background jobs. Service-worker behavior is governed separately; a wrapper is not a security sandbox against malicious code.
- Revocation aborts requests, closes channels, removes queued tasks, and prevents retries. Show that already transmitted data cannot be recalled.
- Update checks and install caching occur only through visible user-initiated maintenance/online actions, not during local annotation.
- Use a versioned service-worker app-shell cache and offline-ready verification. Never cache dataset plaintext in Cache Storage, including generated responses.
- Updates must not activate in the middle of a write/migration or silently change the threat boundary. Provide a save/close/reload prompt.
- Service-worker installation/update may itself contact the origin under browser control; disclose that the in-page local toggle cannot guarantee zero packets. Physically offline operation/firewall rules remain stronger controls.

### CSP and hosting

- Self-host scripts/WASM/workers; no inline/eval execution except a narrowly justified WASM-specific directive if required. Restrict object, frame, form, image, font, worker, script, and connection sources; set `base-uri 'none'`, `object-src 'none'`, and `frame-ancestors 'none'`.
- Set `Referrer-Policy: no-referrer`, HTTPS, appropriate Permissions-Policy, and safe MIME/nosniff headers. Test worker, SQLite, OAuth, and COOP/COEP interactions instead of blindly enabling headers.
- Connected capability endpoints need a bounded deployment-level CSP allowlist. Arbitrary BYOS host support requires deliberate deployment configuration, not an undocumented `connect-src *`.
- Dynamic in-page permission gates operate inside that fixed CSP maximum. A hardened separate `connect-src 'none'` entry point is a possible later option, not part of the agreed first release.
- Include self-host/static server instructions; do not promise service-worker/OPFS behavior from `file://`.

## 10. Import/export, backups, and portability

First-release formats:

- Native versioned encrypted workspace backup: lossless representation of every supported annotation type, schemas, review state, and approved provenance. Define bounded record framing, manifest authentication, and streaming restoration.
- COCO: boxes, segmentation polygons/mask RLE, and keypoints where compatible.
- YOLO detection and segmentation dialects with explicit version/normalization rules.
- Pascal VOC: boxes only.
- Native JSON for complete annotation interchange and image-level labels; no silent attempt to squeeze every feature into every external format.
- Parquet is deferred to the cloud/interoperability stage unless a concrete consumer requires it.

Rules:

- Import into a staging transaction; validate before changing the existing dataset.
- Export preview lists included data and metadata, dropped/unsupported fields, class mapping, and whether images or GPS sidecars are included.
- No silent lossy conversion. Unsupported topology, mask/keypoint dialects, or extra attributes produce a compatibility report and require a choice.
- Plaintext exports are an explicit user disclosure outside vault protection. Default backup is encrypted; ordinary annotation exports explain their format constraints.
- Guard against path traversal, duplicate IDs/filenames, dangerous object keys, malformed RLE, excessive nesting, unbounded counts, and mismatched image dimensions.
- Use streaming output/file writers when available. Large exports must not require assembling the whole dataset in RAM; display and enforce bounded fallback limits on browsers without streaming file output.
- Round-trip tests preserve IDs, exact mask pixels, keypoints, class mappings, and canonical geometry within documented format-specific numeric tolerances.

## 11. Live collaboration, after local release

**Status (2026-10-17): implemented as host-led live share. See [docs/live-collaboration.md](docs/live-collaboration.md).** It differs from the original sketch below:
- The host's vault is authoritative. Guest edits are replayed at annotation level instead of syncing through Yjs. Guests keep no persistent replica.
- Traffic uses an end-to-end encrypted relay by default, with an optional WebRTC direct upgrade.
- Mask and schema edits from guests are refused.

Done:
- Invite capability carried in the URL fragment.
- Host approval with verification codes.
- Per-peer ECDH session keys.
- Replay- and tamper-checked frames.
- Bounded chunking and rate limits.
- Participant removal and session end.
- A Cloudflare Worker / Durable Object relay plus a node relay for development.
- Unit tests, plus end-to-end tests against both relays.

Open:
- A TURN-backed relay-only WebRTC mode.
- Owner transfer.
- Offline guest edits.
- Multi-network and 8-peer testing.
- Independent cryptographic review.

### Room and invitation lifecycle

- Initial scope is a trusted, small editing group: creator admission, up to eight participants, shared annotation edits, presence, and sanitized image transfer. No claim of cryptographically enforced read-only roles for parties who hold the shared room key.
- Generate a random room ID and a random 256-bit room root key, distinct from the workspace root key.
- Put only the room key material/capability in the invite fragment. Parse it before other application initialization, remove it from the visible/history URL with `replaceState`, and retain it only in session memory. No third-party code runs on the room route.
- Invite possession is a bearer capability, not personal identity. Show a short out-of-band verification code/fingerprint and require creator approval before admitting a participant.
- Bind the handshake and ephemeral peer identities to the room secret and protocol version; derive fresh per-peer/direction/session traffic keys. Authenticate signaling payloads where feasible.
- Use short-lived rooms, bounded signaling messages, admission limits, rate limiting, and operator-configurable expiry. Do not retain datasets, filenames, labels, keys, or raw message bodies in signaling logs.
- Host departure must not be a hidden durability promise: admitted peers may continue their existing session, but further admissions require the owner or an explicitly transferred owner capability.

### Transport

- WebRTC DataChannels provide DTLS in transit; application encryption provides the room content boundary. Do not treat a third-party Yjs provider's password option as proof that every required payload is encrypted.
- Choose a maintained signaling/transport component where it meets the protocol; otherwise use a small explicit adapter. Do not create an unaudited general-purpose networking framework.
- Separate responsive annotation/control traffic from bulk media transfer. Use reliable ordered delivery initially.
- Negotiate a payload size below `RTCSctpTransport.maxMessageSize`, including framing/AEAD overhead. Use a conservative 16 KiB initial message budget; 64 KiB is not a universal safe constant.
- Use `bufferedAmount`, low-water events, bounded per-peer queues, chunk acknowledgments, resume tokens, cancellation, integrity checks, timeouts, and quotas.
- Prioritize current-image thumbnails/previews over bulk dataset replication. Full sanitized dataset replication is explicit and shows storage/egress cost.
- Use the same approved sanitized media store and authenticated chunk codec, not raw source File objects.
- Reconnect with bounded backoff and state reconciliation. Signaling can disconnect after a stable handshake, but must be available again for reconnection/new joins.

### Relay-only mode

- Explicitly configure `iceTransportPolicy: 'relay'` before peer connection creation, with authenticated TURN over tested transports.
- Require all participants to use relay-only mode for a room advertised as peer-IP-private. Do not silently fall back to direct ICE if TURN fails.
- Inspect selected candidate pairs and test that peer-visible signaling/candidates do not disclose direct addresses under this mode. Recreate existing connections on policy change.
- Use short-lived TURN credentials, abuse/rate controls, and documented operator log retention. No client-bundled long-lived TURN secret.
- Disclose remaining metadata visibility to operators and the limits of IP-based location inference.

### Yjs semantics and persistence

- Model images, instances, classes, review state, and geometry with stable IDs. Use granular shared fields; never overwrite a complete document on every mouse movement.
- Define same-instance conflict behavior. Commit drag results atomically; use soft editing indicators, deterministic merge rules, explicit delete semantics, and class-schema validation.
- Encode masks as immutable encrypted tiles with CRDT references; avoid repeatedly broadcasting full dense masks.
- Do not trust incoming Yjs updates: apply size/schema limits and validate resulting domain state in an isolated staging document before persisting/publishing.
- Bound update history, checkpoint/compact safely, and enforce message/rate limits against memory exhaustion.
- Persist authenticated accepted updates/checkpoints before announcing durable state. Presence remains ephemeral and names are opt-in.
- Test offline concurrent edits, reconnect, duplicate/reordered updates, simultaneous delete/edit, class changes, local undo, and malformed peer data.
- Removing a peer cannot erase copied data. Rotate room traffic keys and re-invite remaining peers for future confidentiality; do not claim retroactive revocation.

## 12. Encrypted asynchronous BYOS sync

**Scoped sharing implementation (2026-10-17):** Following the selected product direction, **Share workspace** now publishes encrypted snapshots with 24-hour S3 pre-signed download/proposal-upload capabilities. Recipients edit password-protected local copies offline and submit one annotation proposal per invitation. Owners explicitly review before/proposed annotations and approve or reject; worker-side three-way merge preserves disjoint edits, refuses conflicts and commits all records plus the decision atomically. Encrypted local receipts survive reload and key rotation. This is a bounded 64 MiB snapshot / 8 MiB proposal implementation using the existing backup codec, not the continuous Yjs/content-addressed BYOS sync designed below. Media/schema/mask proposals, automatic replica reconciliation, URL renewal and contributor decision notifications remain outside this mode. Deployment needs an exact S3-origin allowlist, scoped credentials and CORS. See [docs/persistent-sharing.md](docs/persistent-sharing.md).

### Provider order

1. S3-compatible adapter: AWS S3, Cloudflare R2, and MinIO.
2. Hugging Face opaque encrypted-object repository adapter.
3. Google Drive adapter with OAuth-specific handling.

Each adapter must pass a shared contract suite for streaming, conditional writes, pagination, retries, abort, integrity, credential expiry, and CORS behavior. Do not fake equivalent semantics when a provider lacks conditional writes or atomic publication.

### Object layout and metadata protection

- Encrypt sanitized media, annotations, masks, filenames, schemas, indexes, and relevant provenance before provider upload.
- Name immutable data objects using BLAKE3 of the ciphertext, not the plaintext, with an `.enc` suffix. Randomized encryption prevents plaintext-hash equality leakage across workspaces.
- Keep filename-to-object mappings inside encrypted, authenticated manifests. Use opaque workspace prefixes and generic MIME headers; do not put dataset names in paths or provider metadata.
- Stream in bounded chunks through the shared authenticated format. The upload client cannot receive plaintext content.
- A small generic root pointer locates the current encrypted manifest. Root authentication binds workspace ID, generation, parent revision, and manifest ciphertext hash.
- Cloud storage still sees object lengths, traffic timing, counts, and account access. Padding is deferred; document leakage.

### Consistency, recovery, and asynchronous collaboration

- Upload immutable objects first; publish the new manifest pointer only after all referenced objects are durable.
- Use provider-supported compare-and-swap/ETag/commit-parent checks, fetch/merge/retry on conflict, and never silently use last-writer-wins for annotations.
- Later cloud and live modes share Yjs update/checkpoint semantics for collaborative annotations; binary/media/schema conflicts get explicit policies and user-visible resolution.
- Resume interrupted multipart uploads without reusing a nonce/key combination for changed content. Reuse only the exact same immutable ciphertext for a retry.
- Honor rate limits with bounded retries and cancellation. Report failed objects and preserve local edits.
- Keep previous manifest generations for rollback/recovery. Detect rollback relative to locally remembered trusted revisions; a fresh device cannot prove server freshness without an additional trusted anchor.
- Delay remote garbage collection until retained revisions and active transfer references are accounted for. Deletion is explicit, previewed, and scoped to the app's workspace prefix.
- Test concurrent sync from two devices, lock mid-upload, revoked credentials, corrupt manifests, missing chunks, stale pointers, and quota exhaustion.

### Credentials and keys

- S3: scoped short-lived credentials where possible, AWS SigV4 through a maintained client such as aws4fetch, TLS, least-privilege bucket prefixes, and documented CORS.
- Never ship provider or signing secrets in the static bundle. Browser-entered credentials remain in memory by default; optional vault persistence requires explicit consent.
- Room keys, workspace keys, provider credentials, and cloud-sharing capabilities are separate.
- Share workspace access out of band through an explicit encrypted key package/invitation; a cloud login is not a decryption key.
- Key revocation means re-encrypting future/current accessible content under a new root and removing old access where possible; old ciphertext/key copies remain decryptable.
- Hugging Face adapter explains that encrypted blobs are not a normal browsable Dataset/Parquet repository. Do not upload cleartext dataset cards or previews.
- Google Drive uses a public-client OAuth flow supported by Google's current requirements, minimal scopes, and no browser-embedded client secret. Verify popup/COOP and token-refresh behavior before promising seamless persistence.

## 13. AI integration, only after annotator and data modes

### A. Local companion and MCP bridge

- A static browser page cannot host a general TCP/WebSocket MCP server. Add a separately installed, opt-in local companion.
- The companion binds to `127.0.0.1`, not `0.0.0.0`; use a fixed validated port/configuration, reject unexpected Host and Origin values, and test DNS-rebinding/cross-site access defenses.
- The browser connects to the companion over a bounded loopback protocol. The companion exposes supported MCP stdio and/or authenticated Streamable HTTP endpoints to editor clients. Do not call an arbitrary WebSocket connection "MCP compliant".
- Browser access to plain loopback from HTTPS is subject to mixed-content and local-network permission behavior. Prototype this before committing to a transport; use a documented secure localhost/certificate alternative if required. Never ask users to disable browser security.
- Pair using a short-lived, single-use cryptographically random token, with origin/workspace binding, rate limiting, explicit browser approval, and session expiry.
- Tokens are not URL query parameters; authenticate before processing commands. Treat other local processes as untrusted too.
- Support protocol-level client interoperability and document tested versions for VS Code/Copilot, Cursor, and Antigravity; do not promise integration based only on product names.

### B. Least-privilege tool surface

- Default tools expose class IDs, image opaque IDs, dimensions, counts, bounding boxes, polygon/keypoint coordinates, and review state only as required.
- Exclude pixels, thumbnails, filenames, file paths, EXIF/GPS, arbitrary text attributes, credentials, and keys.
- Dense masks require a separately scoped capability and bounded representation, not implicit access through a generic read tool.
- Start with read-only validation/class-balance tools. Mutations return a proposed patch for review.
- Validate patches through the same domain command/schema pipeline, bind to a workspace revision, require confirmation, transact, and support undo.
- Use request size/time/rate limits, a visible active-connection indicator, revocation, and a local privacy-safe audit trail.
- The companion has no unrestricted filesystem/shell/browser-evaluation tool and cannot bypass disclosure by reading the vault directly.
- Warn that Copilot or another client may send disclosed coordinates/labels to its own cloud backend. Loopback protects the browser-to-companion hop, not the entire external agent workflow.

### C. Local inference before cloud vision

- Add a provider-neutral model adapter with self-hosted, user-approved model assets, integrity hashes, license review, and explicit download size.
- Test WebGPU and a bounded WASM fallback; show unsupported-device errors rather than silently switching to a cloud provider.
- Model outputs remain suggestions until accepted. Apply undoable commands, provenance, confidence display, and review filters.
- A model named "YOLOv11-Nano" is not automatically a face/license-plate/text detector. Select and evaluate actual task-trained models and available licenses separately.

### D. Explicit cloud VLM disclosure and pre-mask

- Cloud vision is off by default and cannot run in local mode.
- Choose regions locally; show the exact sanitized crop, destination, metadata, and request fields before sending.
- Run optional face/plate detection and OCR/text masking locally. Prefer opaque redaction over blur; allow manual painting and re-inspection.
- Flatten redaction into fresh raster pixels, re-encode, re-scrub metadata, and build a new upload object. Never send the original file, reversible overlay, hidden layers, or unredacted thumbnail.
- Preserve crop transforms so returned geometry maps correctly to the source image.
- Require explicit approval for each transmission or a clearly scoped, revocable batch. No automatic retry to another provider.
- Do not claim detector recall or anonymization guarantees. Provider retention/training policies and API-key exposure remain relevant.

## 14. Interactive privacy/transfer explorer

Add an explanatory UI after actual mode behavior exists:

- Four views: local, live peers, cloud, and AI.
- Show boundaries between source disk, browser RAM/GPU, OPFS, signaling/TURN, provider storage, local companion, and external AI services.
- Step through the concrete byte flow, key location, encryption/decryption point, and residual visible metadata.
- Distinguish "no data sent", "encrypted content sent", "metadata disclosed", and "plaintext pixels sent with consent".
- Generate labels/status from the same capability/operation descriptors used by runtime policy. Do not present animation as evidence that traffic was blocked.
- Provide a concise accessible text/table equivalent and links to privacy verification instructions.

## 15. Verification and release gates

### Foundation and local release

- Unit/property tests: geometry transforms, command/history semantics, schema constraints, serialization, crypto framing, import/export conversions.
- Fixture tests: EXIF orientation, GPS/serial/time/XMP/IPTC, PNG text/ICC, WebP metadata, alpha, color, malformed/truncated files, decompression-size limits, duplicates.
- Independently inspect sanitized outputs; scan locked database/WAL/OPFS/Cache Storage/IndexedDB/localStorage/diagnostics for known sensitive canaries. Include filenames, label strings, GPS, thumbnail signatures, and key material.
- Crypto tests: known vectors where applicable, wrong passphrase/key, tampered AAD/header/chunk, truncation, reordered/duplicate chunks, nonce uniqueness strategy, KDF migration, backup recovery.
- Browser E2E: create/import/edit/reload/unlock/export; all annotation tools; permissions revoked; storage denied/full; worker crash; tab crash; duplicate tabs; offline refresh; cancelled intake; interrupted migrations.
- Network verification: production build only, fresh and previously installed service-worker profiles, browser request interception plus WebSocket/RTC instrumentation, a logging test origin, and host-level packet capture instructions. Assert no sensitive canaries in any URL/header/body/log. Separate application traffic from browser-managed update traffic.
- Airplane/offline test: after verified app installation, disconnect all network and complete import, all annotation types, save, reload, unlock, and export. No runtime CDN/model/API dependency is allowed.
- Accessibility: automated checks plus keyboard navigation, focus, screen-reader labels, and readable non-color statuses.

### Measurable scale targets

Freeze a public non-sensitive fixture generator/manifest and a reference desktop profile during the foundation spike. Performance claims must include browser version, hardware, total encoded bytes, dimensions, and measurement method.

Release targets, not assumed benchmark results:

- Enumerate/catalog a 10,000-image dataset without eagerly decoding it; first image becomes editable within 5 seconds of its intake/sanitization completing, not after the full folder finishes.
- On a fixed 2,048 x 1,536 reference corpus, incremental renderer-plus-worker memory remains within a 768 MiB budget over idle baseline, excluding storage on disk. Measure WASM/worker memory too, not just the main JS heap.
- Cache allocations are byte-budgeted and independently asserted; a larger source dataset must not cause memory proportional to image count.
- With 1,000 visible vector instances on a reference image, p95 pointer-to-render latency is below 50 ms. Target 60 fps for ordinary navigation; explicitly degrade preview detail rather than corrupt canonical geometry.
- p95 commit acknowledgment below 250 ms for ordinary single annotation edits on the reference machine, excluding intentionally deferred large masks/media writes. Clearly display pending work.
- Repeated open/close and image-navigation tests show no steadily growing bitmap/object-URL/worker/GPU cache retention.
- Benchmark full import throughput and encrypted backup/restore throughput, but set throughput gates from the validated codec/hardware spike instead of inventing universal speed promises.

### Live release

- Real two-browser and eight-participant tests; NAT/TURN-only environments; signaling unavailable; disconnect/rejoin; bounded bulk transfer; host departure and room expiry.
- Verify byte-identical geometry/masks after concurrent edits converge and persistence/reload.
- Inspect signaling/TURN payloads/logs for canaries. Verify selected relay candidates and fail-closed relay behavior.
- Fuzz encrypted framing, message sizes, malformed updates, replayed handshakes, membership changes, and join floods.

### Cloud release

- MinIO contract suite in CI plus real AWS S3/R2 staging verification.
- Confirm uploaded objects and request metadata reveal no plaintext sensitive canaries; decrypt only with expected workspace keys.
- Concurrent device writes, conditional-write failure, interrupted multipart, credential expiry, CORS refusal, stale revisions, corrupted provider data, and restore onto a fresh browser profile.
- Provider-specific HF/Drive suites before claiming support.

### AI release

- Pairing expiry/reuse, unexpected origin/host, unauthenticated tools, invalid schemas, stale patches, lock/revocation, and local-network transport compatibility.
- Contract tests prove coordinates-only tools cannot return pixels, paths, EXIF, secret attributes, or keys.
- Capture actual cloud request payloads and verify they contain only the approved flattened/redacted crop.
- Redaction evaluation reports measured misses on representative data; failure cannot be reframed as a privacy guarantee.

### Production readiness

- Independent cryptographic/security design review before production collaboration/cloud claims.
- Documented backup restore drills, dependency/license checks, reproducible build artifacts where feasible, and signed/reviewed releases.
- No network-enabled or AI feature ships as a placeholder that silently sends plaintext or bypasses the mode controller.

## 16. Implementation todos and dependencies

### 16.1 Phase-by-phase delivery

The following phases are the execution units. The task IDs in each phase refer to the detailed dependency table below. Work inside a phase may proceed independently where dependencies allow, but later-phase implementation does not start before the preceding gate passes and the user directs us to continue.

#### Phase 1: Foundation and feasibility

**Status: complete for the explicitly bounded feasibility lab.** Phases 2 and 3 are partially implemented; see Section 20. Their local release gates have not passed.

**Goal:** Establish the application and prove the risky architectural choices before building annotation features.

- Scaffold TypeScript/React, strict type checking, unit/browser tests, static hosting headers, and capability checks.
- Define canonical schemas, geometry, command/history contracts, and privacy boundaries.
- Prototype ciphertext-only SQLite, encrypted OPFS objects, atomic recovery, worker/key ownership, and orientation/color-safe image sanitization.
- Freeze the reference performance fixture and document measured codec/storage constraints.
- Task IDs: `foundation`, `storage-crypto-spike`, `domain`.
- **Deliverable:** A runnable application shell, tested domain core, and small working storage/crypto/media demonstrations.
- **Gate:** Save/reload/decrypt and crash-recovery proofs pass; sanitized fixtures meet the fidelity/metadata contract; hosting and memory constraints are recorded. Resolve any failed spike before continuing.
- **Not included:** A usable annotation workflow, networking, or AI.

#### Phase 2: Local dataset workspace and vault

**Goal:** Reliably bring images into a private, durable local workspace.

- Implement lazy folder intake, sanitization, thumbnails, progress/cancellation, and per-file failures.
- Implement encrypted persistence, lock/unlock, quota handling, migrations, native encrypted backup/restore, and single-writer protection.
- Build the virtualized gallery, editor viewport/navigation, class schema UI, and review-state shell.
- Task IDs: `media-intake`, `durable-vault`, `editor-shell`.
- **Deliverable:** Open a folder locally, browse sanitized images, save, lock, reload, unlock, and restore a backup.
- **Gate:** No original file modification or outbound dataset traffic; sensitive canaries do not appear in locked app storage; crash, quota, denied-permission, and restore tests pass.
- **Not included:** Complete drawing tools or a claim that the offline app-shell experience is finished.

#### Phase 3: Complete annotation tools and offline workflow

**Goal:** Make the local annotator functionally complete.

- Add boxes, polygons, image labels, attributes, masks, and keypoint skeletons.
- Wire selection, shortcuts, undo/redo, review states, and truthful save status through domain commands.
- Add offline app installation/readiness, local-mode network policy, and safe update handling.
- Add native JSON, COCO, YOLO, and Pascal VOC interchange with compatibility reports.
- Task IDs: `vector-tools`, `mask-keypoint-tools`, `offline-policy`, `interchange`.
- **Deliverable:** A complete local image-annotation workflow, including portable exports.
- **Gate:** Every annotation type survives edit/save/reload/export tests; format loss is explicit; offline refresh and all-tool operation work after installation.
- **Not included:** Live rooms, cloud sync, or AI.

#### Phase 4: Local annotator release gate

**Goal:** Verify robustness before introducing any network-enabled dataset feature.

- Run the complete local privacy, recovery, accessibility, fidelity, and format matrix.
- Measure the 10,000-image corpus, memory bounds, input latency, commit latency, and repeated-navigation resource retention.
- Publish local-mode limitations, backup/recovery instructions, and supported-browser behavior.
- Task ID: `local-release`.
- **Deliverable:** The first independently useful annotator release.
- **Gate:** All applicable local release criteria in Section 15 pass. Fix coupled failures here rather than carrying them into collaboration.
- **Not included:** Any dependency on a cloud service, model service, or companion process for normal annotation.

#### Phase 5: Encrypted live collaboration

**Goal:** Add explicit small-team sharing without weakening local defaults.

- Implement authenticated invitations/admission, the eight-person room limit, signaling, and room/session key separation.
- Implement encrypted WebRTC transfer, bounded backpressure, resume, and fail-closed relay-only mode.
- Integrate validated Yjs edits, concurrency rules, local-user undo, encrypted checkpoints, and presence.
- Task IDs: `room-protocol`, `crdt-collaboration`, `peer-media`, `live-release`.
- **Deliverable:** A tested live-editing release with self-hostable collaboration infrastructure.
- **Gate:** Eight-peer convergence, NAT/TURN, reconnect, host departure, transfer integrity, admission, and privacy-log tests pass.
- **Not included:** Offline asynchronous collaboration through a cloud bucket or claims of complete network anonymity.

#### Phase 6: Encrypted S3-compatible asynchronous sync

**Goal:** Let teammates resume work without another teammate remaining online.

- Implement authenticated encrypted manifests, ciphertext-hash object names, conditional revision publication, merge/retry, and recovery.
- Add scoped credentials and S3/R2/MinIO adapters.
- Test multi-device conflicts, interrupted transfers, fresh-device restore, corruption, and key sharing/revocation.
- Task IDs: `sync-core`, `s3-sync`, `cloud-release`.
- **Deliverable:** A validated encrypted BYOS release for the initial storage providers.
- **Gate:** Provider contract suites and actual S3/R2 staging tests pass; content canaries remain encrypted; local edits survive provider failures.
- **Not included:** Hugging Face/Drive support or server-managed decryption/key recovery.

#### Phase 7: Additional providers and privacy explorer

**Goal:** Broaden storage compatibility and make the implemented privacy flows understandable.

- Add Hugging Face and Google Drive adapters with provider-specific OAuth, atomicity, and format limitations.
- Build the accessible transfer explorer using actual capability descriptors.
- Mark AI paths as unavailable until their later phases ship; do not imply that explanatory diagrams implement a security control.
- Task IDs: `additional-providers`, `transfer-explorer`.
- **Deliverable:** Tested additional storage providers and a truthful local/live/cloud flow explorer.
- **Gate:** Each advertised provider passes its own contract/staging suite; diagrams accurately match the shipped data paths and residual metadata.
- **Not included:** AI access to the workspace.

#### Phase 8: Local MCP bridge and coordinates-only AI tools

**Goal:** Introduce AI integration through the narrowest useful disclosure boundary.

- Prove the browser-to-loopback companion transport and actual supported editor/MCP client interoperability.
- Implement single-use pairing, origin/host validation, capability scopes, expiry, and immediate revocation.
- Expose read-only coordinate/count tools and reviewed, revision-bound mutation proposals.
- Task IDs: `bridge-spike`, `metadata-ai`.
- **Deliverable:** An opt-in local bridge that helps inspect/fix annotations without a pixel-reading capability.
- **Gate:** Pairing, authorization, schema, stale-patch, and lock/revocation tests pass; tool outputs contain no pixels, filenames, paths, GPS, keys, or unauthorized attributes.
- **Not included:** An assurance that an external editor assistant keeps disclosed coordinates/labels off its own cloud backend.

#### Phase 9: Optional local model assistance

**Goal:** Add AI-generated annotation suggestions without requiring image disclosure.

- Add vetted, licensed, integrity-checked model assets and explicit user-controlled installation.
- Implement WebGPU capability checks, a bounded supported local fallback, and clear unsupported-device behavior.
- Apply model results as reviewable, undoable proposals with provenance.
- Task ID: `local-ai`.
- **Deliverable:** Optional local inference integrated with the existing annotation workflow.
- **Gate:** Inference operates offline after model installation; no implicit cloud fallback; memory/device tests and suggestion review/undo pass.
- **Not included:** Automatic claims of accurate face/plate/text redaction from a generic object detector.

#### Phase 10: Explicitly consented cloud vision and AI release

**Goal:** Permit carefully scoped external image requests without disguising the disclosure.

- Add evaluated local masking assists, manual opaque redaction, exact crop preview, flattened/scrubbed request objects, and explicit provider consent.
- Verify crop-to-source geometry mapping, batch revocation, and exact outgoing payloads.
- Complete AI documentation and enable the explorer's real AI paths.
- Task IDs: `cloud-ai-redaction`, `ai-release`.
- **Deliverable:** The AI integration release, with local-only and external-provider workflows clearly distinguished.
- **Gate:** All AI release criteria in Section 15 pass, including actual request-payload inspection and documented redaction limitations.
- **Not included:** Guaranteed anonymization, automatic medical de-identification certification, or recall of data already disclosed.

### 16.2 Detailed tasks and prerequisites

Tracking IDs below are mirrored into the session SQL todo database. The phase assignments above are mirrored separately for execution tracking. These are dependency groups, not time estimates.

| ID | Work item | Prerequisites |
|---|---|---|
| foundation | Scaffold app, strict tooling, headers, capability screen, benchmark harness, architecture/privacy contracts | None |
| storage-crypto-spike | Prove SQLite ciphertext records, encrypted media, worker ownership, key lifecycle, atomic recovery, codec fidelity, and deployment behavior | foundation |
| domain | Implement canonical entities, schemas, geometry, commands, and history | foundation |
| media-intake | Implement bounded folder intake, sanitizer, thumbnails, canary fixtures, and metadata policy | storage-crypto-spike, domain |
| durable-vault | Implement persistence, migrations, locking, conversion, quota handling, native backup/restore, and crash recovery | storage-crypto-spike, domain |
| editor-shell | Implement virtualized catalog, layered renderer, navigation, selection, schema/review UX, accessibility | domain |
| vector-tools | Implement boxes, polygons, image-level labels, attributes, shortcuts, and history integration | editor-shell, media-intake, durable-vault |
| mask-keypoint-tools | Implement tiled instance masks, brush undo, keypoint skeletons, and bounded rendering | vector-tools |
| offline-policy | Implement service worker, network-mode controller, offline readiness, update flow, and production header tests | foundation, durable-vault |
| interchange | Implement validated native JSON/COCO/YOLO/VOC interchange and compatibility reports | mask-keypoint-tools, durable-vault |
| local-release | Pass offline, privacy-canary, accessibility, recovery, format, and 10,000-image gates; document local release | media-intake, durable-vault, offline-policy, interchange |
| room-protocol | Implement reviewed room capabilities, admission, signaling, key separation, peer transport, expiry, and TURN policy | local-release |
| crdt-collaboration | Implement validated Yjs state, conflict/undo policy, encrypted checkpoints, and concurrent edit convergence | room-protocol |
| peer-media | Implement encrypted bounded media transfer, prioritization, resume, integrity, and quotas | room-protocol |
| live-release | Pass eight-peer/NAT/relay/concurrency/recovery tests and publish self-hosting guidance | crdt-collaboration, peer-media |
| sync-core | Implement encrypted object/manifest layout, revision merges, conditional publication, credential boundary, and recovery | live-release |
| s3-sync | Implement AWS S3/R2/MinIO adapter and provider contract tests | sync-core |
| cloud-release | Pass multi-device restore/conflict/privacy gates and publish key-sharing/revocation guidance | s3-sync |
| additional-providers | Implement HF and Drive adapters with explicit provider limitations and staging validation | cloud-release |
| transfer-explorer | Implement accessible truthful flow explorer tied to runtime capability descriptors | cloud-release |
| bridge-spike | Verify secure loopback transport, actual MCP client compatibility, pairing, origin/host controls, and capability model | cloud-release |
| metadata-ai | Implement read-only metadata tools, reviewed mutation proposals, revision checks, audit, and revocation | bridge-spike |
| local-ai | Implement optional vetted local model runtime, suggestions workflow, device fallback, and licensing/download controls | metadata-ai |
| cloud-ai-redaction | Implement local pre-mask, exact crop preview, flattened raster export, provider consent, and disclosure tests | local-ai |
| ai-release | Pass MCP/consent/redaction/privacy tests; update explorer and publish bounded AI guarantees | cloud-ai-redaction, transfer-explorer |

Do not advance through a release gate with unresolved privacy/durability failures. A failed feasibility spike changes the architecture explicitly before dependent implementation proceeds.

### 16.3 Phase handoff contract

At the end of each phase:

1. Provide the runnable deliverable and list the task IDs completed.
2. Report the exact checks run, measured results where relevant, and any known limitations.
3. Update the plan and SQL statuses to reflect reality; leave a failed gate blocked rather than marking it done.
4. Preserve a clean, reproducible way to run the completed feature. Do not create a commit unless requested.
5. Stop before the next phase and wait for explicit direction. Any newly discovered scope or privacy trade-off is resolved before proceeding.

The first implementation request should begin with Phase 1 only unless the user explicitly selects a different bounded scope.

## 17. Risks, deferred scope, and design checkpoints

- Native browser decoding/color behavior and lossless sanitization need fixture-backed decisions before guaranteeing image fidelity. Technical sanitization cannot remove patient names or other sensitive information burned into pixels.
- Ciphertext-only SQLite protects content, not its schema or all access patterns. Whole-file SQLCipher/custom encrypted VFS is not part of this plan.
- OPFS quota may be inadequate for a large sanitized corpus. Fail visibly and offer smaller imports/encrypted backups; do not silently offload to a cloud.
- Full-resolution masks, exports, and encrypted rekey operations are storage-heavy; all require progress, cancellation, and transaction-safe resumption.
- Yjs convergence does not automatically imply semantically valid annotations or secure membership.
- TURN bandwidth, operational logs, room abuse protection, and credential issuance need an operator; a static site alone cannot supply them.
- Browser CSP endpoint allowlists and loopback permissions constrain deployment; verify against actual production headers.
- Room/key revocation is prospective. No architecture can revoke plaintext already seen by a collaborator.
- Shared workspaces are trusted-editing groups initially; fine-grained cryptographic roles, organization SSO, managed key escrow, and server-hosted accounts are deferred.
- Video, DICOM/volumetric tools, mobile parity, full GIS, rotated boxes, polygon holes, automatic mask/vector conversion, and arbitrary plugins are deferred.
- A detector/redactor is an aid, not medical de-identification certification or a guarantee of anonymization.

## 18. Primary references to re-check during implementation

These are technical references, not substitutes for runtime validation. Search summaries must not override specifications or observed browser behavior.

- [SQLite WASM persistence and OPFS VFS trade-offs](https://sqlite.org/wasm/doc/trunk/persistence.md)
- [MDN: Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [MDN: storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [MDN: createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)
- [MDN: CSP connect-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)
- [W3C Content Security Policy](https://www.w3.org/TR/CSP3/)
- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [Web Crypto specification](https://www.w3.org/TR/WebCryptoAPI/)
- [OWASP: PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [MDN: WebRTC data channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
- [W3C WebRTC specification](https://www.w3.org/TR/webrtc/)
- [Yjs y-webrtc implementation and constraints](https://github.com/yjs/y-webrtc)
- [MCP transport specification](https://modelcontextprotocol.io/specification/latest/basic/transports)
- [MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices)

## 19. Phase 1 execution results (historical snapshot)

Completed task IDs: `foundation`, `storage-crypto-spike`, `domain`. The detailed persistent handoff is in `/Users/matthew/annotate/docs/phase-1-results.md`.

Delivered:

- Runnable TypeScript/React foundation lab, capability checks, self-hosted production build, deployment headers, and VS Code build/preview tasks.
- Versioned runtime schemas, canonical geometry, class/skeleton/mask/keypoint/label contracts, and revision-bound per-image command history.
- Real worker-owned official SQLite WASM SAH pool persistence, ciphertext records and OPFS media, PBKDF2 wrapping, purpose-separated HKDF keys, authenticated chunks/final marker, single-writer locking, and interrupted-media-write recovery.
- Bounded JPEG/PNG/WebP-to-lossless-rendered-sRGB-PNG proof, all eight EXIF orientations, independently inspected metadata-free output, and explicit rejection of uncertified media.
- Synthetic fixture generation, a persistent 10,000-descriptor reference manifest, a benchmark measurement harness, dependency inventory generation, and directly related documentation.

Verification:

- Strict TypeScript and production build pass.
- 24 unit tests across four files pass.
- Seven production Chromium browser tests pass; final changes to context-wide network observation and EXIF-fixture assertions also pass targeted regression tests.
- Persistence survives worker lock/reload and closing a tab without locking; wrong passphrases fail.
- A synthetic media-before-record interruption recovers its encrypted orphan while retaining committed work.
- Closed OPFS scans find no test-note/passphrase/filename/camera-serial canaries or plaintext PNG signatures; tested network requests disclose no sensitive canaries.
- Production CSP/headers, actual WASM MIME/loading, and no-COOP/COEP SAH-pool operation are verified.
- One 2048 x 1536 synthetic image yields zero rendered-pixel difference, 66,678 sanitized bytes, and byte-identical restoration. A recorded run measured about 184 ms sanitization UI wall time and a 10 ms worker-reported save commit; these are single observations, not p95/performance promises.

Explicit spike decisions and limitations:

- Storage/crypto share one dedicated worker for the proof; media has a separate worker.
- Limits are 100 proof records, 4 megapixels/image, 8 MiB/input/output/object, one in-flight operation per worker, and a 45-second deadline.
- ICC-profiled, 16-bit, and animated images are rejected. The certified subset is browser-rendered sRGB, not archival or diagnostic-medical source fidelity.
- Chunk-authenticated objects are bounded in memory; the full streaming file API remains later work.
- The 10,000-image corpus has a generated manifest, not a completed import or total-memory benchmark.
- Recovery tests do not replace exhaustive migration/power-loss/write-boundary tests.
- No folder workspace, drawing UI, backup/restore feature, service-worker offline installation, collaboration, cloud sync, or AI has been built.
- Experimental proofs are for synthetic data only and are not independently audited production cryptography.

The Phase 1 gate is satisfied for these explicit proof contracts. Continue with Phase 2 only after the user's next instruction.

## 20. Current implementation and authorized continuation

The user has authorized completing all remaining phases, including AI. This authorization does not waive release gates or make unverified interoperability, privacy, durability, or performance claims complete.

Implemented since the Phase 1 snapshot:

- Workspace-first dashboard replacing the photo entry card: create named independent datasets, select optional password protection at creation, import folders/images inside each workspace, and exit/reopen without deleting data. New workspaces have separate SQLite/OPFS namespaces and keys; legacy schema-3 data is adopted as Existing workspace with annotations and ciphertext media preserved. No-password mode stores its key locally and is not access protection from browser-profile owners. Workspace names/protection flags/creation times are public local metadata.
- Additive YOLO detection datasets, app-managed encrypted media/annotations, image removal without source modification, and paged catalog navigation.
- Large Dataset / Annotate / Export editor with boxes, polygons (click-first-vertex closure and a live closed-edge preview), lines, basic keypoints/skeleton controls, whole-image labels, bounded geometry editing, zoom/pan, undo/redo, review, and loaded-page search/filtering.
- Six plaintext export formats (YOLO detection/segmentation, COCO boxes/polygons, Pascal VOC, CSV, native per-image JSON), current/dataset scope, image inclusion toggle, compatibility preflight, and streamed aggregate annotations.
- Explicit offline app-shell installation/update handling, offline reload/unlock coverage, single-writer retry, and same-tab proof-worker handoff.
- Versioned encrypted dataset backups using an independent backup key/passphrase, ciphertext-only local folders, authenticated object membership/digests, verified writes, and a final completion header. Restore into an empty vault authenticates/stages/re-encrypts each item and publishes the dataset atomically. Cancellation, damage, and interruption cannot expose a partially restored dataset. Developer proof records and undo/UI state are intentionally excluded.
- Workspace passphrase change using fresh wrapping salt/nonce and atomic header publication. This rewraps the existing root, not full data-key rotation; previous backups/headers are not revoked.
- In-workspace Live share entry starts host-led encrypted collaboration (Phase 5); cloud sync is unavailable, and manual export and encrypted backup remain available. Developer proofs are isolated behind a collapsed dashboard disclosure.
- Added the accessible privacy-flow explorer, the optional local MCP companion and browser review panel, bounded cloud-vision requests, and consent-gated local RT-DETR inference. The local model was downloaded and run in Chromium; its ONNX WASM assets are self-hosted and fetched only when inference is invoked. MCP client and network deployment compatibility remain uncertified.
- Added portable encrypted snapshot/proposal files for image and folder sharing without a storage account. The snapshot secret is communicated separately; imports create independent password-protected local copies, and owner review uses the same authenticated atomic merge as S3 sharing. File invitations have no expiry/revocation, a 64 MiB snapshot limit and one accepted proposal, not automatic synchronization. Browser tests reject a wrong secret and corrupt proposal before a successful offline exchange and persistent merge.
- Added website BYOK presets for OpenAI, Gemini and OpenRouter with shared endpoint/CSP policy, memory-only provider keys, bounded deadlines, explicit network/CORS errors and per-send preview consent. Custom compatible endpoints still require deployment configuration. Added Copilot/Antigravity standard stdio configuration generation and pairing instructions, separate loopback ports, and actual browser/companion/SDK review/undo/revocation tests. Editor subscriptions are not website API keys; neither actual editor applications nor live provider accounts/CORS are certified by these tests.
- Fixed the cross-tab dashboard lock: the public workspace list now has independent OPFS JSON storage and a short queued catalog lock. Previous SQL catalogs migrate without moving datasets. Editing locks are per workspace, with explicit SQLite VFS access-handle release; different workspaces can edit concurrently and dashboards remain available. Only a second editor of the same dataset is rejected, with retry after exit/termination. Dashboard focus refreshes the workspace list. A still-running previous-version legacy editor must exit/reload for the one-time catalog upgrade; locks are never forcibly stolen.
- Added encrypted dataset-wide class and named-skeleton definitions with independent schema revisions. Legacy per-image definitions reconcile by exact name in bounded record-by-record preparation, published only at completion without rewriting media. Reads/exports share canonical IDs; new points are absent while saved coordinates remain exact. Additions apply across existing/future images and reset current-image undo. Explicit migrations now preview class removal/merge and skeleton point reorder/rename/removal: used classes require remapping, no annotations are deleted, and surviving coordinates follow names. Per-image coordinate-loss counts require confirmation only for discarded occupied coordinates. Worker-owned tokens reject stale/replayed plans; encrypted document staging and schema publish in one transaction, incrementing image revisions without rewriting media/masks. Targeted storage failures, legacy/name mapping, UI confirmation/counts, cancellation, reload, and stale-save guards are covered. Per-image saves cannot overwrite shared definitions. Backup/restore preserves schemas even with zero images, and publishes restored schema/records atomically.

Additional local prerequisites implemented:

- Binary tiled mask brush/erase, immutable encrypted tile objects and ownership/padding checks, bounded current/history budgets, exact undo/redo/reload, encrypted backup/restore, native sidecars, and COCO RLE.
- Persistent instance visibility/locking and primitive typed JSON attributes; attribute undo refreshes the editor. Polygon click-to-close, live fill/closing-edge preview, vertex insertion/removal, vector duplication, line drawing/editing, named keypoint placement/visibility, and mask shortcuts 5/6 are wired.
- Atomic native/COCO/VOC/YOLO detection/YOLO segmentation annotation replacement onto existing images. Native preserves editor fields and exact mask pixels. Supported COCO geometry includes simple polygons, uncompressed RLE and keypoints; crowd semantics are explicit. Compressed RLE/multipart polygons and unsupported custom COCO attributes are rejected. VOC preserves boolean difficult/truncated flags. Imports are bounded batches, not a streaming parser.
- Manual/inactivity lock, optional generated recovery-secret download/use/regeneration, and staged full root-key rotation. Interrupted rotation retains the old key; publication changes all current records/images/masks/schema and invalidates recovery/derived thumbnails. Existing backups/copied old data are not revoked. Protection conversion uses encrypted backup/verified staged restore into a separate fresh-key workspace; there is no in-place mode toggle.
- Exact-name-confirmed workspace deletion with exclusive editing lease and persistent deletion marker before scoped cleanup. Incomplete deletion cannot reopen a partially deleted namespace and offers retry. Original folders/backups/exports remain untouched; no forensic-erasure claim.
- Full-catalog metadata indexing/search/counts, 100-row gallery/editor limits, search-result pagination, explicit page-limited encrypted cached thumbnails, and URL cleanup on page/filter/image/lock changes.
- Quota preflight with honest estimate/PNG-expansion warnings and encrypted per-image intake checkpoints. Opt-in resumption reselects source files, skips exact source/path/label/class inputs, and preserves later edits; changed inputs add separate images. Old imports/restored backups without checkpoints are not silently deduplicated.

Latest verification: `npm test` passes **231 tests across 25 files**; app and bridge typechecks and the production build pass. The main JavaScript chunk is 649.00 kB and retains a nonfatal size warning. Foundation browser tests pass **37/37**, encrypted sharing **4/4**, BYOK/MCP integrations **5/5**, and accessibility, Pages/offline, the privacy explorer's two focused browser tests and real consented local-model inference pass. All three live scenarios pass on both relay runtimes, including eight participants on one machine. The model test verifies no jsDelivr runtime request. BYOK browser requests use mocked provider responses; MCP tests launch the real companion and official SDK, not either editor application. These checks do not certify real provider staging/CORS, multi-network NAT/TURN, editor applications/HTTPS loopback permissions, device-wide memory, exhaustive power-loss durability, or broad assistive-technology support. Earlier source review does not certify later additions or replace independent cryptographic review. The 10,000-image production-browser reference run and its limitations are recorded in [docs/verification.md](./docs/verification.md) and `benchmarks/results/2026-10-17-reference.json`. Supported JPEG/PNG/WebP cases include independent output inspection, metadata/alpha checks, and EXIF/color fixtures; ICC-profiled, 16-bit, and animated sources remain explicitly rejected.

Remaining before the local release gate:

- The schema-migration UI now supports stable-ID class/skeleton renaming and removal of unused skeletons. Removing a skeleton referenced by saved annotations is rejected. This closes that migration feature gap; migration-specific exhaustive quota/power-loss/interruption boundaries remain part of the fault matrix below.
- Fully streaming large annotation parsing and extended compatibility fixtures; supported bounded import/export modes are implemented, not universal format conversion.
- Complete migration/permission/actual mid-write quota/power-loss/crash fault matrix, including deletion and all new mask/import/rotation publication boundaries. Quota preflight and synthetic interrupted/rollback cases do not establish behavior at every real write boundary.
- Complete scale certification: total renderer-plus-worker memory within 768 MiB, actual p95 pointer-to-paint below 50 ms with 1,000 visible vectors, and non-growing worker/WASM/decoded/GPU/native resources. The recorded label-edit and render-opportunity measurements do not prove these gates.
- Manual screen-reader and broader assistive-technology checks; browser compatibility beyond the tested Chromium path. Automated axe/keyboard checks have passed.
- Wider codec/color fidelity beyond the explicitly supported JPEG/PNG/WebP subset and current 4 MP/8 MiB limits. ICC-profiled, 16-bit, and animated inputs are rejected; archival/diagnostic color fidelity is not claimed.

Host-led live collaboration, approval-based encrypted file/S3 snapshot sharing, provider adapters, the privacy-flow explorer, MCP, and bounded AI workflows are implemented with the scoped tests described above. They do not constitute continuous encrypted BYOS sync: Hugging Face and Google Drive are standalone adapters, and no integrated revisioned S3 sync engine or automatic conflict merge exists. Eight-peer local coverage passes; remaining live-release gates include multi-network NAT, TURN-only and production recovery/load validation. Local migration/quota/power-loss fault coverage, complete renderer-plus-worker memory and pointer-to-paint certification, manual assistive-technology review, and broader browser/codec validation also remain open. Production provider staging, external editor/HTTPS loopback compatibility, and independent cryptographic review are not claimed.

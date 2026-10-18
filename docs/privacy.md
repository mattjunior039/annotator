# Privacy contract and threat model

## Data paths in this phase

1. The browser loads the application, worker scripts, and SQLite WASM from the same origin.
2. A user-selected file is decoded inside a media worker. It is never sent to a server.
3. A freshly encoded sanitized PNG and preview exist transiently in browser memory.
4. On explicit save or import, the storage worker encrypts annotation documents and sanitized media before writing SQLite/OPFS.
5. Exit, manual lock, and protected-workspace inactivity lock terminate workers, clear app-held sensitive state, and revoke image/mask/thumbnail/recovery URLs. Protected workspaces require their passphrase again; no-password workspaces can be reopened by anyone with access to the browser profile.
6. Explicit annotation export writes the selected format (YOLO, COCO, Pascal VOC, CSV, or native JSON), optionally with sanitized PNGs, as plaintext into a new user-selected local folder outside vault encryption. Filenames and the export manifest may identify the dataset. Only choose destinations where plaintext copies are appropriate.
7. Explicit **Encrypted backup** encrypts dataset records/media and the manifest inside the storage worker using a separate random backup key and user-confirmed backup passphrase. Only ciphertext and public wrapping metadata reach the selected folder. Restore authenticates and stages the dataset before atomic publication into an empty workspace. Developer proof records and in-memory history are excluded.

8. Explicit **Live share** sends requested images and annotation documents to approved guests. They travel as AES-256-GCM frames through the same-origin `/signal` relay, or through a WebRTC data channel in Direct mode. Guests hold them only in memory. Nothing is transmitted until the host starts a session and approves a guest whose verification code matches. See [live-collaboration.md](live-collaboration.md).

No analytics, crash uploads, remote fonts, CDN imports, cloud SDKs, AI services, or automatic model downloads are present. Signaling, and STUN in Direct mode, are contacted only during a live share session. The original source folder is not modified during import, editing, or workspace removal. Development tooling may use a same-origin HMR WebSocket; validate privacy against the production build.

## Protected and unprotected

Password-protected workspaces and proof content have passphrase-wrapped keys, protecting saved content while locked subject to passphrase strength and cryptographic assumptions. No-password workspaces still encrypt records/media, but persist their root key locally and reopen automatically: this is not at-rest access protection from browser-profile or device access. Backups always use an independent passphrase, regardless of the source workspace's protection mode. Sensitive filenames, annotations, and images are not plaintext SQL parameters, rows, or journal entries.

Observers can still see workspace names, protection settings, creation times, public key-wrapping parameters, format version, opaque IDs, SQLite schema, lengths, counts, storage activity, and the application origin. Do not put sensitive information in workspace names. Browser storage is not hidden from the computer owner. Workspace separation is for dataset organization, not a defense against malicious same-origin code or someone with raw profile access.

The original source folder is unchanged and not protected by this vault. App-managed data can be cleared with site data; OPFS is not backup storage.

Keep complete encrypted backup folders outside the browser profile and retain their passphrases separately. Backup sizes, counts, opaque IDs, and KDF parameters remain observable. A local folder managed by a separate cloud-sync application can be uploaded by that application; this site does not control it. Filesystem permissions and other programs may also modify/delete backups.

Changing the workspace passphrase rewraps the same root key, with a fresh salt/nonce; it does not change independent backup passphrases, revoke copied previous vault headers, or rotate a compromised data key. Full root-key rotation separately stages re-encryption of current records/images/masks/schema, publishes the new header atomically, invalidates recovery and derived thumbnails, then removes obsolete files. It cannot revoke old backups, copied data/headers, authorized plaintext copies, or forensic remnants.

An optional downloaded recovery file contains a plaintext 256-bit secret. Together with surviving workspace storage it bypasses the normal passphrase; keep it securely separate. The app persists only an independent wrapper, never the secret. Regeneration replaces that wrapper, normal passphrase changes retain it, and full key rotation invalidates it. A recovery file alone cannot restore cleared browser data. There is no server password-reset service.

Page thumbnails are generated locally from sanitized canonical media and encrypted before OPFS writes; no plaintext derivative cache is persisted. At most 100 page-preview URLs are retained, revoked on page/filter/image changes or lock. Resumable intake stores source fingerprints and their context only inside encrypted image records. They are not transmitted or exposed as public storage filenames.

Protection mode is chosen at workspace creation. There is no in-place password-mode conversion. Use encrypted backup/restore into a new workspace with the desired protection, verify the restored data, then explicitly delete the old workspace if appropriate. The old source remains intact until deletion; an old unprotected copy remains unprotected. Dashboard deletion checks the exact workspace name and refuses active editors; interrupted deletion stays marked for retry. It cannot promise secure disk erasure. Opening the Live share panel does not transmit data. Starting a session connects to the relay. Approved guests can view and copy anything they are shown, and removal cannot revoke that.

Not protected against:

- A compromised browser, extension, OS, served application, or dependency at unlock time.
- Weak passphrases, clipboard/history/screenshots, OS swap, GPU memory, crash dumps, or forensic recovery of previous plaintext.
- Lost keys/passphrases without an enabled recovery file and surviving data. No server can reset or decrypt the workspace.
- Identifying information in actual image pixels; metadata stripping is not medical de-identification.
- Authorized users exporting or copying plaintext.

## Offline and network assurance

The user can explicitly install a versioned service-worker app shell. It precaches the static application entry point, JavaScript, CSS, WASM, and worker assets; it does not cache workspace media or annotation data. The production Chromium test verifies an offline reload, local unlock, and image access from OPFS. This is a tested browser scenario, not a guarantee for every browser, OS, extension, or managed-device policy.

`connect-src 'self'` permits same-origin requests. It does not itself prevent all exfiltration paths or universally govern WebRTC. The only dataset transport is a host-started live share session. The relay sees only ciphertext, room IDs, sizes, timing, and connection IPs. Direct mode additionally reveals IP addresses to peers and the STUN server. Browser-managed requests and compromised code are outside a runtime application's complete control.

Service-worker installation and updates are explicit user actions and can contact the app origin while online. A page-level network policy is weaker than a separately served immutable network-denying document. A physical network disconnect or host firewall is stronger evidence that packets cannot leave.

## Disclosure requirements for later phases

- Live share (implemented) uses deliberate admission and separate room keys. The relay operator can see the metadata listed above. A future TURN-backed relay-only WebRTC mode must fail closed.
- Cloud clients must receive ciphertext only; filenames and semantic indexes stay encrypted. Sizes/timing remain observable.
- A localhost MCP hop does not control what an external AI assistant later sends to its provider. Coordinates/labels can themselves be sensitive.
- Local pre-mask models are fallible. External vision needs exact flattened crop preview and explicit consent, not an anonymization claim.

This project does not claim HIPAA/GDPR certification, complete anonymity, secure memory erasure, literal zero-copy processing, or mathematical no-egress guarantees.

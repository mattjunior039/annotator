# Privacy contract and threat model

## Data paths in this phase

1. The browser loads the application, worker scripts, and SQLite WASM from the same origin.
2. A user-selected file is decoded inside a media worker. It is never sent to a server.
3. A freshly encoded sanitized PNG and preview exist transiently in browser memory.
4. On explicit save or import, the storage worker encrypts annotation documents and sanitized media before writing SQLite/OPFS.
5. Exit workspace (or lock in the developer lab) terminates workers, clears app-held sensitive state, and revokes the preview URL. Protected workspaces require their passphrase again; no-password workspaces can be reopened by anyone with access to the browser profile.
6. Explicit annotation export writes the selected format (YOLO, COCO, Pascal VOC, CSV, or native JSON), optionally with sanitized PNGs, as plaintext into a new user-selected local folder outside vault encryption. Filenames and the export manifest may identify the dataset. Only choose destinations where plaintext copies are appropriate.
7. Explicit **Encrypted backup** encrypts dataset records/media and the manifest inside the storage worker using a separate random backup key and user-confirmed backup passphrase. Only ciphertext and public wrapping metadata reach the selected folder. Restore authenticates and stages the dataset before atomic publication into an empty workspace. Developer proof records and in-memory history are excluded.

No analytics, crash uploads, remote fonts, CDN imports, signaling, STUN/TURN, cloud SDKs, AI services, or automatic model downloads are present. The original source folder is not modified during import, editing, or workspace removal. Development tooling may use a same-origin HMR WebSocket; validate privacy against the production build.

## Protected and unprotected

Password-protected workspaces and proof content have passphrase-wrapped keys, protecting saved content while locked subject to passphrase strength and cryptographic assumptions. No-password workspaces still encrypt records/media, but persist their root key locally and reopen automatically: this is not at-rest access protection from browser-profile or device access. Backups always use an independent passphrase, regardless of the source workspace's protection mode. Sensitive filenames, annotations, and images are not plaintext SQL parameters, rows, or journal entries.

Observers can still see workspace names, protection settings, creation times, public key-wrapping parameters, format version, opaque IDs, SQLite schema, lengths, counts, storage activity, and the application origin. Do not put sensitive information in workspace names. Browser storage is not hidden from the computer owner. Workspace separation is for dataset organization, not a defense against malicious same-origin code or someone with raw profile access.

The original source folder is unchanged and not protected by this vault. App-managed data can be cleared with site data; OPFS is not backup storage.

Keep complete encrypted backup folders outside the browser profile and retain their passphrases separately. Backup sizes, counts, opaque IDs, and KDF parameters remain observable. A local folder managed by a separate cloud-sync application can be uploaded by that application; this site does not control it. Filesystem permissions and other programs may also modify/delete backups.

Changing the workspace passphrase rewraps the same root key, with a fresh salt/nonce; it does not change independent backup passphrases, revoke copied previous vault headers, or rotate a compromised data key. Full rotation, recovery secrets, and inactivity lock remain unfinished.

Protection mode is chosen at workspace creation. There is no in-place password-mode conversion. Use encrypted backup/restore into a new protected workspace to move a no-password dataset. The Sharing panel is informational until collaboration and encrypted cloud sync are implemented; opening it does not transmit data.

Not protected against:

- A compromised browser, extension, OS, served application, or dependency at unlock time.
- Weak passphrases, clipboard/history/screenshots, OS swap, GPU memory, crash dumps, or forensic recovery of previous plaintext.
- Lost keys/passphrases. No server can reset or decrypt this proof vault.
- Identifying information in actual image pixels; metadata stripping is not medical de-identification.
- Authorized users exporting or copying plaintext.

## Offline and network assurance

The user can explicitly install a versioned service-worker app shell. It precaches the static application entry point, JavaScript, CSS, WASM, and worker assets; it does not cache workspace media or annotation data. The production Chromium test verifies an offline reload, local unlock, and image access from OPFS. This is a tested browser scenario, not a guarantee for every browser, OS, extension, or managed-device policy.

`connect-src 'self'` permits same-origin requests. It does not itself prevent all exfiltration paths or universally govern WebRTC. The current build has no collaboration, signaling, cloud, AI, or other dataset transport. Browser-managed requests and compromised code are outside a runtime application's complete control.

Service-worker installation and updates are explicit user actions and can contact the app origin while online. A page-level network policy is weaker than a separately served immutable network-denying document. A physical network disconnect or host firewall is stronger evidence that packets cannot leave.

## Disclosure requirements for later phases

- A live room needs deliberate admission and separate room keys. Relay-only modes must fail closed and acknowledge operators' metadata visibility.
- Cloud clients must receive ciphertext only; filenames and semantic indexes stay encrypted. Sizes/timing remain observable.
- A localhost MCP hop does not control what an external AI assistant later sends to its provider. Coordinates/labels can themselves be sensitive.
- Local pre-mask models are fallible. External vision needs exact flattened crop preview and explicit consent, not an anonymization claim.

This project does not claim HIPAA/GDPR certification, complete anonymity, secure memory erasure, literal zero-copy processing, or mathematical no-egress guarantees.

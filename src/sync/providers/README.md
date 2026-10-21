# Bounded encrypted-object adapters

These are standalone transport primitives, **not cloud sync or persistent sharing**.
Nothing is wired into the application, workspace, sharing, deployment CSP, or OAuth
UI. The sync requirements are currently in root `plan.md` (`docs/plan.md` is not
present); `docs/persistent-sharing.md` describes the separate S3 invitation flow.

## Boundary and use

Import from `src/sync/providers/index.ts`. Encrypt upstream, then explicitly attest
to the boundary with `ciphertext(encryptedUint8Array)`. This brands bytes for
TypeScript; it **does not verify encryption**. Never pass plaintext. Providers
accept no workspace keys, decryption callbacks, user labels, original filenames,
dataset cards, previews, or arbitrary metadata. Keys must be lowercase 64-character
hex strings, intended for ciphertext hashes or random opaque names. Hash/content
authentication and decrypted manifest validation belong upstream: providers return
raw bytes, including corrupt ciphertext, without attempting to decrypt them.

`put(key, ciphertext, { condition })` snapshots bytes, returns an object ID and
(for HF) a repository revision. `get(id, signal?)` returns bytes or null on 404.
`list({ cursor?, signal? })` returns **one page**, at most 100 entries. Pass its
cursor to the next call; callers must bound total pages and detect longer cursor
cycles. Invalid entries, oversized metadata, and incomplete Drive searches fail
closed rather than claiming a complete listing. Use a dedicated repo/folder.

Both adapters use fixed HTTPS API origins, omit cookies/referrers, refuse redirects,
bound metadata to 512 KiB, and stream-read into a bounded buffer. Uploads are
buffered, not streaming; there is no multipart/resumable recovery. Each operation
has a 30-second deadline (configurable from 1 to 120,000 ms), including credential
refresh and body reads, plus caller abort. Aborted writes have **uncertain outcomes**.
No automatic retries, including 401, 429, conflicts, or network failures.
No logging, token persistence, or provider error-body forwarding is performed.

## Hugging Face

Supply an existing **private dataset repository**, `namespace/repository`, a simple
branch name (default `main`), and a scoped, short-lived token with epoch-millisecond
expiry. Optional `credentials.refresh(signal)` must be explicitly supplied to
refresh an expired token; absent or failed refresh yields `credential-expired`.
No repo creation, visibility changes, LFS, Xet, or external download redirects.
Only inline Git objects up to **1 MiB** are supported, with NDJSON commit uploads
and raw Git downloads under `objects/<opaque-key>.enc`.

`{ kind: 'revision', revision: '<40-hex parent commit>' }` sends the server's
`parentCommit` guard. This is a **repository-wide** conditional commit, not a
per-object ETag. Unrelated repository commits can conflict. Callers must obtain a
trusted repository revision separately and perform their own merge/publication
policy; list cursors are not snapshots. `{ kind: 'create-only' }` is unsupported.
An unconditional put can replace an existing path. A Git commit is atomic at the
repository level, but this API does not implement atomic multi-object manifest
publication. Encrypted blobs are not browsable Hugging Face Dataset/Parquet data.

## Google Drive

OAuth is a **public-client** responsibility outside this module. Supply an
app-accessible existing folder ID, an access token with expiry, the actual granted
`scopes: [DRIVE_FILE_SCOPE]` (`https://www.googleapis.com/auth/drive.file`), and an
**explicit required** `credentials.refresh(signal)` callback. The callback must
return a token with the same grant and honor abort; it may reacquire consent.
Scopes are caller attestation, not token introspection. No OAuth client secret,
refresh token storage, implicit consent, popup flow, or seamless persistent
authorization is implemented. Broader scopes and `appDataFolder` are unsupported.
Do not embed client secrets. An expired/rejected token is never silently replayed.

Objects up to **5 MiB** use multipart uploads; downloads use `alt=media`.
Drive names are **not unique**. A put without `objectId` always creates a new file
(duplicates are possible); a put with `objectId` replaces exactly that file ID,
unconditionally. Get uses file IDs, not opaque names. Listing preserves duplicate
names and IDs. Folder scoping applies to creation/listing; callers must retain and
authorize IDs for get/replacement. There is no read-before-write name lookup.
**No conditional writes or atomic manifest publication are guaranteed**. Both
revision and create-only conditions are rejected before network access. Do not use
this adapter as a compare-and-swap multi-device manifest authority.

## Deployment and certification

Providers see opaque identifiers, sizes, revisions, access tokens, timing and IPs.
Encryption does not hide that metadata or revoke downloaded ciphertext. Callers
own explicit network-disclosure consent, credential scope/lifetime, and CSP/CORS
configuration for `https://huggingface.co` and `https://www.googleapis.com`.
Redirect-requiring HF deployments are intentionally unsupported rather than
forwarding credentials to another host.

Contract tests stub fetch; they do not certify actual provider/CORS behavior,
public-client OAuth popup/COOP compatibility, or a production sync release.

Protocol references:
- https://huggingface.co/.well-known/openapi.json (dataset commit/tree APIs)
- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow

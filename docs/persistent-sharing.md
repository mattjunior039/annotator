# Encrypted snapshots and approval-based contributions

**Share workspace** is separate from **Live share**. Recipients keep independent local copies and can work while the owner is offline. Choose encrypted file exchange (no storage account) or a user-supplied S3-compatible bucket.

## Send images or a folder to a friend without an account

1. Create a workspace and use **Add images** or **Add folder**. Import makes sanitized, app-managed copies; your original files remain unchanged.
2. Open **Share workspace → Send an encrypted file (no storage account needed)**, enter an invitation label and choose **Create encrypted share file**.
3. Download the `.annotator-share` file and send it using your preferred file-transfer service. Send the displayed **File decryption secret** separately, through a trusted channel. The secret is not embedded in the file.
4. Your friend opens the app dashboard, expands **Open a workspace invitation**, selects **Encrypted share file**, chooses the file and enters its secret. They choose a local name and a new working-copy passphrase, then click **Import file & create local copy**.
5. They annotate their local copy, open **Share workspace**, enter an author and summary, choose **Create encrypted proposal file**, download the `.annotator-proposal` file and return it to you.
6. Reopen your original workspace and select that file under **Returned proposal file** for its invitation. Inspect the review and explicitly approve or reject it. Independent edits merge; conflicts block approval without partially changing the workspace.

Create one invitation per friend and a fresh invitation for each subsequent round. Only one proposal can be approved per invitation. Generating a file is not proof it was delivered; neither download nor file transfer automatically synchronizes either workspace.

File invitations have **no expiry or remote revocation**. Anyone holding the snapshot and its secret can retain access permanently. A file-transfer provider can observe filenames, sizes, timing and ciphertext; do not put the secret beside the file. The app itself performs no network transfer for this workflow. Snapshots are capped at 64 MiB (plus a small public file header) and assembled in memory, so this is not a large-folder transfer service. Keep backups of important work; original owner review receipts are not included in ordinary dataset backups.

## S3 invitations

1. The owner opens **Share workspace → New 24-hour invitation**, enters an invitation label and scoped S3 credentials, then explicitly chooses **Encrypt, upload & create invitation**.
2. The storage worker creates an independently encrypted snapshot using the existing authenticated, chunked backup format. Only ciphertext reaches the network client. Original local files and the owner's workspace are unchanged.
3. The app signs fixed-object GET and create-only PUT URLs locally with AWS Signature V4 using `aws4fetch`. S3 validates these signatures; there is no URL-generation backend. Credentials never leave memory or appear in the invitation. An access-key identifier and any temporary session token do appear in signed URLs, as required by S3.
4. The owner sends the app invitation privately. It contains a snapshot GET URL, a proposal PUT URL and a random 256-bit decryption secret, all inside `#share=…`. The app removes that fragment before rendering. The secret is never sent to S3.
5. The recipient explicitly downloads the snapshot and creates a password-protected local working copy. Every object and mask is authenticated and validated; images and the sharing receipt publish together only after complete verification. The recipient can edit offline and reopen their saved copy.
6. **Share workspace → Submit changes for approval** sends an encrypted annotation proposal, not images. Its author name is self-reported. The owner can be offline while it is uploaded.
7. The owner opens their original workspace, chooses **Check for proposal**, inspects the per-image counts and before/proposed annotation data, then chooses **Approve proposal** or **Reject proposal**. Incoming data never updates annotations automatically.

Create one invitation per contributor. Both PUT capabilities sign `If-None-Match: *`: the snapshot and the single proposal cannot be overwritten through those URLs. A holder of the invitation can consume its proposal slot; an invitation is a bearer capability, not verified personal identity.

## Scope and conflict behavior

- Contributors propose boxes, polygons, lines, labels, keypoints, attributes, visibility/locking and review state on the original images.
- Media, image additions/removals, schema changes and mask edits cannot be proposed. Local copies may still use those tools, but incompatible original-image/schema/mask edits are rejected on submission. New local images are not submitted.
- The owner stores the original shared documents in an encrypted receipt. Proposed bases must match that receipt exactly. Duplicate images, substituted bases, invalid domain state and proposals from another invitation are refused.
- A three-way merge preserves independent owner edits. Different edits to the same annotation, edit/delete races and conflicting review-state changes block the whole proposal. Identical already-applied changes are idempotent.
- Approval rechecks current documents, then commits all changed encrypted records and the decision in one SQLite transaction. A failed or conflicting approval changes nothing. Rejection records only the decision. Replayed decisions/proposals cannot apply twice.
- Unchanged masks remain compatible across local import and data-key rotation: encrypted receipts hold pixel-based digests independent of rebound tile IDs. Mask edits are still refused.
- The owner must be online to check and approve. No presence, automatic polling, cloud conflict resolver, CRDT/offline replica sync or shared remote authority is introduced. The contributor sees “submitted”; approval/rejection is recorded on the owner's device, not pushed back to the contributor.

## S3 deployment

Only exact, explicitly configured HTTPS storage origins are allowed. The default build enables no external S3 origin (the separate BYOK AI and loopback policies do not enable storage access). For example:

```sh
VITE_S3_ORIGINS=https://s3.us-east-1.amazonaws.com npm run build
```

Use the same environment setting when serving with Vite preview so response CSP agrees with the HTML CSP. With the included GitHub Pages workflow, set the repository Actions variable `VITE_S3_ORIGINS` before rebuilding. A comma-separated list enables multiple exact origins; wildcards, paths and HTTP origins are rejected. Apply the matching `connect-src` policy on custom hosts. Opening an invitation never bypasses this allowlist.

The endpoint is the path-style S3 API endpoint, not a public bucket website:

- AWS: `https://s3.us-east-1.amazonaws.com`, region `us-east-1`, bucket entered separately.
- R2: `https://ACCOUNT_ID.r2.cloudflarestorage.com`, region `auto`, bucket entered separately.
- Other providers must support S3 Signature V4 query signing, HTTPS, GET/PUT, conditional `If-None-Match: *` writes and browser CORS. Provider compatibility must be verified against an actual bucket before production use.

Give the signing principal only `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::YOUR_BUCKET/annotator-shares/*`. Never use a root account key, make the bucket public, or bundle credentials in the app. Temporary credentials are preferred; URLs stop working when those credentials expire, even if the advertised 24-hour window has not elapsed.

Example bucket CORS:

```json
[
  {
    "AllowedOrigins": ["https://YOUR_APP_ORIGIN"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["if-none-match", "content-type"],
    "ExposeHeaders": ["Content-Length"],
    "MaxAgeSeconds": 300
  }
]
```

Objects use opaque paths:

```text
annotator-shares/<random-invitation-uuid>/snapshot.enc
annotator-shares/<random-invitation-uuid>/proposal.enc
```

Signed URL expiry does not delete objects. Configure bucket lifecycle cleanup for this prefix, with a retention period appropriate to your review window. Review/download capabilities also expire after 24 hours. After expiry, the owner can retrieve retained encrypted objects through their bucket administration tools, but this UI does not renew old capabilities; use fresh invitations for subsequent rounds.

## Limits, recovery and privacy

- Snapshot uploads/downloads are bounded to 64 MiB and assembled in memory. Snapshot image processing is stepped one image at a time; this is not a streaming or large-dataset cloud-sync implementation.
- Sharing receipts and proposal plaintext have an 8 MiB limit. Each workspace retains up to 100 invitations; each invitation permits one submitted proposal. There is no automatic retry of uploads with an uncertain outcome.
- If a submission times out after S3 accepted it, a retry can report that the slot is already used. Keep the local copy and ask the owner to check it rather than assuming the upload failed.
- Receipts (including URL capabilities, secrets, original documents and decisions) are encrypted under the local vault root and survive exit, lock, reload and root-key rotation. They are not included in ordinary dataset backup/restore. Losing the owner's browser workspace also loses its in-app review receipts. An unsuccessful import may leave an empty named workspace, but never partially published images.
- Original source files are never uploaded. Sanitized image pixels can still identify people or proprietary material. Recipients can retain plaintext, screenshots and decrypted copies.
- S3 sees opaque paths, sizes, timing, IPs and signed-URL credential metadata. The app origin, scripts, extensions, clipboard tools and anyone holding an invitation can access the capability. Expiry, rejection, local deletion or local key rotation cannot revoke a downloaded snapshot.
- This builds on the existing backup cryptography; it is not independently audited. Unit and Chromium tests include a signature-verifying in-process S3 test double, not certification against AWS, R2 or a production network.

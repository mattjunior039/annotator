import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { StorageClient } from '../workers/client';
import { archiveFinishedSchema, archiveProgressSchema } from '../workers/protocol';
import { proposalPreviewSchema, shareSummariesSchema } from '../sharing/model';
import type { ProposalPreview, ShareSummary } from '../sharing/model';
import { createS3Capabilities, downloadEncrypted, shareLink, uploadEncrypted } from '../sharing/s3';
import type { S3Settings } from '../sharing/s3';

const exportStartSchema = archiveProgressSchema.extend({ id: z.uuid(), key: z.string() });
const exportFinishedSchema = archiveFinishedSchema.extend({ media: z.instanceof(ArrayBuffer) });
const proposalOutputSchema = z.strictObject({ media: z.instanceof(ArrayBuffer), count: z.number() });
const emptySettings: S3Settings = { endpoint: '', bucket: '', region: 'us-east-1', accessKeyId: '', secretAccessKey: '', sessionToken: '' };

export function SharePanel({ storage, workspaceName, busy, run, onUpdated, onClose }: {
  storage: StorageClient; workspaceName: string; busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  onUpdated: () => Promise<void>; onClose: () => void;
}) {
  const [settings, setSettings] = useState(emptySettings);
  const [recipient, setRecipient] = useState('');
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [author, setAuthor] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  async function refresh() { setShares(await storage.request({ type: 'share-list' }, shareSummariesSchema)); }
  useEffect(() => {
    const timer = setTimeout(() => { void run(refresh); }, 0);
    return () => clearTimeout(timer);
  }, [storage]);

  async function publish() {
    const credentials = settings;
    setSettings(previous => ({ ...previous, accessKeyId: '', secretAccessKey: '', sessionToken: '' }));
    setNotice(''); setProgress('Preparing encrypted snapshot...');
    let session: string | undefined;
    try {
      const start = await storage.request({ type: 'share-export-start' }, exportStartSchema);
      session = start.session;
      const capabilities = await createS3Capabilities(credentials, start.id);
      for (let index = 0; index < start.count; index++) {
        setProgress(`Encrypting image ${index + 1} of ${start.count}`);
        await storage.request({ type: 'archive-step', session, index }, archiveProgressSchema);
      }
      const snapshot = await storage.request({ type: 'archive-finish', session }, exportFinishedSchema);
      session = undefined;
      setProgress(`Uploading ${(snapshot.media.byteLength / 1024 / 1024).toFixed(1)} MiB of ciphertext...`);
      await uploadEncrypted(capabilities.snapshotPut, snapshot.media);
      await storage.request({ type: 'share-publish', name: recipient,
        invitation: { version: 1, id: start.id, key: start.key, download: capabilities.download, upload: capabilities.upload, expires: capabilities.expires },
        reviewUrl: capabilities.reviewUrl,
      }, archiveFinishedSchema);
      await refresh();
      setNotice('Encrypted snapshot uploaded. Copy the invitation below and send it privately. Your workspace is unchanged.');
    } finally {
      if (session && !storage.isClosed) await storage.request({ type: 'archive-cancel', session }, archiveFinishedSchema);
      setProgress('');
    }
  }
  async function submit(share: ShareSummary) {
    setNotice('');
    const proposal = await storage.request({ type: 'share-proposal', id: share.invitation.id, author, message }, proposalOutputSchema);
    await uploadEncrypted(share.invitation.upload, proposal.media);
    await storage.request({ type: 'share-submitted', id: share.invitation.id }, archiveFinishedSchema);
    await refresh();
    setNotice(`Submitted changes to ${proposal.count} images. The owner's workspace changes only after approval.`);
  }
  async function review(share: ShareSummary) {
    setPreview(null); setNotice('');
    const media = await downloadEncrypted(share.reviewUrl, 8 * 1024 * 1024 + 16_384);
    if (!media) { setNotice('No proposal has been submitted for this invitation yet.'); return; }
    setPreview(await storage.request({ type: 'share-review', id: share.invitation.id, media }, proposalPreviewSchema, [media]));
  }
  async function decide(approve: boolean) {
    if (!preview) return;
    await storage.request({ type: 'share-decide', token: preview.token, approve }, archiveFinishedSchema);
    setPreview(null); await refresh();
    if (approve) await onUpdated();
    setNotice(approve ? 'Proposal approved and saved atomically to this workspace.' : 'Proposal rejected. No annotations were changed.');
  }

  return <section className="workspace-card persistent-share" aria-label="Workspace sharing">
    <div className="dashboard-heading"><h2>Share workspace</h2>
      <button type="button" className="text-button" disabled={busy} onClick={onClose}>Close sharing</button></div>
    <p>Share an encrypted snapshot of <strong>{workspaceName}</strong>. Recipients edit a local copy, even while you are offline, then submit annotations for your approval.</p>
    <p>Each invitation permits one proposal within 24 hours. Images, masks and class/schema changes cannot be proposed. Names are self-reported, not verified identities.</p>
    <details>
      <summary>New 24-hour invitation</summary>
      <form className="share-form" onSubmit={event => { event.preventDefault(); void run(publish); }}>
        <p>This uploads the entire dataset, including filenames, images, masks and annotations, encrypted before leaving the storage worker. S3 sees object sizes, timing and IP addresses. The link contains a decryption secret; anyone holding it can download and submit a proposal.</p>
        <label>Invitation label<input required maxLength={100} disabled={busy} value={recipient}
          placeholder="e.g. Riley's review" onChange={event => setRecipient(event.target.value)} /></label>
        {([
          ['endpoint', 'S3 endpoint', 'url'], ['bucket', 'S3 bucket', 'text'], ['region', 'S3 region', 'text'],
          ['accessKeyId', 'S3 access key ID', 'password'], ['secretAccessKey', 'S3 secret access key', 'password'],
          ['sessionToken', 'S3 session token (optional)', 'password'],
        ] as const).map(([key, label, type]) => <label key={key}>{label}<input type={type} required={key !== 'sessionToken'}
          autoComplete="off" disabled={busy} value={settings[key]} onChange={event => setSettings(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
        <p>Use scoped credentials for GetObject and PutObject under <code>annotator-shares/*</code> only. Credentials are used in memory to sign links and are never included in invitations or stored. Temporary credentials can expire before 24 hours.</p>
        <p>Your deployment must allow the exact storage origin through <code>VITE_S3_ORIGINS</code>, and the bucket must allow this app's origin through CORS.</p>
        <button type="submit" className="continue-button" disabled={busy}>Encrypt, upload & create invitation</button>
      </form>
    </details>
    {progress && <p role="status">{progress}</p>}
    {notice && <p role="status">{notice}</p>}
    <ul className="share-invitations">
      {shares.map(share => <li key={share.invitation.id}>
        <h3>{share.name}</h3>
        <p>{share.role === 'owner' ? 'Sent invitation' : 'Local working copy'} · {share.status} · expires {new Date(share.invitation.expires).toLocaleString()}</p>
        {share.role === 'owner' ? <>
          {share.status === 'open' && <>
            <label>Workspace invitation<input readOnly value={shareLink(share.invitation)} onFocus={event => event.currentTarget.select()} /></label>
            <div className="live-actions">
              <button type="button" disabled={busy} onClick={() => void run(async () => {
                await navigator.clipboard.writeText(shareLink(share.invitation)); setNotice('Invitation copied. Share it only through a private channel.');
              })}>Copy invitation</button>
              <button type="button" disabled={busy} onClick={() => void run(() => review(share))}>Check for proposal</button>
            </div>
          </>}
        </> : share.status === 'open' ? <form className="share-form" onSubmit={event => { event.preventDefault(); void run(() => submit(share)); }}>
          <label>Proposal author<input required maxLength={100} disabled={busy} value={author} onChange={event => setAuthor(event.target.value)} /></label>
          <label>Proposal summary<textarea required maxLength={2000} disabled={busy} value={message} onChange={event => setMessage(event.target.value)} /></label>
          <p>Only annotation and review-state edits to the original images are submitted. Keep your local copy; the invitation's upload permission expires after 24 hours.</p>
          <button type="submit" disabled={busy}>Submit changes for approval</button>
        </form> : <p>Your local edits remain saved here. A new invitation is needed for another proposal.</p>}
      </li>)}
    </ul>
    {preview && <section className="share-review" aria-label="Proposal review">
      <h3>Review proposal from {preview.author}</h3><p>{preview.message}</p>
      <p>The author name is not verified. Approval merges this entire proposal; it never publishes automatically.</p>
      <ul>{preview.images.map(image => <li key={image.id}>{image.name}: {image.added} added, {image.changed} changed, {image.removed} removed{image.reviewChanged ? ', review status changed' : ''}
        <details><summary>Inspect annotation changes</summary>
          {image.reviewChanged && <p>Review: {image.reviewBefore} to {image.reviewAfter}</p>}
          {image.edits.map(edit => <div key={edit.id}><strong>{edit.id}</strong>
            <p>Before</p><pre>{JSON.stringify(edit.before, null, 2)}</pre>
            <p>Proposed</p><pre>{JSON.stringify(edit.after, null, 2)}</pre>
          </div>)}
        </details>
      </li>)}</ul>
      {preview.conflicts.length > 0 && <div role="alert"><strong>Cannot approve: conflicting changes</strong>
        <ul>{preview.conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul>
        <p>No changes have been applied. Reject this proposal and send a fresh snapshot to resolve conflicts.</p></div>}
      <div className="live-actions">
        <button type="button" disabled={busy || preview.conflicts.length > 0} onClick={() => void run(() => decide(true))}>Approve proposal</button>
        <button type="button" disabled={busy} onClick={() => void run(() => decide(false))}>Reject proposal</button>
      </div>
    </section>}
  </section>;
}

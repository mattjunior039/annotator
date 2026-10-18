import { useState } from 'react';
import { WorkerClient } from '../workers/client';
import { archiveFinishedSchema, archiveProgressSchema, statusSchema, workspaceDescriptorSchema } from '../workers/protocol';
import type { WorkspaceDescriptor } from '../workers/protocol';
import { downloadEncrypted, parseShareLink } from '../sharing/s3';

export function ShareImport({ initialLink, onImported, onBusyChange }: {
  initialLink: string; onImported: (descriptor: WorkspaceDescriptor, passphrase: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [link, setLink] = useState(initialLink);
  const [name, setName] = useState('Shared workspace');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  async function importShare() {
    setBusy(true); onBusyChange(true); setError('');
    let client: WorkerClient | undefined, session: string | undefined;
    const secret = passphrase;
    try {
      if (passphrase !== confirmation) throw new Error('Workspace passphrases do not match.');
      const invitation = parseShareLink(link);
      setProgress('Downloading encrypted snapshot...');
      const media = await downloadEncrypted(invitation.download);
      if (!media) throw new Error('The shared snapshot is no longer available. Ask the owner for a new invitation.');
      client = new WorkerClient(new Worker(new URL('../workers/storage.worker.ts', import.meta.url), { type: 'module' }));
      const descriptor = await client.request({ type: 'catalog-create', name, passwordProtected: true, passphrase }, workspaceDescriptorSchema);
      await client.request({ type: 'workspace-open', workspaceId: descriptor.id }, statusSchema);
      await client.request({ type: 'unlock', passphrase }, statusSchema);
      setPassphrase(''); setConfirmation('');
      const start = await client.request({ type: 'share-import-start', invitation, media, name }, archiveProgressSchema, [media]);
      session = start.session;
      for (let index = 0; index < start.count; index++) {
        setProgress(`Verifying and saving image ${index + 1} of ${start.count}`);
        await client.request({ type: 'archive-step', session, index }, archiveProgressSchema);
      }
      await client.request({ type: 'archive-finish', session }, archiveFinishedSchema);
      session = undefined;
      client.close();
      setLink('');
      onImported(descriptor, secret);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to import the shared workspace.');
    } finally {
      if (session && client && !client.isClosed) {
        try { await client.request({ type: 'archive-cancel', session }, archiveFinishedSchema); }
        catch { setError('Import failed and staging cleanup could not complete. Reopen the local working copy to recover before retrying.'); }
      }
      client?.close(); setBusy(false); onBusyChange(false); setProgress('');
    }
  }
  let host = '';
  try { if (link) host = new URL(parseShareLink(link).download).host; } catch { /* Validated again on explicit import. */ }
  return <details className="workspace-card" open={initialLink ? true : undefined}>
    <summary>Open a workspace invitation</summary>
    <form className="share-form" onSubmit={event => { event.preventDefault(); void importShare(); }}>
      <p>Download an encrypted snapshot and create a password-protected local working copy. Your edits remain local until you explicitly submit a proposal for the owner's approval.</p>
      <label>Workspace invitation link<textarea required disabled={busy} value={link} onChange={event => setLink(event.target.value.trim())} autoComplete="off" /></label>
      <label>Local workspace name<input required maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Working copy passphrase<input type="password" required minLength={12} maxLength={1024} disabled={busy}
        autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
      <label>Confirm working copy passphrase<input type="password" required minLength={12} maxLength={1024} disabled={busy}
        autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      <p>{host ? `This contacts ${host}. ` : ''}The owner can be offline. Anyone with the link can decrypt the snapshot. Do not forward it or use it on an untrusted device.</p>
      <button type="submit" className="continue-button" disabled={busy}>Download & create local copy</button>
      {progress && <p role="status">{progress}</p>}
      {error && <p className="error" role="alert">{error} An unsuccessful import may leave an empty local workspace; it can be deleted from the dashboard.</p>}
    </form>
  </details>;
}

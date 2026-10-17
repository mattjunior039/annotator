import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { WorkerClient } from '../workers/client';
import { workspaceCatalogSchema, workspaceDescriptorSchema, workspaceDeleteSchema } from '../workers/protocol';
import type { WorkspaceDescriptor } from '../workers/protocol';
import { Workspace } from './Workspace';
import { FoundationLab } from './FoundationLab';
import { detectCapabilities } from './capabilities';

export function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [active, setActive] = useState<WorkspaceDescriptor | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<WorkspaceDescriptor | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [name, setName] = useState('');
  const [protectedWorkspace, setProtectedWorkspace] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [initialPassphrase, setInitialPassphrase] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [labOpen, setLabOpen] = useState(false);
  const [capabilities] = useState(detectCapabilities);
  const running = useRef(false);
  const canStore = capabilities.filter(item => item.requiredFor === 'vault').every(item => item.available);

  async function catalog(action: (client: WorkerClient) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    let client: WorkerClient | undefined;
    try {
      client = new WorkerClient(new Worker(new URL('../workers/storage.worker.ts', import.meta.url), { type: 'module' }));
      await action(client);
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to open the local workspace catalog.'); }
    finally { client?.close(); running.current = false; setBusy(false); }
  }
  async function refresh() {
    await catalog(async client => setWorkspaces(await client.request({ type: 'catalog-list' }, workspaceCatalogSchema)));
  }
  useEffect(() => {
    if (!canStore) { setBusy(false); return; }
    if (!active && !labOpen) void refresh();
  }, [active, labOpen]);
  useEffect(() => {
    if (!canStore || active || labOpen || creating || deleting) return;
    const refreshOnFocus = () => { void refresh(); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [active, labOpen, creating, deleting]);

  function resetForm() {
    setName(''); setProtectedWorkspace(false); setPassphrase(''); setConfirmation(''); setError('');
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = passphrase;
    setPassphrase(''); setConfirmation('');
    await catalog(async client => {
      if (protectedWorkspace && secret !== confirmation) throw new Error('Workspace passphrases do not match. Enter them again.');
      const descriptor = await client.request({
        type: 'catalog-create', name, passwordProtected: protectedWorkspace, passphrase: protectedWorkspace ? secret : '',
      }, workspaceDescriptorSchema);
      setInitialPassphrase(protectedWorkspace ? secret : '');
      setCreating(false); resetForm(); setActive(descriptor);
    });
  }

  return <div className={`app ${active ? 'workspace-mode' : 'dashboard-mode'}`}>
    <header className="topbar">
      <span className="brand">annotator<span className="brand-mark">.</span></span>
      <span className="badge">PRIVATE · LOCAL</span>
    </header>
    <main>
      {active ? <Workspace key={active.id} descriptor={active} initialTool="box"
        initialPassphrase={initialPassphrase} onPassphraseConsumed={() => setInitialPassphrase('')}
        onBack={() => { setInitialPassphrase(''); setBusy(true); setActive(null); setError(''); }} /> : <section className="workspace-dashboard">
        <div className="dashboard-heading">
          <div><h1>Workspaces</h1><p>Separate datasets. One place to organize and annotate.</p></div>
          <button type="button" className="tool-button primary-action" disabled={busy || labOpen || !canStore}
            onClick={() => { resetForm(); setDeleting(null); setCreating(true); }}>New workspace</button>
        </div>
        {!canStore && <p className="error" role="alert">Local workspaces require desktop Chromium with OPFS, Web Crypto, and Web Locks enabled.</p>}
        {creating && <form className="workspace-create workspace-card" onSubmit={event => void create(event)}>
          <h2>Create workspace</h2>
          <label htmlFor="workspace-name">Workspace name</label>
          <input id="workspace-name" autoFocus required maxLength={100} value={name} disabled={busy}
            onChange={event => setName(event.target.value)} placeholder="e.g. Pill detection" />
          <label className="protection-choice"><input type="checkbox" checked={protectedWorkspace} disabled={busy}
            onChange={event => { setProtectedWorkspace(event.target.checked); setPassphrase(''); setConfirmation(''); }} />
            Password protect this workspace</label>
          <p>{protectedWorkspace
            ? 'Images and annotations are encrypted with a passphrase-protected key. You will need the passphrase each time you open this workspace. There is no server password reset; optionally create a recovery file after opening.'
            : 'Opens without a password on this browser profile. Anyone with access to this profile can open the data. The local encryption key is stored on this device; this is not password-protected storage.'}</p>
          <p className="privacy-note">Workspace names are visible on this dashboard, even when protected. Do not put sensitive information in the name.</p>
          {protectedWorkspace && <>
            <label htmlFor="new-workspace-passphrase">Workspace passphrase</label>
            <input id="new-workspace-passphrase" type="password" autoComplete="new-password" minLength={12} maxLength={1024}
              required disabled={busy} value={passphrase} onChange={event => setPassphrase(event.target.value)} />
            <label htmlFor="confirm-workspace-passphrase">Confirm workspace passphrase</label>
            <input id="confirm-workspace-passphrase" type="password" autoComplete="new-password" minLength={12} maxLength={1024}
              required disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
          </>}
          <div className="dialog-actions">
            <button type="button" className="tool-button" disabled={busy} onClick={() => { setCreating(false); resetForm(); }}>Cancel</button>
            <button type="submit" className="tool-button primary-action" disabled={busy || !name.trim()}>Create workspace</button>
          </div>
        </form>}
        {deleting && <form className="workspace-create workspace-card" onSubmit={event => {
          event.preventDefault();
          void catalog(async client => {
            await client.request({ type: 'catalog-delete', workspaceId: deleting.id, confirmation: deleteConfirmation }, workspaceDeleteSchema);
            setDeleting(null); setDeleteConfirmation('');
            setWorkspaces(await client.request({ type: 'catalog-list' }, workspaceCatalogSchema));
          });
        }}>
          <h2>Delete {deleting.name}</h2>
          <p>This permanently removes this workspace's local images, annotations, keys, and recovery wrapper. Original folders, exported files, encrypted backups, and other workspaces are not removed. Browser deletion does not guarantee forensic erasure of disk remnants.</p>
          <label htmlFor="delete-workspace-confirmation">Type the workspace name to delete</label>
          <input id="delete-workspace-confirmation" autoFocus required value={deleteConfirmation} disabled={busy}
            onChange={event => setDeleteConfirmation(event.target.value)} />
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => { setDeleting(null); setDeleteConfirmation(''); }}>Cancel</button>
            <button type="submit" disabled={busy || deleteConfirmation !== deleting.name}>Permanently delete workspace</button>
          </div>
        </form>}
        {error && <div className="error" role="alert">{error}
          <button type="button" className="text-button" disabled={busy || labOpen} onClick={() => void refresh()}>Retry</button>
        </div>}
        {busy && <p role="status">Opening local storage...</p>}
        {!creating && !busy && !error && workspaces.length === 0 && <div className="workspace-empty">
          <h2>A workspace for each dataset</h2>
          <p>Create a workspace, then add a folder or images. Your originals stay unchanged.</p>
          <ol className="workflow-preview">
            <li><span className="step-number" aria-hidden="true">1</span><div><strong>Create a workspace</strong><small>Keep each dataset and its settings together.</small></div></li>
            <li><span className="step-number" aria-hidden="true">2</span><div><strong>Add images or a folder</strong><small>Bring in a dataset without changing your originals.</small></div></li>
            <li><span className="step-number" aria-hidden="true">3</span><div><strong>Annotate, then export</strong><small>Use boxes, polygons, keypoints, masks, or image labels.</small></div></li>
          </ol>
        </div>}
        <div className="workspace-grid" aria-label="Your workspaces">
          {workspaces.map(item => <div className="workspace-entry" key={item.id}><button className="workspace-tile" type="button" disabled={busy || labOpen || item.deleting}
            onClick={() => { setCreating(false); setDeleting(null); resetForm(); setActive(item); }}>
            <span className="workspace-tile-name">{item.name}</span>
            <span>{item.passwordProtected ? 'Password protected' : 'No password · this device'}</span>
            {item.deleting && <span>Deletion incomplete — retry Delete</span>}
            <span className="workspace-tile-action">Open workspace →</span>
          </button><button type="button" className="text-button" disabled={busy || labOpen} aria-label={`Delete workspace ${item.name}`}
            onClick={() => { setCreating(false); setDeleting(item); setDeleteConfirmation(''); setError(''); }}>Delete</button></div>)}
        </div>
        <p className="privacy-note">Stored in this browser, not an account or cloud. Keep encrypted backups of important work.</p>
        {!creating && <details className="developer-tools" onToggle={event => {
          if (event.currentTarget.open && busy) { event.currentTarget.open = false; return; }
          if (event.currentTarget.open) setError('');
          if (!event.currentTarget.open) setBusy(true);
          setLabOpen(event.currentTarget.open);
        }}>
          <summary>Developer tools</summary>
          {labOpen && <FoundationLab />}
        </details>}
      </section>}
    </main>
  </div>;
}

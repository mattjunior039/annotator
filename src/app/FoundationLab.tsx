import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { detectCapabilities } from './capabilities';
import { WorkerClient } from '../workers/client';
import { mediaResultSchema, readSchema, savedSchema, statusSchema } from '../workers/protocol';
import type { VaultStatus } from '../workers/protocol';
import { z } from 'zod';
export function FoundationLab() {
  const [capabilities] = useState(detectCapabilities);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('Open the isolated proof vault to verify local persistence.');
  const [image, setImage] = useState<{ result: { png: ArrayBuffer; outputBytes: number; width?: number; height?: number }; name: string } | null>(null);
  const [preview, setPreview] = useState('');
  const [readNote, setReadNote] = useState('');
  const storage = useRef<WorkerClient | null>(null), media = useRef<WorkerClient | null>(null);
  const working = useRef(false), form = useRef<HTMLFormElement>(null);
  const canVault = capabilities.filter(c => c.requiredFor === 'vault').every(c => c.available);
  const canMedia = capabilities.filter(c => c.requiredFor === 'media').every(c => c.available) && typeof Worker !== 'undefined';

  useEffect(() => () => { storage.current?.close(); media.current?.close(); }, []);
  useEffect(() => {
    if (!image) { setPreview(''); return; }
    const url = URL.createObjectURL(new Blob([image.result.png], { type: 'image/png' }));
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  async function perform(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The operation failed.'); }
    finally {
      if (media.current?.isClosed) media.current = null;
      working.current = false; setBusy(false);
    }
  }
  async function refreshStatus() {
    if (!storage.current) throw new Error('Open the proof vault first.');
    setStatus(await storage.current.request({ type: 'status' }, statusSchema));
  }
  function lock() {
    storage.current?.close(); storage.current = null;
    media.current?.close(); media.current = null;
    setStatus(null); setImage(null); setReadNote(''); setError('');
    form.current?.reset();
    setMessage('Locked. Workers terminated and app key references discarded. JavaScript cannot guarantee memory erasure.');
  }
  async function openVault() {
    storage.current?.close();
    storage.current = new WorkerClient(new Worker(new URL('../workers/storage.worker.ts', import.meta.url), { type: 'module' }));
    try { await refreshStatus(); }
    catch (failure) {
      storage.current.close();
      storage.current = null;
      setStatus(null);
      throw failure;
    }
    setMessage('SQLite/OPFS opened. This proof is limited to 100 records, not a dataset workspace.');
  }
  function submitPassphrase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const passphrase = new FormData(event.currentTarget).get('passphrase');
    event.currentTarget.reset();
    void perform(async () => {
      if (typeof passphrase !== 'string' || !storage.current || !status) throw new Error('Open the proof vault first.');
      const start = performance.now();
      const result = await storage.current.request({ type: status.exists ? 'unlock' : 'create', passphrase }, statusSchema);
      setStatus(result);
      setMessage(`Proof vault unlocked. PBKDF2/key operation: ${Math.round(performance.now() - start)} ms. Recovered incomplete objects: ${result.recovered}.`);
    });
  }
  function saveProof(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = new FormData(event.currentTarget).get('note');
    void perform(async () => {
      if (!storage.current || !status?.unlocked || typeof note !== 'string') throw new Error('Unlock the proof vault first.');
      const bytes = image ? image.result.png.slice(0) : null;
      const result = await storage.current.request(
        { type: 'save', note, name: image?.name ?? 'note-only-proof', media: bytes },
        savedSchema, bytes ? [bytes] : [],
      );
      await refreshStatus();
      setMessage(`Saved on this device. Commit acknowledged in ${Math.round(result.milliseconds)} ms; ${result.mediaBytes} sanitized media bytes.`);
    });
  }
  async function readProof(id: string) {
    if (!storage.current) throw new Error('Open the proof vault first.');
    const result = await storage.current.request({ type: 'read', id }, readSchema);
    setReadNote(result.note);
    if (result.media) {
      setImage({ name: result.name, result: { png: result.media, outputBytes: result.media.byteLength } });
    } else setImage(null);
    setMessage('Decrypted proof record read from SQLite and OPFS. No external request was made.');
  }
  function sanitizeFile(file: File | undefined) {
    if (!file) return;
    setImage(null);
    void perform(async () => {
      media.current ??= new WorkerClient(new Worker(new URL('../workers/media.worker.ts', import.meta.url), { type: 'module' }));
      const result = await media.current.request({ type: 'sanitize', file }, mediaResultSchema);
      setImage({ name: file.name.slice(0, 256), result });
      setMessage(`Photo checked locally: ${result.width} × ${result.height}. Maximum rendered-pixel difference: ${result.maxPixelDifference}. No file was sent.`);
    });
  }
  return <>
      <section className="proof-lab">
        <div className="proof-content">
          <div className="proof-intro">
            <h2>Phase 1 foundation lab</h2>
            <p>These are isolated Phase 1 storage and media proofs. Use synthetic data only. Live collaboration, cloud sync, and AI are not implemented.</p>
          </div>
        <section className="card" aria-labelledby="capabilities-title">
          <div className="section-heading"><div><p className="eyebrow">01 / BROWSER</p><h2 id="capabilities-title">Capability checks</h2></div>
            <span className="pill">{canVault && canMedia ? 'Proofs available' : 'Limited support'}</span></div>
          <p>Desktop Chromium is the primary target. API availability is not a durability guarantee; the vault proof tests real storage.</p>
          <dl className="capability-grid">{capabilities.map(c => <div key={c.name}>
            <dt><span className={c.available ? 'available' : 'unavailable'}>{c.available ? 'Available' : 'Unavailable'}</span> {c.name}</dt>
            <dd>{c.detail}</dd>
          </div>)}</dl>
        </section>
        <section className="card" aria-labelledby="vault-title">
          <div className="section-heading"><div><p className="eyebrow">02 / PERSISTENCE</p><h2 id="vault-title">Encrypted storage proof</h2></div>
            <span className="pill">{status?.unlocked ? 'Unlocked in memory' : 'Keys not loaded'}</span></div>
          <p>AES-256-GCM objects, a passphrase-wrapped root key, and ciphertext-only SQLite records.
            Original files remain untouched. This is not whole-file database encryption.</p>
          <div className="actions">
            <button disabled={busy || !canVault || !!status} onClick={() => void perform(openVault)}>Open proof vault</button>
            <button className="secondary" disabled={busy || !storage.current} onClick={lock}>Lock and clear memory</button>
          </div>
          {status && <p className="technical">SQLite {status.sqlite} / {status.vfs} / {status.ids.length} committed records / {status.recovered} recovered incomplete objects</p>}
          {status && !status.unlocked && <form className="inline-form" onSubmit={submitPassphrase}>
            <label>Passphrase <input name="passphrase" type="password" minLength={12} maxLength={1024} required autoComplete="off" /></label>
            <button disabled={busy}>{status.exists ? 'Unlock proof vault' : 'Create proof vault'}</button>
            <p>No reset service. Use a disposable test passphrase of at least 12 characters.</p>
          </form>}
          {status?.unlocked && <>
            <form ref={form} onSubmit={saveProof}>
              <label>Proof note <textarea name="note" maxLength={4096} placeholder="A synthetic annotation or test canary" /></label>
              <button disabled={busy}>Save encrypted proof</button>
            </form>
            <div className="actions">
              <button className="secondary" disabled={busy} onClick={() => void perform(async () => {
                if (!storage.current) throw new Error('Open the proof vault first.');
                await storage.current.request({ type: 'interrupt' }, z.unknown());
              })}>Interrupt synthetic write before commit</button>
            </div>
            <p className="technical">The interruption leaves an encrypted orphan. Lock, reopen, and unlock to verify recovery; committed records must remain intact.</p>
            <div className="record-list" aria-label="Committed proof records">{status.ids.map((id, i) =>
              <button key={id} className="secondary" disabled={busy} onClick={() => void perform(() => readProof(id))}>Read proof {status.ids.length - i}</button>)}</div>
            {readNote && <div className="decrypted"><h3>Decrypted note</h3><p data-testid="decrypted-note">{readNote}</p></div>}
          </>}
        </section>
        <section className="card" aria-labelledby="media-title">
          <div className="section-heading"><div><p className="eyebrow">03 / MEDIA WORKER</p><h2 id="media-title">Sanitization & fidelity proof</h2></div></div>
          <p>Decode a still JPEG, PNG, or WebP locally, apply EXIF orientation, and encode a fresh lossless sRGB PNG.
            Verify output chunks and compare rendered pixels before it can be saved.</p>
          <p className="technical">Proof limits: 4 megapixels and 8 MiB per input/output; one operation at a time. ICC-profiled, 16-bit, and animated images are explicitly rejected pending certification.
            Browser rendering is not an archival or diagnostic-medical pixel-fidelity guarantee.</p>
          <label>Choose a photo
            <input type="file" aria-label="Choose a photo" accept="image/jpeg,image/png,image/webp"
              disabled={busy || !canMedia} onChange={event => { sanitizeFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
          </label>
          {preview && <figure><img src={preview} alt="Sanitized proof preview" /></figure>}
        </section>
        <section className="card boundary" aria-labelledby="boundaries-title">
          <p className="eyebrow">HONEST BOUNDARIES</p><h2 id="boundaries-title">Local is not a mathematical air gap.</h2>
          <p>The app loads its own code and SQLite WASM from this origin. No analytics, external fonts, cloud SDKs, or AI services are included.
            CSP allows same-origin connections and is not a complete exfiltration boundary.</p>
          <p>Encryption cannot protect an unlocked session from a compromised browser or OS. Storage sizes, opaque IDs, and activity remain observable.
            OPFS can be cleared or lost; Phase 1 is not a backup system.</p>
        </section>
        {preview && <p className="download"><a href={preview} download="sanitized-proof.png">Download sanitized photo</a> (plaintext)</p>}
        </div>
      {error && <div className="error" role="alert">{error}</div>}
      </section>
      <p className="status-region" aria-live="polite" role="status">{busy ? 'Working locally. Do not close this tab during a save.' : message}</p>
  </>;
}

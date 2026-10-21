import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Annotation, AnnotationDocument } from '../domain/model';
import {
  proposalSchema, snapshotSchema, type Scope,
} from '../../services/bridge/protocol';
import { z } from 'zod';
import { editorConfig, editorConnections } from '../ai/editor-connection';
import type { EditorConnection } from '../ai/editor-connection';

const scopes: Scope[] = ['metadata', 'counts', 'propose'];
const pairResponseSchema = z.strictObject({ bearer: z.string().min(40).max(100), expiresAt: z.number().int() });
const proposalEntrySchema = proposalSchema.extend({ id: z.uuid() });
const bridgeStatusSchema = z.strictObject({
  authorized: z.boolean(),
  approvedDataAvailable: z.boolean(),
  fileVisibility: z.literal('not-observed'),
  expiresAt: z.number().int().nullable(),
  proposals: z.array(proposalEntrySchema).max(20),
  audit: z.array(z.strictObject({
    event: z.enum(['paired', 'cleared', 'proposal', 'review']), at: z.number().int(),
  })).max(100),
});
const snapshotReceiptSchema = z.strictObject({ received: z.literal(true) });
const pairTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

interface BridgePanelProps {
  workspaceId: string;
  document: AnnotationDocument;
  onClose: () => void;
  onApplyProposal: (commands: readonly unknown[], expectedDocumentRevision: number) => Promise<AnnotationDocument>;
}

export function BridgePanel({ workspaceId, document, onClose, onApplyProposal }: BridgePanelProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const bearerRef = useRef('');
  const snapshotRef = useRef<{ wireRevision: number; documentRevision: number; json: string } | null>(null);
  const wireRevision = useRef(0);
  const polling = useRef(false);
  const [editor, setEditor] = useState<EditorConnection>('copilot');
  const [installation, setInstallation] = useState('');
  const bridgeUrl = useRef('http://127.0.0.1:47321');
  let configuration = '', configurationError = '';
  try { configuration = editorConfig(editor, installation, window.location.origin); }
  catch (failure) { configurationError = failure instanceof Error ? failure.message : 'Invalid companion configuration.'; }
  const [token, setToken] = useState('');
  const [scopeSelection, setScopeSelection] = useState<Scope[]>([]);
  const [consent, setConsent] = useState(false);
  const [bearer, setBearer] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [proposals, setProposals] = useState<z.infer<typeof proposalEntrySchema>[]>([]);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (bearerRef.current) void send('/message', { type: 'lock' }, bearerRef.current).catch(() => {});
      dialog.current?.close();
    };
  }, []);
  useEffect(() => { bearerRef.current = bearer; }, [bearer]);

  async function send(path: '/pair' | '/message', value: unknown, authorization?: string): Promise<unknown> {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (authorization) headers.set('Authorization', `Bearer ${authorization}`);
    const response = await fetch(`${bridgeUrl.current}${path}`, {
      method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers, body: JSON.stringify(value),
      signal: AbortSignal.timeout(10_000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The local companion returned an unreadable response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > 256 * 1024) throw new Error('The local companion response exceeded 256 KiB.');
        chunks.push(chunk);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let result: unknown;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('The local companion returned invalid JSON.'); }
    if (!response.ok) {
      const code = result && typeof result === 'object' && 'error' in result &&
        typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
      throw new Error(`Local companion request failed (${code}).`);
    }
    return result;
  }

  function snapshotData(source: AnnotationDocument) {
    const boxes = source.annotations.filter((item): item is Extract<Annotation, { kind: 'box' }> =>
      item.kind === 'box' && item.visible !== false);
    return snapshotSchema.parse({
      revision: 0,
      classes: [...new Set(boxes.map(item => item.classId))],
      images: [{ id: source.image.id, width: source.image.canonical.width, height: source.image.canonical.height }],
      annotations: boxes.map(item => ({
        id: item.id, imageId: source.image.id, classId: item.classId,
        box: [item.x, item.y, item.width, item.height],
        review: source.review === 'reviewed' ? 'accepted' : 'unreviewed',
      })),
    });
  }
  function snapshotFor(source: AnnotationDocument, forceRevision = false) {
    const value = snapshotData(source);
    const json = JSON.stringify({ ...value, revision: 0 });
    if (forceRevision || snapshotRef.current?.json !== json) wireRevision.current++;
    const revision = Math.max(1, wireRevision.current);
    snapshotRef.current = { wireRevision: revision, documentRevision: source.revision, json };
    return { ...value, revision };
  }
  function currentSnapshot() { return snapshotFor(document); }

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    let newBearer = '';
    try {
      const parsed = pairTokenSchema.parse(token.trim());
      if (!consent || !scopeSelection.length) throw new Error('Choose at least one scope and explicitly approve disclosure.');
      const result = pairResponseSchema.parse(await send('/pair', {
        type: 'pair', token: parsed, workspaceId, approved: true, scopes: scopeSelection,
      }));
      newBearer = result.bearer;
      const snapshot = currentSnapshot();
      await send('/message', { type: 'snapshot', snapshot }, result.bearer);
      setBearer(result.bearer);
      bearerRef.current = result.bearer;
      setExpiresAt(result.expiresAt);
      setToken('');
      setConsent(false);
      setNotice('Paired. Only the current image’s visible boxes, dimensions, opaque IDs and counts were disclosed.');
    } catch (failure) {
      if (newBearer) {
        try { await send('/message', { type: 'lock' }, newBearer); }
        catch {
          setError(`${failure instanceof Error ? failure.message : 'Pairing failed.'} The companion did not acknowledge cleanup; its disclosed-data lease expires within 60 seconds.`);
          return;
        }
        snapshotRef.current = null;
        wireRevision.current = 0;
      }
      setError(failure instanceof Error ? failure.message : 'Pairing failed. No annotations were changed.');
    } finally { setBusy(false); }
  }

  async function refresh() {
    const active = bearerRef.current;
    if (!active || polling.current) return;
    polling.current = true;
    try {
      const snapshot = currentSnapshot();
      snapshotReceiptSchema.parse(await send('/message', { type: 'snapshot', snapshot }, active));
      const status = bridgeStatusSchema.parse(await send('/message', { type: 'status' }, active));
      if (!status.authorized) throw new Error('The companion authorization was revoked.');
      setProposals(status.proposals);
      setApproved(previous => Object.fromEntries(Object.keys(previous)
        .filter(id => previous[id] !== undefined && status.proposals.some(proposal => proposal.id === id))
        .map(id => [id, previous[id]!])));
      setExpiresAt(status.expiresAt);
      setNotice(status.approvedDataAvailable
        ? 'Connected · the companion sees only this image’s approved metadata.'
        : 'Connected · waiting for the approved data lease.');
    } finally {
      polling.current = false;
    }
  }

  useEffect(() => {
    if (!bearer) return;
    const timer = window.setInterval(() => {
      void refresh().catch(failure => {
        setError(failure instanceof Error ? failure.message : 'The companion connection failed.');
        setBearer('');
        bearerRef.current = '';
        setProposals([]);
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [bearer, document]);

  async function review(proposal: z.infer<typeof proposalEntrySchema>) {
    setBusy(true);
    setError('');
    try {
      const last = snapshotRef.current;
      const currentData = snapshotData(document);
      if (!last || proposal.baseRevision !== last.wireRevision ||
          last.json !== JSON.stringify({ ...currentData, revision: 0 }) ||
          last.documentRevision !== document.revision ||
          !approved[proposal.id]) throw new Error('This proposal is stale or has not been explicitly approved.');
      const commands = proposal.operations.map(operation => {
        const target = document.annotations.find(item => item.id === operation.annotation.id);
        if (!target || target.kind !== 'box' || target.visible === false || target.locked ||
            target.classId !== operation.annotation.classId || operation.annotation.imageId !== document.image.id) {
          throw new Error('A proposal targets a hidden, locked, changed, or non-box annotation.');
        }
        return {
          type: 'put',
          annotation: {
            ...target,
            x: operation.annotation.box[0], y: operation.annotation.box[1],
            width: operation.annotation.box[2], height: operation.annotation.box[3],
            attributes: { ...target.attributes, bridge_review: operation.annotation.review },
          },
        };
      });
      const updated = await onApplyProposal(commands, last.documentRevision);
      await send('/message', {
        type: 'review', proposalId: proposal.id, baseRevision: proposal.baseRevision, outcome: 'applied',
        snapshot: snapshotFor(updated, true),
      }, bearerRef.current);
      setProposals(previous => previous.filter(item => item.id !== proposal.id));
      setApproved(previous => { const next = { ...previous }; delete next[proposal.id]; return next; });
      setNotice('Proposal applied through the validated editor history and acknowledged.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The proposal was not applied.');
    } finally { setBusy(false); }
  }

  async function revoke() {
    setBusy(true);
    setError('');
    try {
      if (bearerRef.current) await send('/message', { type: 'revoke' }, bearerRef.current);
      setBearer('');
      bearerRef.current = '';
      setExpiresAt(null);
      setProposals([]);
      setNotice('Authorization and disclosed data were revoked.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Revocation was not acknowledged. Data lease expires within 60 seconds.');
    } finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="export-dialog bridge-dialog" aria-label="Local annotation companion"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading">
      <div><h2>Local annotation companion</h2>
        <p>Optional local MCP editor connection · workspace {workspaceId}</p></div>
      <button type="button" className="tool-button" aria-label="Close companion" disabled={busy} onClick={onClose}>×</button>
    </div>
    <p className="export-warning">The companion runs as a separate local process. An external editor may forward disclosed values to its own cloud service. This panel shares only the current image’s visible box annotations: opaque IDs, dimensions, box coordinates, and counts. It never sends labels, filenames, image pixels, masks, paths, or keys.</p>
    <label>AI editor<select value={editor} disabled={busy || !!bearer} onChange={event => {
      const selected = editorConnections.find(item => item.id === event.target.value)!;
      setEditor(selected.id); bridgeUrl.current = `http://127.0.0.1:${selected.port}`;
      setToken(''); setError(''); setNotice('');
    }}>{editorConnections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <details>
      <summary>Set up Copilot or Antigravity</summary>
      <ol>
        <li>Install this app's companion source and dependencies on your computer (Node 22.12+ and npm install). Your editor launches it; the website cannot install or start a local process.</li>
        <li>Enter that installation folder below. It is not your image folder, is not sent to the companion, and is not saved.</li>
        <li>{editor === 'copilot'
          ? 'In VS Code run “MCP: Open User Configuration”, then merge the generated servers entry into that configuration.'
          : 'In Antigravity open MCP Servers → Manage MCP Servers → View raw config, then merge the generated mcpServers entry.'} Preserve your other servers. Start the annotator server in your editor.</li>
        <li>Ask your editor to call <code>bridge_pair</code> with the parameters below. Paste the returned single-use token here within 60 seconds, select scopes, and approve disclosure.</li>
      </ol>
      <label>Companion installation folder<input value={installation} disabled={busy || !!bearer}
        placeholder="/absolute/path/to/annotator" onChange={event => setInstallation(event.target.value)} /></label>
      {configuration ? <pre aria-label="Editor MCP configuration">{configuration}</pre> : <p>{configurationError}</p>}
      <p>Pairing parameters (no secret):</p>
      <pre aria-label="MCP pairing parameters">{JSON.stringify({
        origin: window.location.origin, workspaceId, scopes: ['metadata', 'counts', 'propose'],
      }, null, 2)}</pre>
      <p>Connects to {bridgeUrl.current}. Each editor uses a different port; only the selected editor receives this panel's approval. This is MCP metadata access, not website subscription login or image access. Browser local-network permission may be required; never disable browser security.</p>
      <p><a href="https://code.visualstudio.com/docs/copilot/customization/mcp-servers" target="_blank" rel="noreferrer noopener">Copilot MCP setup</a>
        {' · '}<a href="https://antigravity.google/docs/mcp" target="_blank" rel="noreferrer noopener">Antigravity MCP setup</a></p>
    </details>
    {!bearer ? <form onSubmit={event => void pair(event)}>
      <label>MCP pairing token (entered manually; never stored)
        <input type="password" autoComplete="off" required maxLength={43} value={token} disabled={busy}
          onChange={event => setToken(event.target.value)} />
      </label>
      <fieldset>
        <legend>Requested scopes</legend>
        {scopes.map(scope => <label key={scope} className="protection-choice">
          <input type="checkbox" checked={scopeSelection.includes(scope)} disabled={busy}
            onChange={event => setScopeSelection(previous => event.target.checked
              ? [...previous, scope] : previous.filter(item => item !== scope))} />
          {scope === 'metadata' ? 'View approved box metadata' : scope === 'counts' ? 'Count approved boxes' : 'Propose box edits for review'}
        </label>)}
      </fieldset>
      <label className="protection-choice"><input type="checkbox" checked={consent} disabled={busy}
        onChange={event => setConsent(event.target.checked)} />
        I approve this workspace and the selected scopes for the current image only.</label>
      <div className="dialog-actions">
        <button type="button" className="tool-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="tool-button primary-action" disabled={busy || !consent || !scopeSelection.length}>
          Approve and pair
        </button>
      </div>
    </form> : <>
      <p role="status">{notice} {expiresAt ? `Authorization expires ${new Date(expiresAt).toLocaleTimeString()}.` : ''}</p>
      <p>Actual file visibility: not observed. Approved data is refreshed every 15 seconds and expires after 60 seconds without refresh.</p>
      {proposals.length > 0 && <section aria-label="Proposed edits">
        <h3>Proposals awaiting your review</h3>
        {proposals.map(proposal => <article key={proposal.id}>
          <p>{proposal.operations.length} existing box edit(s), base revision {proposal.baseRevision}</p>
          <ul>{proposal.operations.map(operation => <li key={operation.annotation.id}>
            Annotation {operation.annotation.id}: {operation.annotation.box.join(', ')} · {operation.annotation.review}
          </li>)}</ul>
          <label className="protection-choice"><input type="checkbox" checked={!!approved[proposal.id]} disabled={busy}
            onChange={event => setApproved(previous => ({ ...previous, [proposal.id]: event.target.checked }))} />
            I reviewed and approve this proposal. It will update the current image atomically and can be undone.</label>
          <button type="button" className="tool-button primary-action"
            disabled={busy || !approved[proposal.id]} onClick={() => void review(proposal)}>Apply approved proposal</button>
        </article>)}
      </section>}
      <div className="dialog-actions">
        <button type="button" className="tool-button" disabled={busy} onClick={() => {
          void refresh().catch(failure => setError(failure instanceof Error ? failure.message : 'The companion connection failed.'));
        }}>Refresh now</button>
        <button type="button" className="tool-button" disabled={busy} onClick={() => void revoke()}>Revoke and clear</button>
      </div>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </dialog>;
}

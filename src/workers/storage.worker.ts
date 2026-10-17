import { VaultStore } from '../storage/vault-store';
import { requestEnvelopeSchema, storageRequestSchema } from './protocol';

let store: Promise<VaultStore> | undefined;
let selectedWorkspace: string | undefined;
let busy = false;
let releaseLease: (() => void) | undefined;
async function openExclusive(workspaceId?: string): Promise<VaultStore> {
  return new Promise((resolve, reject) => {
    const name = !workspaceId || workspaceId === 'legacy' ? 'annotator-phase1-writer' : `annotator-workspace-${workspaceId}`;
    navigator.locks.request(name, { ifAvailable: true }, async lock => {
      if (!lock) {
        reject(new Error('Local workspace is already open in another tab or window. Only this dataset is locked. Exit it in the other tab, then retry here, or return to Workspaces to open a different dataset. Saved data has not been changed.'));
        return;
      }
      const lease = new Promise<void>(release => { releaseLease = release; });
      try { resolve(await (workspaceId ? VaultStore.openSelected(workspaceId) : VaultStore.open())); }
      catch (error) { releaseLease?.(); reject(error); }
      await lease;
    }).catch(reject);
  });
}
self.onmessage = async (event: MessageEvent<unknown>) => {
  const envelope = requestEnvelopeSchema.safeParse(event.data);
  if (!envelope.success) {
    self.postMessage({ version: 1, id: 0, ok: false, error: 'Invalid storage protocol request.' }); return;
  }
  const { id, payload } = envelope.data;
  if (busy) {
    self.postMessage({ version: 1, id, ok: false, error: 'Storage worker is busy.' }); return;
  }
  busy = true;
  try {
    const request = storageRequestSchema.parse(payload);
    if (request.type === 'catalog-list' || request.type === 'catalog-create' || request.type === 'catalog-delete') {
      if (store) throw new Error('Workspace must be exited before changing the workspace catalog.');
      const value = await VaultStore.handleCatalog(request);
      self.postMessage({ version: 1, id, ok: true, value });
      return;
    }
    if (request.type === 'workspace-open' && store && selectedWorkspace !== request.workspaceId) {
      throw new Error('Workspace is already selected. Exit before opening another workspace.');
    }
    if (!store) selectedWorkspace = request.type === 'workspace-open' ? request.workspaceId : undefined;
    store ??= openExclusive(selectedWorkspace).catch(error => {
      store = undefined;
      selectedWorkspace = undefined;
      throw error;
    });
    const value: unknown = await (await store).handle(request);
    const transfer: Transferable[] = [];
    if (typeof value === 'object' && value !== null && 'media' in value && value.media instanceof ArrayBuffer) {
      transfer.push(value.media);
    }
    self.postMessage({ version: 1, id, ok: true, value }, { transfer });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storage operation failed.';
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      self.postMessage({
        version: 1, id, ok: false,
        error: 'Browser storage is full. Cancel or reduce the import, then free local storage and retry.',
      });
      return;
    }
    // Schema/SQLite errors may contain inputs; return only controlled diagnostics.
    const safe = /^(Backup|A proof|A worker|The proof|Unlock|Unable to unlock|Use a passphrase|Proof interrupted|Unsupported proof|Inconsistent recovery|Encrypted media|Encrypted object|Stored media|Media reference|Workspace|Sanitized image|This image|Encrypted image|Stored image|Image was removed|Local workspace|Annotation document)/.test(message)
      ? message : 'Storage operation failed. Check browser storage permissions, available space, or vault integrity.';
    self.postMessage({ version: 1, id, ok: false, error: safe.slice(0, 512) });
  } finally { busy = false; }
};

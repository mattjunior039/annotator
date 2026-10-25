import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ImageHistory } from '../domain/history';
import type { Command } from '../domain/history';
import { documentSchema } from '../domain/model';
import type { Annotation, AnnotationDocument } from '../domain/model';
import { applyDatasetSchema, datasetSchemaSchema } from '../domain/dataset-schema';
import type { DatasetSchema } from '../domain/dataset-schema';
import { maskIds, paintMask, TILE_SIZE } from '../domain/masks';
import type { Mask, MaskTile } from '../domain/masks';
import { signedArea } from '../domain/geometry';
import { resizeBox, translateAnnotation } from '../domain/editor-geometry';
import type { BoxCorner, Point } from '../domain/editor-geometry';
import {
  boxesToAnnotations, makeYoloYaml, prepareYoloImport,
} from '../interchange/yolo';
import {
  annotationCsv, cocoAnnotations, csvHeader, exportFormat, exportFormats, perImageExport, validateExport,
} from '../interchange/export';
import type { ExportFormat } from '../interchange/export';
import type { YoloSplit } from '../interchange/yolo';
import { importAnnotationFiles } from '../interchange/import';
import type { ImportFormat } from '../interchange/import';
import { SerialClient, WorkerClient } from '../workers/client';
import type { StorageClient } from '../workers/client';
import { LiveHost } from '../collaboration/host';
import type { LiveGuest } from '../collaboration/guest';
import type { ConnectionMode } from '../collaboration/link';
import type { Participant } from '../collaboration/protocol';
import { LiveSharePanel, ParticipantList } from './LiveSharePanel';
import { SharePanel } from './SharePanel';
import { EditorPanel } from './EditorPanel';
import { EditorRequestError, useEditorBridge } from '../ai/useEditorBridge';
import type { AppliedBatch, ImageForEditor } from '../ai/useEditorBridge';
import { describeAnnotations, EditRejected, missingClasses, planImageEdit, withClasses } from '../ai/editor-edits';
import type { AnnotateInput } from '../../services/bridge/protocol';
import { diffDocuments } from '../collaboration/merge';
import type { SuggestedBox } from '../ai/cloud-vision';
import {
  mediaResultSchema, statusSchema, workspaceDeleteSchema, workspaceImportSchema,
  workspaceExportInfoSchema, workspaceListSchema, workspaceReadSchema, workspaceWriteSchema,
  archiveFinishedSchema, archiveProgressSchema, passphraseChangedSchema,
  schemaProgressSchema, schemaMigrationPreviewSchema,
  maskReadSchema, thumbnailSchema, fingerprintSchema,
} from '../workers/protocol';
import type { SchemaMigrationPreview, VaultStatus, WorkspaceDescriptor } from '../workers/protocol';
import { recoverySecretSchema } from '../crypto/vault';

const CloudVisionDialog = lazy(() => import('../ai/CloudVisionDialog').then(module => ({ default: module.CloudVisionDialog })));

export type Tool = 'box' | 'polygon' | 'line' | 'label' | 'keypoints' | 'mask' | 'erase' | 'select' | 'pan';
interface SizedSanitizedImage { png: ArrayBuffer; width: number; height: number }
interface WorkspaceProps {
  descriptor: WorkspaceDescriptor;
  initialPassphrase: string;
  onPassphraseConsumed: () => void;
  initialTool: Tool;
  onBack: () => void;
  guest?: LiveGuest | undefined;
}
interface IndexItem {
  id: string;
  name: string;
  sourcePath: string;
  split: YoloSplit;
  width: number;
  height: number;
  review: 'unannotated' | 'in_progress' | 'annotated' | 'reviewed';
  annotationCount: number;
  intakeFingerprint?: string | undefined;
}
interface OpenImage { document: AnnotationDocument; url: string }
interface ExportWritable {
  write(data: string | Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface ExportFileHandle { createWritable(): Promise<ExportWritable> }
interface ExportDirectoryHandle {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<ExportDirectoryHandle>;
  getFileHandle(name: string, options: { create: boolean }): Promise<ExportFileHandle>;
}
type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite' | 'read' }) => Promise<FileSystemDirectoryHandle>;
};

const tools: { id: Tool; name: string; shortcut: string; icon: string }[] = [
  { id: 'select', name: 'Select', shortcut: 'V', icon: '↖' },
  { id: 'box', name: 'Box', shortcut: '1', icon: '□' },
  { id: 'polygon', name: 'Polygon', shortcut: '2', icon: '⬡' },
  { id: 'line', name: 'Line', shortcut: 'L', icon: '／' },
  { id: 'keypoints', name: 'Keypoint', shortcut: '4', icon: '⊙' },
  { id: 'mask', name: 'Brush mask', shortcut: '5', icon: '◉' },
  { id: 'erase', name: 'Erase mask', shortcut: '6', icon: '◌' },
  { id: 'label', name: 'Image labels', shortcut: '3', icon: '≡' },
  { id: 'pan', name: 'Pan', shortcut: 'H', icon: '✥' },
];
const toolHints: Record<Tool, string> = {
  box: 'Drag on the image to draw a box. Switch to Select (V) to move or resize it.',
  polygon: 'Click to place vertices. Click the highlighted first point to close, or press Enter / Finish polygon. Escape cancels.',
  line: 'Drag between two points to draw a line. Select it to move either endpoint or the whole line.',
  label: 'Choose labels in the right panel to classify this image. Use Detection to draw boxes.',
  keypoints: 'Click to place a point. Add skeleton points in the right panel for landmarks.',
  select: 'Click a shape to select it. Drag to move; drag handles to resize boxes or adjust points.',
  pan: 'Drag the image to pan. Use + / - to zoom and Fit image to reset the view.',
  mask: 'Paint a binary pixel mask. Select an existing mask to extend it; otherwise a new instance is created.',
  erase: 'Select a mask in the annotation list, then erase pixels. Empty tiles are removed.',
};
const toolGroups: { name: string; tools: Tool[] }[] = [
  { name: 'Select & draw', tools: ['select', 'box', 'polygon', 'line', 'keypoints'] },
  { name: 'Pixel masks', tools: ['mask', 'erase'] },
  { name: 'Classify & navigate', tools: ['label', 'pan'] },
];
interface ShapeDrag {
  original: Annotation;
  start: Point;
  handle: string | null;
}
const colors = ['#39764d', '#b84d3b', '#416f9f', '#a56c19', '#8056a1', '#278c8a'];

function makeDocument(
  name: string, width: number, height: number, classNames: readonly string[] = ['Object'],
  annotations: Annotation[] = [], classIds: readonly string[] = [],
): AnnotationDocument {
  const imageId = crypto.randomUUID(), datasetId = crypto.randomUUID();
  const skeletonId = crypto.randomUUID();
  const classes = classNames.map((className, index) => ({
    id: classIds[index] ?? crypto.randomUUID(),
    name: className, color: colors[index % colors.length]!, exclusiveGroup: null,
  }));
  return documentSchema.parse({
    version: 1,
    image: {
      version: 1, id: imageId, datasetId, name: name.slice(0, 256),
      source: { width, height }, canonical: { width, height }, orientation: 1, mediaId: crypto.randomUUID(),
    },
    revision: 0,
    classes,
    skeletons: [{ id: skeletonId, name: 'Point', points: ['Point'], edges: [] }],
    annotations,
    review: 'unannotated',
  });
}

function pointerPoint(event: ReactPointerEvent<SVGSVGElement>, document: AnnotationDocument, clamp = true) {
  const matrix = event.currentTarget.getScreenCTM();
  if (!matrix) throw new Error('The image viewport is unavailable.');
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const { width, height } = document.image.canonical;
  return clamp ? { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) }
    : { x: point.x, y: point.y };
}

async function writeExportFile(
  root: ExportDirectoryHandle, relativePath: string, contents: string | Blob | AsyncIterable<string>,
): Promise<void> {
  const parts = relativePath.split('/');
  const filename = parts.pop();
  if (!filename || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe export path.');
  }
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  const handle = await directory.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    if (typeof contents === 'object' && Symbol.asyncIterator in contents) {
      for await (const chunk of contents) await writable.write(chunk);
    } else await writable.write(contents);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); }
    catch { throw new Error(`Export write failed for ${filename}, and the incomplete file could not be closed safely.`); }
    throw error;
  }
}

export function Workspace({ descriptor, initialPassphrase, onPassphraseConsumed, initialTool, onBack, guest }: WorkspaceProps) {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const creationPassphrase = useRef(initialPassphrase);
  const [imageIndex, setImageIndex] = useState<IndexItem[]>([]);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState<OpenImage | null>(null);
  const [tool, setTool] = useState<Tool>(initialTool);
  const [imagesPanelOpen, setImagesPanelOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [classId, setClassId] = useState('');
  const [newClass, setNewClass] = useState('');
  const [newPointName, setNewPointName] = useState('');
  const [datasetSchema, setDatasetSchema] = useState<DatasetSchema | null>(null);
  const [removedClass, setRemovedClass] = useState('');
  const [replacementClass, setReplacementClass] = useState('');
  const [renamedClass, setRenamedClass] = useState('');
  const [classNameDraft, setClassNameDraft] = useState('');
  const [removedSkeleton, setRemovedSkeleton] = useState('');
  const [renamedSkeleton, setRenamedSkeleton] = useState('');
  const [skeletonNameDraft, setSkeletonNameDraft] = useState('');
  const [pointDrafts, setPointDrafts] = useState<Record<string, string>>({});
  const [migrationPreview, setMigrationPreview] = useState<SchemaMigrationPreview | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [brushRadius, setBrushRadius] = useState(4);
  const [maskUrls, setMaskUrls] = useState<Map<string, string>>(new Map());
  const maskPixels = useRef<Map<string, Uint8Array>>(new Map());
  const maskStroke = useRef<{ points: Point[]; mask: Mask; erase: boolean } | null>(null);
  const [strokePreview, setStrokePreview] = useState<Point[]>([]);
  const [attributeText, setAttributeText] = useState('{}');
  const [pointIndex, setPointIndex] = useState(-1);
  const [vertexIndex, setVertexIndex] = useState(0);
  const [newVertex, setNewVertex] = useState({ x: '0', y: '0' });
  const [idleMinutes, setIdleMinutes] = useState(15);
  const lastActivity = useRef(Date.now());
  const [recoveryCurrent, setRecoveryCurrent] = useState('');
  const [recoveryText, setRecoveryText] = useState('');
  const [recoveryNext, setRecoveryNext] = useState('');
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [recoveryUrl, setRecoveryUrl] = useState('');
  const [rotationSecrets, setRotationSecrets] = useState({ current: '', next: '', confirmation: '' });
  const [rotating, setRotating] = useState(false);
  const [boxStart, setBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [boxEnd, setBoxEnd] = useState<{ x: number; y: number } | null>(null);
  const [lineStart, setLineStart] = useState<Point | null>(null);
  const [lineEnd, setLineEnd] = useState<Point | null>(null);
  const [polygon, setPolygon] = useState<Point[]>([]);
  const [polygonCursor, setPolygonCursor] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [storageInfo, setStorageInfo] = useState('');
  const [persistentStorage, setPersistentStorage] = useState<boolean | null>(null);
  const [offlineReady, setOfflineReady] = useState(false);
  const [offlineUpdateWaiting, setOfflineUpdateWaiting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [shapeDraft, setShapeDraft] = useState<Annotation | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('yolo');
  const [exportImages, setExportImages] = useState(true);
  const [exportCurrent, setExportCurrent] = useState(false);
  const [search, setSearch] = useState('');
  const [reviewFilter, setReviewFilter] = useState('all');
  const [galleryPage, setGalleryPage] = useState(0);
  const [editorSearchPage, setEditorSearchPage] = useState(0);
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<string, string>>(new Map());
  const [importFormat, setImportFormat] = useState<ImportFormat>('native');
  const [replaceAnnotations, setReplaceAnnotations] = useState(false);
  const [resumeIntake, setResumeIntake] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [persistentSharingOpen, setPersistentSharingOpen] = useState(false);
  const [cloudVisionOpen, setCloudVisionOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const exportDialog = useRef<HTMLDialogElement>(null);
  const [archiveMode, setArchiveMode] = useState<'backup' | 'restore' | null>(null);
  const [archivePassphrase, setArchivePassphrase] = useState('');
  const [archiveConfirmation, setArchiveConfirmation] = useState('');
  const [vaultSecrets, setVaultSecrets] = useState({ current: '', next: '', confirmation: '' });
  const archiveDialog = useRef<HTMLDialogElement>(null);
  const cancelArchive = useRef(false);
  const shapeDrag = useRef<ShapeDrag | null>(null);
  const panDrag = useRef<{ start: Point; x: number; y: number; inverse: DOMMatrix } | null>(null);
  const workspace = useRef<HTMLElement>(null);
  const storage = useRef<StorageClient | null>(null);
  const liveHost = useRef<LiveHost | null>(null);
  const [liveRevision, setLiveRevision] = useState(0);
  const [liveMode, setLiveMode] = useState<ConnectionMode>('relay');
  const [liveEnded, setLiveEnded] = useState('');
  const [participants, setParticipants] = useState<Participant[]>(guest?.participants ?? []);
  const currentRef = useRef<OpenImage | null>(null);
  currentRef.current = current;
  const schemaRef = useRef<DatasetSchema | null>(null);
  schemaRef.current = datasetSchema;
  const media = useRef<WorkerClient | null>(null);
  const history = useRef<ImageHistory | null>(null);
  const running = useRef(false);
  const cancelImport = useRef(false);
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => () => {
    liveHost.current?.stop();
    liveHost.current = null;
    // Guests leave explicitly; StrictMode's simulated unmount must not end the session.
    if (!guest) storage.current?.close();
    media.current?.close();
  }, []);
  useEffect(() => {
    if (!guest) return;
    guest.setEvents({
      onCode: () => {},
      onDocument: applyRemoteDocument,
      onSchema: schema => {
        setDatasetSchema(schema);
        const open = currentRef.current;
        if (open) void perform(() => openImage(open.document.image.id));
      },
      onIndex: () => { void refreshIndex(0).catch(failure => setError(failure instanceof Error ? failure.message : 'Unable to refresh images.')); },
      onPresence: setParticipants,
      onEnded: reason => { setLiveEnded(reason); },
    });
  });
  useEffect(() => {
    const id = current?.document.image.id ?? null;
    if (guest) guest.setViewing(id);
    else liveHost.current?.setViewing(id);
  }, [current?.document.image.id, liveRevision]);
  useEffect(() => {
    if (datasetSchema && liveHost.current) liveHost.current.publishSchema(datasetSchema);
  }, [datasetSchema]);
  useEffect(() => {
    const timer = setTimeout(() => { void perform(openStorage); }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!current) return;
    return () => URL.revokeObjectURL(current.url);
  }, [current?.url]);
  useEffect(() => () => { for (const url of maskUrls.values()) URL.revokeObjectURL(url); }, [maskUrls]);
  useEffect(() => () => { for (const url of thumbnailUrls.values()) URL.revokeObjectURL(url); }, [thumbnailUrls]);
  useEffect(() => { setThumbnailUrls(new Map()); }, [galleryPage, search, reviewFilter, current?.document.image.id]);
  useEffect(() => { setEditorSearchPage(0); }, [search]);
  useEffect(() => () => { if (recoveryUrl) URL.revokeObjectURL(recoveryUrl); }, [recoveryUrl]);

  useEffect(() => {
    if (exportOpen) exportDialog.current?.showModal();
    else exportDialog.current?.close();
  }, [exportOpen]);
  useEffect(() => {
    if (archiveMode) archiveDialog.current?.showModal();
    else archiveDialog.current?.close();
  }, [archiveMode]);

  useEffect(() => {
    if (current) workspace.current?.focus({ preventScroll: true });
  }, [current?.document.image.id]);
  useEffect(() => {
    const annotation = current?.document.annotations.find(item => item.id === selected);
    setAttributeText(JSON.stringify(annotation?.attributes ?? {}, null, 2));
  }, [selected, current?.document.image.id, current?.document.annotations.find(item => item.id === selected)?.attributes]);
  useEffect(() => {
    setPointIndex(-1); setVertexIndex(0);
  }, [selected, current?.document.image.id]);
  useEffect(() => {
    if (!descriptor.passwordProtected || !vault?.unlocked || idleMinutes === 0) return;
    lastActivity.current = Date.now();
    const activity = () => { lastActivity.current = Date.now(); };
    const check = () => {
      if (Date.now() - lastActivity.current >= idleMinutes * 60_000 && !running.current) lockWorkspace(true);
    };
    window.addEventListener('pointerdown', activity, { passive: true });
    window.addEventListener('keydown', activity);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
      document.removeEventListener('visibilitychange', check);
    };
  }, [vault?.unlocked, descriptor.passwordProtected, idleMinutes]);

  async function perform(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The local operation failed.');
      if (storage.current?.isClosed) {
        storage.current = null;
        setVault(null);
      }
    } finally {
      if (media.current?.isClosed) media.current = null;
      running.current = false;
      setBusy(false);
    }
  }

  function newStorage(): StorageClient {
    if (guest) return guest.storage;
    return new SerialClient(new WorkerClient(new Worker(new URL('../workers/storage.worker.ts', import.meta.url), { type: 'module' })));
  }

  async function startLiveSession() {
    if (!storage.current || !datasetSchema || liveHost.current) return;
    setLiveEnded('');
    liveHost.current = await LiveHost.start({
      workspaceName: descriptor.name,
      storage: storage.current,
      schema: () => schemaRef.current,
      mode: liveMode,
      onChange: () => setLiveRevision(value => value + 1),
      onDocument: applyRemoteDocument,
      onEnded: reason => {
        liveHost.current = null;
        setLiveEnded(reason);
        setLiveRevision(value => value + 1);
      },
    });
    setLiveRevision(value => value + 1);
  }

  function stopLiveSession(reason?: string) {
    liveHost.current?.stop(reason);
    liveHost.current = null;
  }

  // Adopt a document saved by another participant, keeping local undo history.
  function applyRemoteDocument(document: AnnotationDocument) {
    setImageIndex(previous => previous.map(item => item.id === document.image.id ? {
      ...item, review: document.review, annotationCount: document.annotations.length,
    } : item));
    const open = currentRef.current;
    if (!open || open.document.image.id !== document.image.id || !history.current) return;
    if (document.revision < history.current.snapshot().revision) return;
    history.current.rebase(document);
    const masks = (doc: AnnotationDocument) => JSON.stringify(doc.annotations.filter(item => item.kind === 'mask'));
    if (masks(open.document) !== masks(document)) {
      void loadMaskPixels(document).catch(failure => setError(failure instanceof Error ? failure.message : 'Unable to load masks.'));
    }
    setCurrent(previous => previous && previous.document.image.id === document.image.id &&
      previous.document.revision <= document.revision ? { ...previous, document } : previous);
    setSelected(previous => document.annotations.some(item => item.id === previous) ? previous : null);
  }

  async function openStorage() {
    const secret = creationPassphrase.current;
    creationPassphrase.current = '';
    onPassphraseConsumed();
    if (!storage.current) {
      storage.current = newStorage();
    }
    let opened = await storage.current.request({ type: 'workspace-open', workspaceId: descriptor.id }, statusSchema);
    if (!opened.unlocked && secret) opened = await storage.current.request({ type: 'unlock', passphrase: secret }, statusSchema);
    setVault(opened);
    if (opened.unlocked) {
      await initializeSchema();
      await refreshIndex(0);
    }
    await Promise.all([refreshStorageInfo(), inspectOfflineShell()]);
  }
  async function initializeSchema() {
    if (!storage.current) throw new Error('Open the local workspace first.');
    let result = await storage.current.request({ type: 'schema-open' }, schemaProgressSchema);
    if (!result.ready) {
      for (let index = result.completed; index < result.total; index++) {
        setProgress(`Preparing dataset classes and skeletons ${index + 1} of ${result.total}`);
        result = await storage.current.request({ type: 'schema-step', index }, schemaProgressSchema);
      }
      result = await storage.current.request({ type: 'schema-finish' }, schemaProgressSchema);
    }
    setDatasetSchema(result.schema);
    setProgress('');
    return result.schema;
  }

  async function refreshStorageInfo() {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate(), navigator.storage.persisted(),
    ]);
    const usage = estimate.usage ?? 0, quota = estimate.quota ?? 0;
    setStorageInfo(`${(usage / 1024 ** 2).toFixed(1)} MB used${quota ? ` · ${(quota / 1024 ** 2).toFixed(0)} MB estimated quota` : ''}`);
    setPersistentStorage(persisted);
  }

  async function refreshIndex(offset = 0) {
    if (!storage.current) throw new Error('Open the local workspace first.');
    const result = await storage.current.request({ type: 'workspace-list', offset, limit: 100 }, workspaceListSchema);
    const items = [...result.items];
    if (offset === 0) {
      for (let position = items.length; position < result.total; position += 100) {
        setProgress(`Indexing local dataset ${position} of ${result.total}`);
        const page = await storage.current.request({ type: 'workspace-list', offset: position, limit: 100 }, workspaceListSchema);
        if (page.total !== result.total || page.items.length === 0) throw new Error('Workspace catalog changed while indexing. Reopen to retry.');
        items.push(...page.items);
      }
      setProgress(''); setGalleryPage(0);
    }
    setTotal(result.total);
    if (offset === 0) liveHost.current?.publishIndex();
    setThumbnailUrls(new Map());
    setImageIndex(previous => offset === 0 ? items : [...previous, ...items]);
    return result.total;
  }

  async function loadThumbnails(items: readonly IndexItem[]) {
    if (!storage.current) throw new Error('Unlock the workspace before loading previews.');
    const urls = new Map<string, string>();
    cancelImport.current = false;
    try {
      for (const item of items.slice(0, 100)) {
        if (cancelImport.current) break;
        setProgress(`Loading local previews ${urls.size + 1} of ${Math.min(items.length, 100)}`);
        const result = await storage.current.request({ type: 'workspace-thumbnail', id: item.id }, thumbnailSchema);
        urls.set(item.id, URL.createObjectURL(new Blob([result.media], { type: 'image/png' })));
      }
      setThumbnailUrls(urls);
      setNotice(`Loaded ${urls.size} local previews. Disk copies are encrypted; only this page's preview URLs are retained in memory.`);
    } catch (error) { for (const url of urls.values()) URL.revokeObjectURL(url); throw error; }
    finally { setProgress(''); }
  }

  async function openImage(id: string) {
    if (currentRef.current?.document.image.id !== id) {
      setCloudVisionOpen(false);
    }
    if (!storage.current) throw new Error('Unlock the local workspace first.');
    const result = await storage.current.request({ type: 'workspace-read', id }, workspaceReadSchema);
    const url = URL.createObjectURL(new Blob([result.media], { type: 'image/png' }));
    const checked = documentSchema.parse(result.document);
    await loadMaskPixels(checked);
    history.current = new ImageHistory(checked);
    setCurrent({ document: checked, url });
    setClassId(checked.classes[0]?.id ?? '');
    setSelected(null);
    setPolygon([]);
    setPolygonCursor(null);
    setShapeDraft(null);
    shapeDrag.current = null;
    panDrag.current = null;
    setView({ zoom: 1, x: 0, y: 0 });
    setNotice(guest ? `Live from the host · ${checked.revision} edits` : `Saved on this device · ${checked.revision} edits`);
  }

  async function loadMaskPixels(document: AnnotationDocument) {
    if (!storage.current) throw new Error('Unlock the workspace first.');
    const tiles = maskIds(document).length
      ? await storage.current.request({ type: 'workspace-mask-read', id: document.image.id }, maskReadSchema) : [];
    const urls = new Map<string, string>();
    try {
      for (const tile of tiles) {
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE), context = canvas.getContext('2d');
        if (!context) throw new Error('Mask rendering requires a 2D canvas.');
        const image = context.createImageData(TILE_SIZE, TILE_SIZE), bytes = new Uint8Array(tile.pixels);
        for (let index = 0; index < bytes.length; index++) {
          image.data[index * 4] = 57; image.data[index * 4 + 1] = 118; image.data[index * 4 + 2] = 77;
          image.data[index * 4 + 3] = bytes[index] ? 150 : 0;
        }
        context.putImageData(image, 0, 0);
        urls.set(tile.id, URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' })));
      }
    } catch (failure) { for (const url of urls.values()) URL.revokeObjectURL(url); throw failure; }
    maskPixels.current = new Map(tiles.map(tile => [tile.id, new Uint8Array(tile.pixels)]));
    setMaskUrls(urls);
  }

  async function persistDocument(before: AnnotationDocument, next: AnnotationDocument, tiles: MaskTile[] = []) {
    // Uses refs, not render state: AI-editor batches and their undo run from closures of earlier renders.
    const open = currentRef.current;
    if (!storage.current || !open) throw new Error('Open an image in the local workspace first.');
    setNotice('Saving…');
    let saved = next;
    try {
      const host = liveHost.current;
      if (host) saved = await host.commitLocal(before, next, tiles);
      else {
        await storage.current.request({
          type: 'workspace-update', id: next.image.id, expectedRevision: before.revision, document: next, tiles,
        }, workspaceWriteSchema);
        if (guest) saved = guest.cached(next.image.id) ?? next;
      }
      if (saved !== next && history.current && saved.revision >= history.current.snapshot().revision) history.current.rebase(saved);
      setCurrent(previous => previous && !(previous.document.image.id === saved.image.id && previous.document.revision > saved.revision)
        ? { ...previous, document: saved } : previous);
      setSelected(previous => saved.annotations.some(item => item.id === previous) ? previous : null);
      setImageIndex(previous => previous.map(item => item.id === saved.image.id ? {
        ...item, review: saved.review, annotationCount: saved.annotations.length,
      } : item));
      setNotice(guest ? 'Saved to the host workspace' : liveHost.current ? 'Saved on this device · shared live' : 'Saved on this device');
    } catch (failure) {
      history.current = new ImageHistory(currentRef.current?.document ?? open.document);
      throw failure;
    }
    const masks = (doc: AnnotationDocument) => JSON.stringify(doc.annotations.filter(item => item.kind === 'mask'));
    if (tiles.length || masks(before) !== masks(saved)) await loadMaskPixels(saved);
  }

  async function edit(command: unknown, tiles: MaskTile[] = []) {
    if (!history.current || !current) throw new Error('Open an image first.');
    const before = history.current.snapshot();
    const next = history.current.execute(command, before.revision);
    await persistDocument(before, next, tiles);
  }

  async function editBatch(commands: readonly unknown[]) {
    if (!history.current || !current) throw new Error('Open an image first.');
    const before = history.current.snapshot();
    const next = history.current.executeBatch(commands, before.revision);
    await persistDocument(before, next);
  }

  const imageIndexRef = useRef(imageIndex);
  imageIndexRef.current = imageIndex;

  // Serializes AI-editor writes with the user's own edits instead of dropping them like perform() would.
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (running.current) {
      if (Date.now() > deadline) throw new EditorRequestError('failed', 'The workspace stayed busy; try again.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    running.current = true;
    setBusy(true);
    try { return await action(); } finally { running.current = false; setBusy(false); }
  }

  function indexed(id: string) {
    const item = imageIndexRef.current.find(entry => entry.id === id);
    if (!item) throw new EditorRequestError('stale', 'Unknown image id; call list_images again.');
    return item;
  }

  async function readForEditor(id: string): Promise<{ document: AnnotationDocument; media?: ArrayBuffer }> {
    indexed(id);
    if (!storage.current) throw new EditorRequestError('failed', 'The workspace is locked.');
    if (currentRef.current?.document.image.id === id && history.current) return { document: history.current.snapshot() };
    const result = await storage.current.request({ type: 'workspace-read', id }, workspaceReadSchema);
    return { document: documentSchema.parse(result.document), media: result.media };
  }

  async function saveEditorSchema(next: DatasetSchema) {
    if (!storage.current) throw new EditorRequestError('failed', 'The workspace is locked.');
    const result = await storage.current.request({
      type: 'schema-update', expectedRevision: schemaRef.current?.revision ?? 0, schema: next,
    }, schemaProgressSchema);
    schemaRef.current = result.schema;
    setDatasetSchema(result.schema);
    const open = currentRef.current;
    if (open && history.current) {
      const document = applyDatasetSchema(history.current.snapshot(), result.schema);
      history.current = new ImageHistory(document);
      currentRef.current = { ...open, document };
      setCurrent(previous => previous ? { ...previous, document } : previous);
    }
    return result.schema;
  }

  // Writes an AI-editor change through the same paths as manual edits; the current image keeps its undo history.
  async function commitEditorChange(before: AnnotationDocument, commands: Command[]): Promise<AnnotationDocument> {
    const id = before.image.id;
    if (currentRef.current?.document.image.id === id && history.current) {
      const base = history.current.snapshot();
      const next = history.current.executeBatch(commands, base.revision);
      await persistDocument(base, next);
      return history.current.snapshot();
    }
    if (!storage.current) throw new EditorRequestError('failed', 'The workspace is locked.');
    const next = new ImageHistory(before).executeBatch(commands, before.revision);
    let saved = next;
    if (liveHost.current) saved = await liveHost.current.commitLocal(before, next, []);
    else await storage.current.request({
      type: 'workspace-update', id, expectedRevision: before.revision, document: next, tiles: [],
    }, workspaceWriteSchema);
    setImageIndex(previous => previous.map(item => item.id === id
      ? { ...item, review: saved.review, annotationCount: saved.annotations.length } : item));
    return saved;
  }

  async function planEditorEdits(input: AnnotateInput, schema: DatasetSchema) {
    const plans = [];
    for (const edit of input.edits) {
      const { document: stored } = await readForEditor(edit.imageId);
      const document = applyDatasetSchema(stored, schema);
      if (edit.expectedRevision !== undefined && edit.expectedRevision !== document.revision) {
        throw new EditorRequestError('stale', `Image ${edit.imageId} is at revision ${document.revision}, not ${edit.expectedRevision}; re-read it.`);
      }
      try {
        const plan = planImageEdit(document, edit, input.units ?? 'pixels');
        if (plan.commands.length) new ImageHistory(document).executeBatch(plan.commands, document.revision);
        plans.push({ document, plan });
      } catch (failure) {
        if (failure instanceof EditRejected) throw new EditorRequestError('invalid', `Image ${edit.imageId}: ${failure.message}`);
        throw new EditorRequestError('invalid', `Image ${edit.imageId}: the edit does not fit the image or its annotations.`);
      }
    }
    return plans;
  }

  function editorSummary(plans: Awaited<ReturnType<typeof planEditorEdits>>, created: readonly string[]) {
    const added = plans.reduce((sum, item) => sum + item.plan.added.length, 0);
    const updated = plans.reduce((sum, item) => sum + item.plan.updated, 0);
    const removed = plans.reduce((sum, item) => sum + item.plan.removed, 0);
    return [`${added} added, ${updated} changed, ${removed} removed on ${plans.length} image${plans.length === 1 ? '' : 's'}`,
      ...(created.length ? [`new classes: ${created.join(', ')}`] : [])].join('; ');
  }

  const editorBridge = useEditorBridge(descriptor.id, {
    list({ offset = 0, limit = 50, review }) {
      const items = imageIndexRef.current.filter(item => !review || item.review === review);
      return {
        total: items.length, offset,
        images: items.slice(offset, offset + limit).map(item => ({
          id: item.id, width: item.width, height: item.height, review: item.review, annotationCount: item.annotationCount,
        })),
        classes: (schemaRef.current?.classes ?? []).map(item => ({ id: item.id, name: item.name })),
      };
    },
    async annotations(ids) {
      const images = [];
      for (const id of ids) {
        const { document } = await readForEditor(id);
        images.push({ id, width: document.image.canonical.width, height: document.image.canonical.height,
          revision: document.revision, review: document.review, annotations: describeAnnotations(document) });
      }
      return { images };
    },
    async images(ids) {
      const images: ImageForEditor[] = [];
      for (const id of ids) {
        const item = indexed(id);
        if (!storage.current) throw new EditorRequestError('failed', 'The workspace is locked.');
        const result = await storage.current.request({ type: 'workspace-read', id }, workspaceReadSchema);
        images.push({ id, name: item.name, width: result.document.image.canonical.width,
          height: result.document.image.canonical.height, png: result.media });
      }
      return images;
    },
    async preview(input) {
      const schema = schemaRef.current;
      if (!schema) throw new EditorRequestError('failed', 'The workspace is locked.');
      const created = missingClasses(input, schema);
      const plans = await planEditorEdits(input, withClasses(schema, created));
      return [editorSummary(plans, created), ...plans.map(({ document, plan }) =>
        `${document.image.name}: +${plan.added.length} / ~${plan.updated} / −${plan.removed}`)];
    },
    apply(input) {
      return exclusive(async (): Promise<AppliedBatch> => {
        let schema = schemaRef.current;
        if (!schema) throw new EditorRequestError('failed', 'The workspace is locked.');
        const created = missingClasses(input, schema);
        // Validate every image before writing anything, so a bad request changes nothing.
        await planEditorEdits(input, withClasses(schema, created));
        if (created.length) schema = await saveEditorSchema(withClasses(schema, created));
        const plans = await planEditorEdits(input, schema);
        const applied: { before: AnnotationDocument; after: AnnotationDocument }[] = [];
        const images = [];
        for (const { document, plan } of plans) {
          const after = plan.commands.length ? await commitEditorChange(document, plan.commands) : document;
          if (plan.commands.length) applied.push({ before: document, after });
          images.push({ id: document.image.id, revision: after.revision, added: plan.added, updated: plan.updated, removed: plan.removed });
        }
        const summary = editorSummary(plans, created);
        return {
          result: { state: 'applied', createdClasses: created, images }, summary,
          undo: () => exclusive(async () => {
            let restored = 0, kept = 0;
            for (const { before, after } of [...applied].reverse()) {
              const { document: latest } = await readForEditor(after.image.id).catch(() => ({ document: null }));
              if (!latest) { kept++; continue; }
              const current = schemaRef.current ?? schema;
              const original = applyDatasetSchema(before, current), edited = applyDatasetSchema(after, current);
              const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
              const commands: Command[] = [];
              // Revert only what the AI changed and only where it is still exactly as the AI left it.
              for (const change of diffDocuments(original, { ...edited, revision: original.revision })) {
                if (change.type === 'review') {
                  if (latest.review === edited.review) commands.push({ type: 'review', review: original.review }); else kept++;
                  continue;
                }
                const id = change.type === 'put' ? change.annotation.id : change.id;
                const now = latest.annotations.find(item => item.id === id);
                const then = original.annotations.find(item => item.id === id);
                if (!same(now, change.type === 'put' ? change.annotation : undefined)) { kept++; continue; }
                commands.push(then ? { type: 'put', annotation: then } : { type: 'remove', id });
              }
              if (commands.length) { await commitEditorChange(latest, commands); restored++; }
            }
            return `Undid AI edits on ${restored} image${restored === 1 ? '' : 's'}${kept ? `; kept ${kept} item${kept === 1 ? '' : 's'} you changed since` : ''}.`;
          }),
        };
      });
    },
  });

  async function undoRedo(direction: 'undo' | 'redo') {
    if (!history.current || !current) return;
    const before = history.current.snapshot();
    const next = direction === 'undo'
      ? history.current.undo(before.revision)
      : history.current.redo(before.revision);
    await persistDocument(before, next);
  }

  async function importImage(
    name: string,
    sourcePath: string,
    split: YoloSplit,
    imageResult: SizedSanitizedImage,
    classNames: readonly string[] = ['Object'],
    annotations: Annotation[] = [],
    classIds: readonly string[] = [],
    intakeFingerprint?: string,
  ) {
    if (!storage.current) throw new Error('Unlock the local workspace before importing.');
    const doc = makeDocument(name, imageResult.width, imageResult.height, classNames, annotations, classIds);
    const mediaBytes = imageResult.png.slice(0);
    await storage.current.request({
      type: 'workspace-import', document: doc, media: mediaBytes, sourcePath, split, intakeFingerprint,
    }, workspaceImportSchema, [mediaBytes]);
    return doc.image.id;
  }

  async function unlockOrCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = passphrase;
    setPassphrase('');
    await perform(async () => {
      if (!vault) throw new Error('Open the local workspace first.');
      if (!storage.current) {
        storage.current = newStorage();
        await storage.current.request({ type: 'workspace-open', workspaceId: descriptor.id }, statusSchema);
      }
      const next = await storage.current.request({
        type: vault.exists ? 'unlock' : 'create', passphrase: value,
      }, statusSchema);
      setVault(next);
      await initializeSchema();
      await refreshStorageInfo();
      await refreshIndex(0);
      setNotice('Workspace unlocked · data stays in this browser profile');
    });
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    const selectedFiles = Array.from(files);
    await perform(() => importBatch(selectedFiles, total));
  }

  async function importBatch(files: readonly File[], existingTotal: number) {
    cancelImport.current = false;
    const plan = await prepareYoloImport(files);
    if (!resumeIntake && existingTotal + plan.items.length > 10_000) {
      throw new Error(`This import would exceed the 10,000-image workspace limit. There is room for ${10_000 - existingTotal} more images.`);
    }
    const estimate = await navigator.storage.estimate();
    if (estimate.quota !== undefined && estimate.usage !== undefined) {
      const available = Math.max(0, estimate.quota - estimate.usage);
      if (available < 1024 * 1024) throw new Error('Browser storage is almost full. Free local storage before importing. No images were added.');
      const inputBytes = plan.items.reduce((sum, item) => sum + item.file.size, 0);
      setNotice(`Import storage check: ${(available / 1024 / 1024).toFixed(1)} MiB available; ${(inputBytes / 1024 / 1024).toFixed(1)} MiB source files. Sanitized PNG copies can be larger. This is an estimate, not a storage reservation; completed images remain saved if quota is reached.`);
    }
    const classIds = plan.classNames.map(() => crypto.randomUUID());
    let imported = 0, failed = 0, resumed = 0;
    const completed = new Set(imageIndex.flatMap(item => item.intakeFingerprint ? [item.intakeFingerprint] : []));
    const failures: string[] = [];
    for (let i = 0; i < plan.items.length; i++) {
      if (cancelImport.current) break;
      const item = plan.items[i]!;
      const file = item.file;
      setProgress(`Preparing ${i + 1} of ${plan.items.length}`);
      try {
        media.current ??= new WorkerClient(new Worker(new URL('../workers/media.worker.ts', import.meta.url), { type: 'module' }));
        const { fingerprint } = await media.current.request({
          type: 'file-fingerprint', file, context: JSON.stringify([item.sourcePath, plan.classNames, item.boxes]),
        }, fingerprintSchema);
        if (resumeIntake && completed.has(fingerprint)) { resumed++; continue; }
        if (existingTotal + imported >= 10_000) throw new Error('Workspace limit reached (10,000 images). Completed images remain saved.');
        const sanitized = await media.current.request({ type: 'sanitize', file }, mediaResultSchema);
        const annotations = boxesToAnnotations(
          item.boxes, sanitized.width, sanitized.height, classIds,
        );
        await importImage(
          file.name, item.sourcePath, item.split, sanitized, plan.classNames, annotations, classIds, fingerprint,
        );
        completed.add(fingerprint);
        imported++;
      } catch (failure) {
        failed++;
        if (failures.length < 10) {
          const reason = failure instanceof Error ? failure.message : 'Unknown error';
          failures.push(`${item.sourcePath}: ${reason}`);
        }
        if (failure instanceof Error && /storage is full|quota|Workspace limit reached/i.test(failure.message)) {
          setError(failure.message);
          break;
        }
      }
      setProgress(`Imported ${imported} · failed ${failed} · ${i + 1} of ${plan.items.length}`);
    }
    await initializeSchema();
    await refreshIndex(0);
    setNotice(`Import finished · ${imported} added · ${failed} skipped${resumed ? ` · ${resumed} already-saved inputs retained` : ''}${plan.orphanLabels ? ` · ${plan.orphanLabels} unmatched label files` : ''}${cancelImport.current ? ' · cancelled' : ''}`);
    if (failures.length > 0) {
      setError(`${failures.length === 10 && failed > 10 ? 'First 10 of ' : ''}${failed} files could not be imported:\n${failures.join('\n')}`);
    }
    setProgress('');
  }

  async function importAnnotations(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    await perform(async () => {
      if (!storage.current || !datasetSchema || !replaceAnnotations) throw new Error('Confirm annotation replacement before importing.');
      const imports = await importAnnotationFiles(selected, importFormat, imageIndex, datasetSchema.classes.map(item => item.name));
      let session: string | undefined;
      let failure: unknown;
      try {
        const started = await storage.current.request({ type: 'annotation-import-start', count: imports.length }, archiveProgressSchema);
        session = started.session;
        for (const [index, item] of imports.entries()) {
          setProgress(`Validating and staging annotations ${index + 1} of ${imports.length}`);
          await storage.current.request({ type: 'annotation-import-step', session, index, ...item }, archiveProgressSchema);
        }
        await storage.current.request({ type: 'archive-finish', session }, archiveFinishedSchema);
        session = undefined;
        await initializeSchema(); await refreshIndex(0);
        setNotice(`Imported annotations for ${imports.length} images atomically. Image pixels and source files were not changed.`);
        setReplaceAnnotations(false);
      } catch (error) { failure = error; }
      finally {
        setProgress('');
        if (session && !storage.current.isClosed) {
          try { await storage.current.request({ type: 'archive-cancel', session }, archiveFinishedSchema); }
          catch (cleanup) {
            const original = failure instanceof Error ? failure.message : 'Annotation import did not complete.';
            const reason = cleanup instanceof Error ? cleanup.message : 'Unknown cleanup error.';
            storage.current.close();
            failure = new Error(`${original} Cleanup failed: ${reason} Reopen the workspace to recover staged files.`);
          }
        }
      }
      if (failure) throw failure;
    });
  }

  async function exportDataset() {
    await perform(async () => {
      setProgress('');
      try {
        if (!storage.current) throw new Error('Unlock the local workspace before exporting.');
        const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
        if (!picker) throw new Error('Folder export requires a Chromium browser with local directory access.');
        let destination: ExportDirectoryHandle;
        try { destination = await picker.call(window, { mode: 'readwrite' }); }
        catch (failure) {
          if (failure instanceof DOMException && failure.name === 'AbortError') return;
          throw failure;
        }
        const descriptors: { id: string; offset: number; split: YoloSplit; stem: string; outputStem: string; width: number; height: number; sourcePath: string }[] = [];
        const classNames: string[] = [];
        const classIndexes = new Map<string, number>();
        const cocoSkeletons = new Map<string, { points: string[]; edges: [number, number][] }>();
        const splits = new Set<YoloSplit>();
        const stemCounts = new Map<string, number>();
        let count = 0;
        for (let offset = 0; offset < total; offset++) {
          const page = await storage.current.request({
            type: 'workspace-export-info', offset, limit: 1,
          }, workspaceExportInfoSchema);
          const item = page.items[0];
          if (!item) throw new Error('Workspace changed during export preflight.');
          if (exportCurrent && current && item.id !== current.document.image.id) continue;
          const classIds = new Set<string>();
          for (const cls of item.document.classes) {
            if (classIds.has(cls.id)) throw new Error('An image has duplicate class IDs; export was stopped.');
            classIds.add(cls.id);
            if (!classIndexes.has(cls.name)) {
              if (classNames.length >= 10_000) throw new Error('Dataset export supports at most 10,000 classes.');
              classIndexes.set(cls.name, classNames.length);
              classNames.push(cls.name);
            }
          }
          validateExport(item.document, format);
          if (format === 'coco') for (const annotation of item.document.annotations) if (annotation.kind === 'keypoints') {
            const name = item.document.classes.find(cls => cls.id === annotation.classId)!.name;
            const skeleton = item.document.skeletons.find(skeleton => skeleton.id === annotation.skeletonId)!;
            const value = { points: skeleton.points, edges: skeleton.edges };
            if (cocoSkeletons.has(name) && JSON.stringify(cocoSkeletons.get(name)) !== JSON.stringify(value)) {
              throw new Error('COCO requires one consistent skeleton per category. Choose native JSON to preserve multiple skeletons.');
            }
            cocoSkeletons.set(name, value);
          }
          const basename = item.sourcePath.replaceAll('\\', '/').split('/').at(-1) ?? '';
          const rawStem = basename.replace(/\.[^.]+$/, '');
          const stem = rawStem.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
            .replace(/[. ]+$/g, '').slice(0, 120) || 'image';
          stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
          descriptors.push({ id: item.id, offset, split: item.split, stem, outputStem: '',
            ...item.document.image.canonical, sourcePath: item.sourcePath });
          splits.add(item.split);
          count++;
          setProgress(`Checking annotations ${count} of ${page.total}`);
        }
        if (count === 0) throw new Error('There are no images to export.');
        if (classNames.length === 0) classNames.push('Object');
        const usedOutputStems = new Set<string>();
        for (const descriptor of descriptors) {
          let candidate = (stemCounts.get(descriptor.stem) ?? 0) > 1
            ? `${descriptor.stem}-${descriptor.id.slice(0, 8)}` : descriptor.stem;
          if (usedOutputStems.has(candidate.toLowerCase())) candidate = `${descriptor.stem}-${descriptor.id}`;
          while (usedOutputStems.has(candidate.toLowerCase())) candidate = `${candidate}-${descriptor.id}`;
          descriptor.outputStem = candidate;
          usedOutputStems.add(candidate.toLowerCase());
        }

        const folderName = `annotator-${format}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
        const root = await destination.getDirectoryHandle(folderName, { create: true });
        if (format === 'yolo' || format === 'yolo-seg') {
          await writeExportFile(root, 'data.yaml', makeYoloYaml(classNames, splits));
        }
        const indexesFor = (document: AnnotationDocument) => new Map(
          document.classes.map(cls => [cls.id, classIndexes.get(cls.name)!]),
        );
        const client = storage.current;
        const descriptorById = new Map(descriptors.map(item => [item.id, item]));
        const readDocument = async (id: string) => {
          const descriptor = descriptorById.get(id);
          if (!descriptor) throw new Error('Image is missing from the export plan.');
          const page = await client.request({ type: 'workspace-export-info', offset: descriptor.offset, limit: 1 }, workspaceExportInfoSchema);
          const item = page.items[0];
          if (!item || item.id !== id) throw new Error('Image disappeared during export.');
          return item.document;
        };
        // Stream aggregate formats one image at a time, without retaining dataset annotations.
        if (format === 'coco') {
          for (const split of splits) {
            const items = descriptors.filter(item => item.split === split);
            async function* cocoChunks() {
              yield '{"images":[';
              for (const [index, item] of items.entries()) {
                yield `${index ? ',' : ''}${JSON.stringify({
                  id: index + 1, file_name: `images/${item.outputStem}.png`, width: item.width, height: item.height,
                })}`;
              }
              yield `],"categories":${JSON.stringify(classNames.map((name, index) => {
                const skeleton = cocoSkeletons.get(name);
                return { id: index + 1, name, supercategory: '',
                  ...(skeleton ? { keypoints: skeleton.points, skeleton: skeleton.edges.map(([a, b]) => [a + 1, b + 1]) } : {}) };
              }))},"annotations":[`;
              let annotationId = 1, first = true;
              for (const [index, item] of items.entries()) {
                const document = await readDocument(item.id);
                const tiles = maskIds(document).length ? await client.request({ type: 'workspace-mask-read', id: item.id }, maskReadSchema) : [];
                for (const annotation of cocoAnnotations(document, index + 1, indexesFor(document), annotationId,
                  new Map(tiles.map(tile => [tile.id, new Uint8Array(tile.pixels)])))) {
                  yield `${first ? '' : ','}${JSON.stringify(annotation)}`;
                  first = false;
                  annotationId++;
                }
              }
              yield ']}\n';
            }
            await writeExportFile(root, `${split}/_annotations.coco.json`, cocoChunks());
          }
        }
        if (format === 'csv') {
          async function* csvChunks() {
            yield csvHeader;
            for (const item of descriptors) {
              yield annotationCsv(await readDocument(item.id), `${item.split}/images/${item.outputStem}.png`);
            }
          }
          await writeExportFile(root, 'annotations.csv', csvChunks());
        }
        for (let i = 0; i < descriptors.length; i++) {
          const descriptor = descriptors[i]!;
          const item = exportImages ? await client.request(
            { type: 'workspace-read', id: descriptor.id }, workspaceReadSchema,
          ) : null;
          if (item) {
            await writeExportFile(root, `${descriptor.split}/images/${descriptor.outputStem}.png`, new Blob([item.media], { type: 'image/png' }));
          }
          if (format !== 'coco' && format !== 'csv') {
            const document = item?.document ?? await readDocument(descriptor.id);
            const file = perImageExport(document, format, indexesFor(document), `${descriptor.outputStem}.png`);
            await writeExportFile(root, `${descriptor.split}/labels/${descriptor.outputStem}.${file.extension}`, file.contents);
            if (format === 'native' && maskIds(document).length) {
              const tiles = await client.request({ type: 'workspace-mask-read', id: descriptor.id }, maskReadSchema);
              for (const tile of tiles) await writeExportFile(root, `masks/${tile.id}.bin`, new Blob([tile.pixels]));
            }
          }
          setProgress(`Exporting ${i + 1} of ${descriptors.length}`);
        }
        await writeExportFile(root, 'export-manifest.json', JSON.stringify({
          version: 1, format, includesImages: exportImages, classes: classNames,
          images: descriptors.map(item => ({ id: item.id, sourcePath: item.sourcePath,
            file: `${item.split}/images/${item.outputStem}.png`, split: item.split, width: item.width, height: item.height })),
        }, null, 2));
        setExportOpen(false);
        setNotice(`Exported ${descriptors.length} images${exportImages ? ' and annotations' : ' (annotations only)'} as ${exportFormats.find(item => item.id === format)!.name} to ${folderName}. Exported files are plaintext copies.`);
      } finally {
        setProgress('');
      }
    });
  }

  async function runArchive() {
    const mode = archiveMode, secret = archivePassphrase;
    setArchivePassphrase('');
    setArchiveConfirmation('');
    cancelArchive.current = false;
    await perform(async () => {
      if (!mode || !storage.current) throw new Error('Unlock the workspace before using backups.');
      if (mode === 'backup' && secret !== archiveConfirmation) throw new Error('Backup passphrases do not match. Enter and confirm the passphrase again.');
      const client = storage.current;
      const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
      if (!picker) throw new Error('Backup and restore require Chromium local directory access.');
      let session: string | undefined;
      let failure: unknown;
      try {
        let directory: FileSystemDirectoryHandle;
        try { directory = await picker.call(window, { mode: mode === 'backup' ? 'readwrite' : 'read' }); }
        catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          throw error;
        }

        if (mode === 'backup') {
          directory = await directory.getDirectoryHandle(`annotator-backup-${crypto.randomUUID()}`, { create: true });
        }
        setProgress(mode === 'backup' ? 'Preparing encrypted backup…' : 'Authenticating backup…');
        const started = await client.request({
          type: mode === 'backup' ? 'backup-start' : 'restore-start', directory, passphrase: secret,
        }, archiveProgressSchema);
        session = started.session;
        for (let index = 0; index < started.count; index++) {
          if (cancelArchive.current) break;
          setProgress(`${mode === 'backup' ? 'Backing up' : 'Verifying and staging'} ${index + 1} of ${started.count}`);
          await client.request({ type: 'archive-step', session, index }, archiveProgressSchema);
        }
        if (cancelArchive.current) {
          setNotice(`${mode === 'backup' ? 'Backup' : 'Restore'} cancelled. Existing dataset records were not changed. Incomplete backup folders can be removed.`);
        } else {
          const finished = await client.request({ type: 'archive-finish', session }, archiveFinishedSchema);
          session = undefined;
          await initializeSchema();
          await refreshIndex(0);
          await refreshStorageInfo();
          setNotice(mode === 'backup'
            ? `Encrypted backup complete · ${finished.count} images and annotations · ${directory.name}. Keep the backup passphrase separately.`
            : `Restore complete · ${finished.count} images and annotations verified and committed atomically.`);
        }
        setArchiveMode(null);
      } catch (error) { failure = error; }
      finally {
        if (session && !client.isClosed) {
          try { await client.request({ type: 'archive-cancel', session }, archiveFinishedSchema); }
          catch (cleanup) {
            const original = failure instanceof Error ? failure.message : 'Archive operation did not complete.';
            const reason = cleanup instanceof Error ? cleanup.message : 'Unknown cleanup error.';
            client.close();
            failure = new Error(`${original} Cleanup failed: ${reason} Reopen the workspace to recover staged files.`);
          }
        }
        setProgress('');
      }
      if (failure) throw failure;
    });
  }

  async function rotateKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secrets = rotationSecrets;
    setRotationSecrets({ current: '', next: '', confirmation: '' });
    cancelArchive.current = false;
    await perform(async () => {
      if (!storage.current) throw new Error('Unlock the workspace before rotating its key.');
      if (secrets.next !== secrets.confirmation) throw new Error('New key-rotation passphrases do not match.');
      const client = storage.current;
      let session: string | undefined;
      let failure: unknown;
      setRotating(true);
      try {
        const started = await client.request({ type: 'vault-rotation-start', current: secrets.current, next: secrets.next }, archiveProgressSchema);
        session = started.session;
        for (let index = 0; index < started.count; index++) {
          if (cancelArchive.current) break;
          setProgress(`Re-encrypting ${index + 1} of ${started.count}`);
          await client.request({ type: 'archive-step', session, index }, archiveProgressSchema);
        }
        if (cancelArchive.current) {
          await client.request({ type: 'archive-cancel', session }, archiveFinishedSchema); session = undefined;
          setNotice('Key rotation cancelled. The old key and passphrase remain active.');
        } else {
          const finished = await client.request({ type: 'archive-finish', session }, archiveFinishedSchema); session = undefined;
          setRecoveryUrl('');
          await initializeSchema(); await refreshIndex(0);
          setNotice(finished.cleanupPending
            ? 'Workspace key rotated; the NEW passphrase is active. Old encrypted-file cleanup failed. Exit and reopen with the new passphrase to finish cleanup.'
            : 'Workspace key rotated. All current images, masks, and records use a fresh root key. The NEW passphrase is active. Generate a new recovery file; old recovery files no longer work. Existing backups and previously copied data are not revoked.');
        }
      } catch (error) { failure = error; }
      finally {
        setRotating(false); setProgress('');
        if (session && !client.isClosed) {
          try { await client.request({ type: 'archive-cancel', session }, archiveFinishedSchema); }
          catch (cleanup) {
            const original = failure instanceof Error ? failure.message : 'Key rotation did not complete.';
            const reason = cleanup instanceof Error ? cleanup.message : 'Unknown cleanup error.';
            client.close();
            failure = new Error(`${original} Cleanup failed: ${reason} Reopen the workspace to recover staged files.`);
          }
        }
      }
      if (failure) throw failure;
    });
  }

  async function changePassphrase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secrets = vaultSecrets;
    setVaultSecrets({ current: '', next: '', confirmation: '' });
    await perform(async () => {
      if (!storage.current) throw new Error('Unlock the workspace before changing its passphrase.');
      if (secrets.next !== secrets.confirmation) throw new Error('New workspace passphrases do not match. Enter them again.');
      if (secrets.current === secrets.next) throw new Error('Choose a different workspace passphrase.');
      await storage.current.request({
        type: 'vault-passphrase', current: secrets.current, next: secrets.next,
      }, passphraseChangedSchema);
      setNotice('Workspace passphrase changed. Saved images and annotations are unchanged. Existing backups still use their own backup passphrases. This rewraps the same data key; it does not revoke copies of an old vault header or a compromised data key.');
    });
  }

  async function addClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!storage.current || !newClass.trim()) return;
    await perform(async () => {
      const before = datasetSchema;
      if (!before) throw new Error('Workspace schema is not ready. Reopen the workspace.');
      if (before.classes.some(item => item.name === newClass.trim())) {
        throw new Error('A class with this name already exists. Select it from the class list.');
      }
      const next: DatasetSchema = {
        ...before,
        revision: before.revision + 1,
        classes: [...before.classes, {
          id: crypto.randomUUID(),
          name: newClass.trim(),
          color: colors[before.classes.length % colors.length]!,
          exclusiveGroup: null,
        }],
      };
      await updateDatasetSchema(next);
      setClassId(next.classes.at(-1)!.id);
      setNewClass('');
    });
  }

  async function addSkeletonPoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newPointName.trim()) return;
    await perform(async () => {
      const before = datasetSchema;
      if (!before) throw new Error('Workspace schema is not ready. Reopen the workspace.');
      const skeleton = before.skeletons[0];
      if (!skeleton) throw new Error('This image has no keypoint skeleton.');
      const name = newPointName.trim();
      if (skeleton.points.includes(name)) throw new Error('Point names must be unique.');
      const next: DatasetSchema = {
        ...before,
        revision: before.revision + 1,
        skeletons: before.skeletons.map(item => item.id === skeleton.id ? {
          ...item,
          points: [...item.points, name],
          edges: item.points.length ? [...item.edges, [item.points.length - 1, item.points.length]] : item.edges,
        } : item),
      };
      await updateDatasetSchema(next);
      setNewPointName('');
    });
  }
  async function updateDatasetSchema(next: DatasetSchema) {
    if (!storage.current || !datasetSchema) throw new Error('Unlock the workspace before changing the dataset schema.');
    const result = await storage.current.request({
      type: 'schema-update', expectedRevision: datasetSchema.revision, schema: next,
    }, schemaProgressSchema);
    setDatasetSchema(result.schema);
    setMigrationPreview(null);
    if (current) {
      const document = applyDatasetSchema(current.document, result.schema);
      history.current = new ImageHistory(document);
      setCurrent(previous => previous ? { ...previous, document } : previous);
    }
    setNotice('Dataset schema saved for every image. Image undo history was reset.');
  }

  async function previewSchemaMigration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMigrationPreview(null);
    setConfirmDiscard(false);
    await perform(async () => {
      if (!storage.current || !datasetSchema) throw new Error('Unlock the workspace before changing the dataset schema.');
      const next: DatasetSchema = {
        ...datasetSchema, revision: datasetSchema.revision + 1,
        classes: datasetSchema.classes.filter(item => item.id !== removedClass).map(item =>
          item.id === renamedClass ? { ...item, name: classNameDraft.trim() } : item),
        skeletons: datasetSchema.skeletons.filter(item => item.id !== removedSkeleton).map(item => {
          const points = (pointDrafts[item.id] ?? item.points.join('\n')).split('\n').map(name => name.trim()).filter(Boolean);
          return { ...item, name: item.id === renamedSkeleton ? skeletonNameDraft.trim() : item.name,
            points, edges: item.edges.flatMap(([from, to]): [number, number][] => {
            const a = points.indexOf(item.points[from]!), b = points.indexOf(item.points[to]!);
            return a >= 0 && b >= 0 ? [[a, b]] : [];
          }) };
        }),
      };
      if (!datasetSchemaSchema.safeParse(next).success) {
        throw new Error('Point names must be unique and nonempty, with 1–256 points per skeleton and at most 256 characters per name.');
      }
      const preview = await storage.current.request({
        type: 'schema-preview', expectedRevision: datasetSchema.revision, schema: next,
        remaps: removedClass && replacementClass ? [{ from: removedClass, to: replacementClass }] : [],
      }, schemaMigrationPreviewSchema);
      setMigrationPreview(preview);
    });
  }

  async function applySchemaMigration() {
    await perform(async () => {
      if (!storage.current || !migrationPreview) return;
      const result = await storage.current.request({
        type: 'schema-apply', token: migrationPreview.token, confirmDiscard,
      }, schemaProgressSchema);
      setDatasetSchema(result.schema);
      setMigrationPreview(null); setConfirmDiscard(false);
      setRemovedClass(''); setReplacementClass(''); setPointDrafts({});
      setRenamedClass(''); setClassNameDraft('');
      setRemovedSkeleton(''); setRenamedSkeleton(''); setSkeletonNameDraft('');
      setClassId(previous => result.schema.classes.some(item => item.id === previous) ? previous : result.schema.classes[0]?.id ?? '');
      if (current) {
        const saved = await storage.current.request({ type: 'workspace-read', id: current.document.image.id }, workspaceReadSchema);
        history.current = new ImageHistory(saved.document);
        setCurrent(previous => previous ? { ...previous, document: saved.document } : previous);
      }
      await refreshIndex();
      setNotice('Dataset migration saved atomically. No annotations were deleted. Image undo history was reset.');
    });
  }

  async function addAnnotation(annotation: Annotation) {
    await perform(async () => {
      await edit({ type: 'put', annotation });
      setSelected(annotation.id);
      setPolygon([]);
      setPolygonCursor(null);
    });
  }

  async function addCloudSuggestions(suggestions: readonly SuggestedBox[]) {
    if (!current || !classId) throw new Error('Select an annotation class before adding suggestions.');
    const annotations: Annotation[] = suggestions.map(suggestion => {
      const matchingClass = current.document.classes.find(item =>
        item.name.localeCompare(suggestion.label, undefined, { sensitivity: 'accent' }) === 0);
      return {
          id: crypto.randomUUID(),
          classId: matchingClass?.id ?? classId,
          attributes: {
            ai_source: 'cloud-vision-review',
            ai_suggested_label: suggestion.label,
            ai_confidence: suggestion.confidence,
          },
          kind: 'box',
          ...suggestion.bounds,
        };
    });
    await editBatch(annotations.map(annotation => ({ type: 'put', annotation })));
    if (annotations.length) setSelected(annotations.at(-1)!.id);
  }

  function chooseTool(next: Tool) {
    if (guest && (next === 'mask' || next === 'erase')) return;
    maskStroke.current = null;
    setStrokePreview([]);
    setTool(next);
    setPolygon([]);
    setPolygonCursor(null);
    setBoxStart(null);
    setBoxEnd(null);
    setLineStart(null);
    setLineEnd(null);
    setShapeDraft(null);
    shapeDrag.current = null;
    panDrag.current = null;
    workspace.current?.focus({ preventScroll: true });
  }

  function zoomBy(factor: number) {
    if (!current) return;
    const { width, height } = current.document.image.canonical;
    setView(previous => {
      const zoom = Math.max(1, Math.min(8, previous.zoom * factor));
      return {
        zoom,
        x: previous.x + width / previous.zoom / 2 - width / zoom / 2,
        y: previous.y + height / previous.zoom / 2 - height / zoom / 2,
      };
    });
  }

  async function navigateImage(direction: -1 | 1) {
    if (!current || busy) return;
    await perform(async () => {
      const index = imageIndex.findIndex(item => item.id === current.document.image.id);
      if (index < 0) throw new Error('The current image is not in the loaded dataset list.');
      const target = index + direction;
      if (target < 0 || target >= total) return;
      let item = imageIndex[target];
      if (!item) {
        if (!storage.current) throw new Error('Unlock the local workspace first.');
        const page = await storage.current.request({
          type: 'workspace-list', offset: imageIndex.length, limit: 100,
        }, workspaceListSchema);
        setImageIndex(previous => [...previous, ...page.items]);
        item = page.items[target - imageIndex.length];
      }
      if (!item) throw new Error('The next image could not be loaded.');
      await openImage(item.id);
    });
  }

  function cancelGesture() {
    maskStroke.current = null;
    setStrokePreview([]);
    shapeDrag.current = null;
    panDrag.current = null;
    setShapeDraft(null);
    setBoxStart(null);
    setBoxEnd(null);
    setLineStart(null);
    setLineEnd(null);
  }

  function draggedShape(event: ReactPointerEvent<SVGSVGElement>): Annotation | null {
    const drag = shapeDrag.current;
    if (!drag || !current) return null;
    const point = pointerPoint(event, current.document);
    const annotation = drag.original;
    if (annotation.kind === 'box' && drag.handle &&
        ['nw', 'ne', 'sw', 'se'].includes(drag.handle)) {
      return resizeBox(annotation, drag.handle as BoxCorner, point, current.document.image.canonical);
    }
    if (drag.handle?.startsWith('point-') &&
        (annotation.kind === 'polygon' || annotation.kind === 'keypoints' || annotation.kind === 'line')) {
      const index = Number(drag.handle.slice(6));
      if (annotation.kind === 'polygon') return {
        ...annotation, points: annotation.points.map((old, i) => i === index ? point : old),
      };
      if (annotation.kind === 'line') return {
        ...annotation, points: [
          index === 0 ? point : annotation.points[0],
          index === 1 ? point : annotation.points[1],
        ],
      };
      return { ...annotation, points: annotation.points.map((old, i) => i === index ? { ...old, ...point } : old) };
    }
    return translateAnnotation(annotation, { x: point.x - drag.start.x, y: point.y - drag.start.y },
      current.document.image.canonical);
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!current || busy || event.button !== 0) return;
    workspace.current?.focus({ preventScroll: true });
    if (tool === 'mask' || tool === 'erase') {
      const selectedMask = current.document.annotations.find(item => item.id === selected && item.kind === 'mask');
      if (selectedMask?.locked || selectedMask?.visible === false) { setError('Show and unlock this mask before painting.'); return; }
      if (tool === 'erase' && selectedMask?.kind !== 'mask') { setError('Select a mask before erasing pixels.'); return; }
      if (!classId) { setError('Add or select a class before painting.'); return; }
      const mask: Mask = selectedMask?.kind === 'mask' ? selectedMask : {
        id: crypto.randomUUID(), classId, attributes: {}, kind: 'mask', tileSize: 256, tiles: [],
        width: current.document.image.canonical.width, height: current.document.image.canonical.height,
      };
      const point = pointerPoint(event, current.document);
      maskStroke.current = { mask, points: [point], erase: tool === 'erase' };
      setStrokePreview([point]);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'pan') {
      const matrix = event.currentTarget.getScreenCTM();
      if (!matrix) return;
      panDrag.current = { start: pointerPoint(event, current.document, false), x: view.x, y: view.y,
        inverse: matrix.inverse() };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'line' && classId) {
      const point = pointerPoint(event, current.document);
      setLineStart(point);
      setLineEnd(point);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'select') {
      const target = event.target instanceof Element ? event.target.closest('[data-annotation-id]') : null;
      const annotation = current.document.annotations.find(item => item.id === target?.getAttribute('data-annotation-id'));
      setSelected(annotation?.id ?? null);
      if (annotation && !annotation.locked) {
        shapeDrag.current = { original: annotation, start: pointerPoint(event, current.document),
          handle: target?.getAttribute('data-handle') ?? null };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (tool !== 'box' || !classId) return;
    const point = pointerPoint(event, current.document);
    event.currentTarget.setPointerCapture(event.pointerId);
    setBoxStart(point);
    setBoxEnd(point);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!current) return;
    if (maskStroke.current) {
      if (maskStroke.current.points.length >= 4096) {
        cancelGesture(); setError('Mask stroke is too long. Use shorter strokes.'); return;
      }
      maskStroke.current.points.push(pointerPoint(event, current.document));
      setStrokePreview([...maskStroke.current.points]);
      return;
    }
    if (panDrag.current) {
      const drag = panDrag.current;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.inverse);
      setView(previous => ({ ...previous,
        x: drag.x + drag.start.x - point.x,
        y: drag.y + drag.start.y - point.y,
      }));
    } else if (shapeDrag.current) setShapeDraft(draggedShape(event));
    else if (boxStart && tool === 'box') setBoxEnd(pointerPoint(event, current.document));
    else if (lineStart && tool === 'line') setLineEnd(pointerPoint(event, current.document));
    else if (polygon.length > 0 && tool === 'polygon') setPolygonCursor(pointerPoint(event, current.document));
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (maskStroke.current && current) {
      const stroke = maskStroke.current;
      stroke.points.push(pointerPoint(event, current.document));
      cancelGesture();
      void perform(async () => {
        const result = paintMask(stroke.mask, maskPixels.current, stroke.points, brushRadius, stroke.erase);
        if (JSON.stringify(result.mask) === JSON.stringify(stroke.mask)) return;
        await edit({ type: 'put', annotation: result.mask }, result.tiles);
        setSelected(result.mask.id);
      });
      return;
    }
    if (panDrag.current) { panDrag.current = null; return; }
    if (lineStart && tool === 'line' && current) {
      const start = lineStart, end = pointerPoint(event, current.document);
      cancelGesture();
      if ((Math.abs(end.x - start.x) > 0.01 || Math.abs(end.y - start.y) > 0.01) && classId) {
        void addAnnotation({
          id: crypto.randomUUID(), classId, attributes: {}, kind: 'line', points: [start, end],
        });
      }
      return;
    }
    if (shapeDrag.current) {
      const original = shapeDrag.current.original;
      let changed = draggedShape(event);
      if (changed?.kind === 'polygon' && signedArea(changed.points) < 0) {
        changed = { ...changed, points: [...changed.points].reverse() };
      }
      cancelGesture();
      if (changed && JSON.stringify(changed) !== JSON.stringify(original)) {
        void addAnnotation(changed);
      }
      return;
    }
    if (!current || !boxStart || tool !== 'box') return;
    const end = pointerPoint(event, current.document);
    const x = Math.min(boxStart.x, end.x), y = Math.min(boxStart.y, end.y);
    const width = Math.abs(end.x - boxStart.x), height = Math.abs(end.y - boxStart.y);
    setBoxStart(null);
    setBoxEnd(null);
    if (width < 1 || height < 1 || !classId) return;
    void addAnnotation({
      id: crypto.randomUUID(), classId, attributes: {}, kind: 'box', x, y, width, height,
    });
  }

  function onCanvasClick(event: ReactPointerEvent<SVGSVGElement>) {
    if (!current || busy) return;
    const point = pointerPoint(event, current.document);
    if (tool === 'polygon') {
      if (polygon.length >= 3) {
        const matrix = event.currentTarget.getScreenCTM();
        if (!matrix) throw new Error('The image viewport is unavailable.');
        const first = new DOMPoint(polygon[0]!.x, polygon[0]!.y).matrixTransform(matrix);
        if (Math.hypot(event.clientX - first.x, event.clientY - first.y) <= 14) {
          void finishPolygon();
          return;
        }
      }
      setPolygon(previous => [...previous, point]);
      setPolygonCursor(point);
    }
    if (tool === 'keypoints' && classId) {
      const skeleton = current.document.skeletons[0];
      if (!skeleton) return;
      const selectedAnnotation = current.document.annotations.find(annotation =>
        annotation.id === selected && annotation.classId === classId && annotation.kind === 'keypoints' && annotation.skeletonId === skeleton.id,
      );
      const missingIndex = selectedAnnotation?.kind === 'keypoints'
        ? pointIndex >= 0 ? pointIndex : selectedAnnotation.points.findIndex(item => item.visibility === 'absent') : -1;
      if (selectedAnnotation?.kind === 'keypoints' && missingIndex >= 0) {
        const points = [...selectedAnnotation.points];
        points[missingIndex] = { ...point, visibility: 'visible' };
        void addAnnotation({ ...selectedAnnotation, points });
        return;
      }
      void addAnnotation({
        id: crypto.randomUUID(), classId, attributes: {}, kind: 'keypoints',
        skeletonId: skeleton.id,
        points: skeleton.points.map((_, index) => index === 0
          ? { ...point, visibility: 'visible' as const }
          : { x: 0, y: 0, visibility: 'absent' as const }),
      });
    }
  }

  async function finishPolygon() {
    if (!current || polygon.length < 3 || !classId) return;
    const points = signedArea(polygon) < 0 ? [...polygon].reverse() : polygon;
    await addAnnotation({
      id: crypto.randomUUID(), classId, attributes: {}, kind: 'polygon', points,
    });
  }

  function addClassification(classIdToAdd: string) {
    if (!current) return;
    const old = current.document.annotations.find(
      annotation => annotation.kind === 'label' && annotation.classId === classIdToAdd,
    );
    if (old) void perform(() => edit({ type: 'remove', id: old.id }));
    else void addAnnotation({
      id: crypto.randomUUID(), classId: classIdToAdd, attributes: {}, kind: 'label',
    });
  }

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (exportOpen || archiveMode || cloudVisionOpen) return;
    if (event.target instanceof HTMLElement &&
        (event.target.matches('input, select, textarea') || event.target.isContentEditable)) return;
    if (busy) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey ? history.current?.canRedo : history.current?.canUndo) {
        void perform(() => undoRedo(event.shiftKey ? 'redo' : 'undo'));
      }
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      if (history.current?.canRedo) void perform(() => undoRedo('redo'));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault();
      void perform(() => edit({ type: 'remove', id: selected }));
      setSelected(null);
    } else if (event.key === 'Escape') {
      cancelGesture();
      setSelected(null);
      setPolygon([]);
      setPolygonCursor(null);
    } else if (event.key === 'Enter' && tool === 'polygon' && polygon.length >= 3 &&
        !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      void finishPolygon();
    } else if (event.key === '1') chooseTool('box');
    else if (event.key === '2') chooseTool('polygon');
    else if (event.key === '3') chooseTool('label');
    else if (event.key === '4') chooseTool('keypoints');
    else if (event.key === '5') chooseTool('mask');
    else if (event.key === '6') chooseTool('erase');
    else if (event.key.toLowerCase() === 'l') chooseTool('line');
    else if (event.key.toLowerCase() === 'v') chooseTool('select');
    else if (event.key.toLowerCase() === 'h') chooseTool('pan');
    else if (event.key === '+' || event.key === '=') zoomBy(1.25);
    else if (event.key === '-') zoomBy(0.8);
    else if (event.key === '0') setView({ zoom: 1, x: 0, y: 0 });
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      void navigateImage(event.key === 'ArrowRight' ? 1 : -1);
    }
  }

  async function removeImage(id: string) {
    if (!storage.current) return;
    if (!window.confirm('Remove this image and its annotations from the encrypted local dataset? The source file is not changed.')) return;
    await perform(async () => {
      await storage.current!.request({ type: 'workspace-delete', id }, workspaceDeleteSchema);
      if (current?.document.image.id === id) {
        URL.revokeObjectURL(current.url);
        history.current = null;
        setCurrent(null);
        setSelected(null);
      }
      await refreshIndex(0);
      setNotice('Image and its annotations removed from this local dataset; the source file was not changed.');
    });
  }

  async function requestPersistentStorage() {
    const granted = await navigator.storage.persist();
    setPersistentStorage(granted);
    setNotice(granted
      ? 'The browser granted persistent storage; this does not replace a backup.'
      : 'The browser may evict local data. Download backups regularly.');
    await refreshStorageInfo();
  }

  async function inspectOfflineShell() {
    if (!('serviceWorker' in navigator)) {
      setOfflineReady(false);
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    setOfflineUpdateWaiting(!!registration?.waiting);
    if (!registration?.active) {
      setOfflineReady(false);
      return;
    }
    const names = (await caches.keys()).filter(name => name.startsWith('annotator-app-shell-'));
    let hasEntryPoint = false;
    for (const name of names) {
      if (await (await caches.open(name)).match(new URL(import.meta.env.BASE_URL, location.href))) {
        hasEntryPoint = true;
        break;
      }
    }
    setOfflineReady(hasEntryPoint);
  }

  async function installOfflineShell() {
    if (!('serviceWorker' in navigator)) throw new Error('This browser cannot install the offline app shell.');
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
    await registration.update();
    setOfflineUpdateWaiting(!!registration.waiting);
    if (registration.waiting) {
      setNotice('A verified app-shell update is ready. Apply it only when you are ready to reload.');
      return;
    }
    const installing = registration.installing;
    if (installing) {
      await new Promise<void>((resolve, reject) => {
        const onStateChange = () => {
          if (installing.state === 'installed' || installing.state === 'activated') {
            installing.removeEventListener('statechange', onStateChange);
            resolve();
          } else if (installing.state === 'redundant') {
            installing.removeEventListener('statechange', onStateChange);
            reject(new Error('Offline app-shell installation failed. The current app remains available.'));
          }
        };
        installing.addEventListener('statechange', onStateChange);
        onStateChange();
      });
    }
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve, reject) => {
        const container = navigator.serviceWorker;
        const timeout = setTimeout(() => {
          container.removeEventListener('controllerchange', onControllerChange);
          reject(new Error('Offline app shell installed, but this page is not controlled yet. Reload once while online.'));
        }, 5000);
        const onControllerChange = () => {
          if (!container.controller) return;
          clearTimeout(timeout);
          container.removeEventListener('controllerchange', onControllerChange);
          resolve();
        };
        container.addEventListener('controllerchange', onControllerChange);
        onControllerChange();
      });
    }
    if (registration.waiting) {
      setOfflineUpdateWaiting(true);
      setNotice('A verified app-shell update is ready. Apply it only when you are ready to reload.');
      return;
    }
    await inspectOfflineShell();
    const names = (await caches.keys()).filter(name => name.startsWith('annotator-app-shell-'));
    if (!names.length) throw new Error('Offline installation did not create an app-shell cache.');
    setNotice('App shell cached on this device. Dataset files are not placed in Cache Storage.');
  }

  async function applyOfflineUpdate() {
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    if (!registration?.waiting) {
      setOfflineUpdateWaiting(false);
      return;
    }
    registration.waiting.postMessage('ACTIVATE_UPDATE');
    setOfflineUpdateWaiting(false);
    setNotice('The app-shell update will take effect after you reload. Saved annotations remain in the encrypted workspace.');
  }

  function lockAndReturn() {
    stopLiveSession();
    storage.current?.close();
    media.current?.close();
    storage.current = null;
    media.current = null;
    setVault(null);
    setCurrent(null);
    history.current = null;
    onBack();
  }

  function lockWorkspace(automatic = false) {
    if (running.current) return;
    if (editorBridge.status.state !== 'idle') void editorBridge.disconnect();
    stopLiveSession('The host locked the workspace.');
    storage.current?.close(); media.current?.close();
    storage.current = null; media.current = null; history.current = null;
    cancelGesture(); setPolygon([]); setPolygonCursor(null); setCurrent(null); setSelected(null);
    maskPixels.current.clear(); setMaskUrls(new Map()); setDatasetSchema(null);
    setMigrationPreview(null); setConfirmDiscard(false); setPointDrafts({});
    setRemovedClass(''); setReplacementClass('');
    setThumbnailUrls(new Map());
    setImageIndex([]); setTotal(0); setPassphrase(''); setAttributeText('{}');
    setArchivePassphrase(''); setArchiveConfirmation(''); setVaultSecrets({ current: '', next: '', confirmation: '' });
    setRecoveryCurrent(''); setRecoveryText(''); setRecoveryNext(''); setRecoveryConfirmation(''); setRecoveryUrl('');
    setRotationSecrets({ current: '', next: '', confirmation: '' });
    setExportOpen(false); setArchiveMode(null); setSharingOpen(false); setPersistentSharingOpen(false);
    setVault(previous => previous ? { ...previous, unlocked: false } : null);
    setError('');
    setNotice(automatic ? 'Workspace locked after inactivity. Completed edits are saved; unfinished gestures were discarded.' :
      'Workspace locked. Completed edits are saved; unfinished gestures were discarded.');
  }

  const imagePosition = current ? imageIndex.findIndex(item => item.id === current.document.image.id) : -1;
  const selectedAnnotation = current?.document.annotations.find(item => item.id === selected);
  const visibleAnnotations = current?.document.annotations.filter(item => item.visible !== false)
    .map(item => shapeDraft?.id === item.id ? shapeDraft : item) ?? [];
  const activeShape = visibleAnnotations.find(item => item.id === selected && !item.locked);
  const handleRadius = current ? current.document.image.canonical.width / view.zoom / 110 : 1;
  const filteredImages = imageIndex.filter(item =>
    item.name.toLowerCase().includes(search.toLowerCase()) &&
    (reviewFilter === 'all' || item.review === reviewFilter));
  const visiblePage = Math.min(galleryPage, Math.max(0, Math.ceil(filteredImages.length / 100) - 1));
  const galleryImages = filteredImages.slice(visiblePage * 100, (visiblePage + 1) * 100);
  const editorMatches = imageIndex.filter(item => item.name.toLowerCase().includes(search.toLowerCase()));
  const editorResultsPage = Math.min(editorSearchPage, Math.max(0, Math.ceil(editorMatches.length / 100) - 1));
  const editorStart = search ? editorResultsPage * 100 : Math.floor(Math.max(0, editorMatches.findIndex(item => item.id === current?.document.image.id)) / 100) * 100;
  const activeTool = tools.find(item => item.id === tool)!;
  const editorLayoutClass = [
    'editor-layout',
    !imagesPanelOpen && 'images-collapsed',
    !inspectorOpen && 'inspector-collapsed',
  ].filter(Boolean).join(' ');

  function returnToDataset() {
    setCloudVisionOpen(false);
    cancelGesture(); setPolygon([]); setPolygonCursor(null); setCurrent(null); setSelected(null); history.current = null;
    maskPixels.current.clear(); setMaskUrls(new Map());
  }
  function showExport() {
    setError('');
    setExportCurrent(false);
    setExportOpen(true);
  }

  if (guest && liveEnded) return <section className="workspace live-ended" aria-label="Live session ended">
    <div className="workspace-card">
      <h2>Live session ended</h2>
      <p role="status">{liveEnded}</p>
      <p>No images or annotations from this session were kept in this browser.</p>
      <button type="button" className="continue-button" onClick={lockAndReturn}>Return to start</button>
    </div>
  </section>;

  return <section ref={workspace} data-workspace-id={descriptor.id} tabIndex={-1} className={`workspace${current ? ' is-editing' : ''}`} onKeyDown={handleKeys}>
    {vault?.unlocked && datasetSchema && <nav className="project-nav" aria-label="Workspace sections">
      <span className="project-name">{descriptor.name}</span>
      <div className="project-steps" aria-label="Project workflow">
        <button type="button" className={!current ? 'active' : ''} aria-current={!current ? 'step' : undefined}
          disabled={busy} onClick={returnToDataset}><span className="step-number" aria-hidden="true">1</span>Dataset</button>
        <span className={current ? 'active project-step' : 'project-step'} aria-current={current ? 'step' : undefined}>
          <span className="step-number" aria-hidden="true">2</span>Annotate</span>
        {!guest && <button type="button" className="project-export" disabled={busy || total === 0}
          onClick={showExport}><span className="step-number" aria-hidden="true">3</span>Export</button>}
      </div>
      <div className="project-nav-utilities">
        {!guest && <button type="button" aria-expanded={editorOpen}
          className={editorBridge.status.state === 'connected' ? 'live-badge' : undefined}
          onClick={() => setEditorOpen(previous => !previous)}>{editorBridge.status.state === 'connected'
            ? `${editorBridge.editorName} connected` : 'AI editor'}{editorBridge.pending ? ` · ${editorBridge.pending} waiting` : ''}</button>}
        {current && !guest && <button type="button" disabled={busy || !current.document.classes.length}
          onClick={() => setCloudVisionOpen(true)}>AI suggestions</button>}
        {!guest && <button type="button" disabled={busy || !!liveHost.current} aria-expanded={persistentSharingOpen}
          title={liveHost.current ? 'Stop live sharing before publishing or reviewing snapshots.' : 'Encrypted snapshots and approval-based contributions'}
          onClick={() => setPersistentSharingOpen(previous => !previous)}>Share workspace</button>}
        {liveHost.current && liveHost.current.pending.length > 0 && <button type="button" className="live-alert"
          onClick={() => setSharingOpen(true)}>{liveHost.current.pending.length} waiting to join</button>}
        {guest ? <span className="live-badge" role="status">Live · {participants.length} {participants.length === 1 ? 'person' : 'people'}</span>
          : <button type="button" disabled={busy && !liveHost.current} aria-expanded={sharingOpen}
            className={liveHost.current ? 'live-badge' : undefined}
            onClick={() => setSharingOpen(previous => !previous)}>{liveHost.current
              ? `Live · ${liveHost.current.participants.length} ${liveHost.current.participants.length === 1 ? 'person' : 'people'}` : 'Live share'}</button>}
        {!current && !guest && <button type="button" disabled={busy} onClick={() => {
          setError(''); setArchivePassphrase(''); setArchiveConfirmation(''); setArchiveMode('backup');
        }}>Encrypted backup</button>}
        {!current && !guest && <button type="button" disabled={busy || total !== 0} title="Restore into an empty workspace; existing images are never overwritten." onClick={() => {
          setError(''); setArchivePassphrase(''); setArchiveConfirmation(''); setArchiveMode('restore');
        }}>Restore backup</button>}
      </div>
    </nav>}
    <div className="workspace-heading">
      <div>
        <h1>{current ? current.document.image.name : descriptor.name}</h1>
        <p>{current
          ? `${current.document.annotations.length} annotations · ${current.document.review.replace('_', ' ')}`
          : descriptor.passwordProtected ? 'Password protected · stored on this device' : 'No password · accessible to this browser profile'}</p>
      </div>
      <div className="workspace-heading-actions">
        {vault?.unlocked && descriptor.passwordProtected && <button type="button" className="text-button" disabled={busy}
          onClick={() => lockWorkspace()}>Lock workspace</button>}
        <button className="text-button" type="button" disabled={busy && !guest} onClick={lockAndReturn}>{guest ? 'Leave session' : 'Exit workspace'}</button>
      </div>
    </div>

    {!vault && <div className="workspace-card">
      <p>Opening this workspace on your device. No files are sent to a server.</p>
      <button className="continue-button" disabled={busy} onClick={() => void perform(openStorage)}>
        {error ? 'Retry opening workspace' : 'Opening workspace...'}
      </button>
    </div>}

    {vault && !vault.unlocked && <form className="workspace-card" onSubmit={unlockOrCreate}>
      <label htmlFor="workspace-passphrase">{vault.exists ? 'Workspace passphrase' : 'Create a passphrase'}</label>
      <input id="workspace-passphrase" type="password" minLength={12} maxLength={1024}
        autoComplete="new-password" required value={passphrase} onChange={event => setPassphrase(event.target.value)} />
      <p>Your passphrase stays on this device. Unlock this workspace to access its dataset.</p>
      <button className="continue-button" disabled={busy}>{vault.exists ? 'Unlock workspace' : 'Create workspace'}</button>
    </form>}
    {vault && !vault.unlocked && descriptor.passwordProtected && <details>
      <summary>Recover with a recovery file</summary>
      <form className="workspace-card" onSubmit={event => {
        event.preventDefault();
        const text = recoveryText, next = recoveryNext, confirmation = recoveryConfirmation;
        setRecoveryText(''); setRecoveryNext(''); setRecoveryConfirmation('');
        void perform(async () => {
          if (next !== confirmation) throw new Error('Recovery passphrases do not match. Re-select the file and try again.');
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { throw new Error('Select a valid recovery JSON file.'); }
          const checked = recoverySecretSchema.safeParse(parsed);
          if (!checked.success) throw new Error('This is not a supported recovery-secret file.');
          if (!storage.current) {
            storage.current = newStorage();
            await storage.current.request({ type: 'workspace-open', workspaceId: descriptor.id }, statusSchema);
          }
          const status = await storage.current.request({ type: 'vault-recovery-use', recovery: checked.data, next }, statusSchema);
          setVault(status); await initializeSchema(); await refreshIndex(0);
          setNotice('Workspace recovered. The new passphrase is active; keep the recovery file protected.');
        });
      }}>
        <p>This file is a decryption credential. It only works with this workspace’s surviving browser storage; it is not a dataset backup.</p>
        <label>Recovery file<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (!file) return;
          void perform(async () => {
            if (file.size > 4096) throw new Error('Recovery file exceeds 4 KiB.');
            setRecoveryText(await file.text());
          });
        }} /></label>
        <label>New recovery passphrase<input type="password" required minLength={12} maxLength={1024}
          value={recoveryNext} onChange={event => setRecoveryNext(event.target.value)} /></label>
        <label>Confirm recovery passphrase<input type="password" required minLength={12} maxLength={1024}
          value={recoveryConfirmation} onChange={event => setRecoveryConfirmation(event.target.value)} /></label>
        <button type="submit" disabled={busy || !recoveryText}>Recover workspace</button>
      </form>
    </details>}

    {vault?.unlocked && !datasetSchema && <div className="workspace-card">
      <h2>Preparing dataset schema</h2>
      <p>Existing classes and named keypoints are checked one image at a time. Saved images are not rewritten or deleted.</p>
      {progress && <p role="status">{progress}</p>}
      <button type="button" className="tool-button" disabled={busy} onClick={() => void perform(async () => {
        await initializeSchema(); await refreshIndex(0);
      })}>{busy ? 'Preparing...' : 'Resume schema preparation'}</button>
    </div>}
    {vault?.unlocked && datasetSchema && <>
      {persistentSharingOpen && !guest && !liveHost.current && storage.current && <SharePanel storage={storage.current}
        workspaceName={descriptor.name} busy={busy} run={perform} onClose={() => setPersistentSharingOpen(false)}
        onUpdated={async () => {
          await refreshIndex(0);
          if (currentRef.current) await openImage(currentRef.current.document.image.id);
        }} />}
      {(editorOpen || editorBridge.pending > 0) && !guest && <EditorPanel bridge={editorBridge} onClose={() => setEditorOpen(false)} />}
      {sharingOpen && !guest && <LiveSharePanel host={liveHost.current} mode={liveMode} onMode={setLiveMode}
        onStart={() => void perform(startLiveSession)} onStop={() => { stopLiveSession(); setLiveRevision(value => value + 1); }}
        ended={liveEnded} busy={busy} images={imageIndex} onClose={() => setSharingOpen(false)} />}
      {guest && <section className="workspace-card live-share live-guest-bar" aria-label="Live session">
        <p>You are a guest in <strong>{descriptor.name}</strong>. Edits save to the host's workspace; nothing is stored in this browser.</p>
        <ParticipantList participants={participants} images={imageIndex} you={guest.you} />
      </section>}
      {current ? <>
        <div className="editor-toolbar" role="toolbar" aria-label="Edit actions">
          <strong>{activeTool.name}</strong>
          <div className="editor-panel-toggles" aria-label="Editor panels">
            <button type="button" className={`tool-button${imagesPanelOpen ? ' active' : ''}`}
              aria-label="Images panel" aria-expanded={imagesPanelOpen} aria-controls="editor-images-panel"
              onClick={() => setImagesPanelOpen(open => !open)}>Images</button>
            <button type="button" className={`tool-button${inspectorOpen ? ' active' : ''}`}
              aria-label="Properties panel" aria-expanded={inspectorOpen} aria-controls="editor-inspector-panel"
              onClick={() => setInspectorOpen(open => !open)}>Properties</button>
          </div>
          <button type="button" className="tool-button" disabled={busy || !history.current?.canUndo}
            onClick={() => void perform(() => undoRedo('undo'))}>Undo</button>
          <button type="button" className="tool-button" disabled={busy || !history.current?.canRedo}
            onClick={() => void perform(() => undoRedo('redo'))}>Redo</button>
          {tool === 'polygon' && <button type="button" className="tool-button" disabled={busy || polygon.length < 3}
            onClick={() => void finishPolygon()}>Finish polygon</button>}
          {tool === 'polygon' && polygon.length > 0 && <button type="button" className="tool-button"
            onClick={() => {
              const next = polygon.slice(0, -1);
              setPolygon(next);
              setPolygonCursor(next.at(-1) ?? null);
            }}>Remove last vertex</button>}
        </div>
        <div className="editor-viewbar">
          <p className="tool-hint" role="status">{toolHints[tool]}</p>
          <div className="zoom-controls" aria-label="Canvas zoom">
            <button type="button" className="tool-button" aria-label="Zoom out" disabled={view.zoom <= 1}
              onClick={() => zoomBy(0.8)}>-</button>
            <output aria-label="Zoom level">{Math.round(view.zoom * 100)}%</output>
            <button type="button" className="tool-button" aria-label="Zoom in" disabled={view.zoom >= 8}
              onClick={() => zoomBy(1.25)}>+</button>
            <button type="button" className="tool-button" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>Fit image</button>
          </div>
        </div>
        <div className={editorLayoutClass}>
          <nav id="editor-images-panel" className="image-sidebar" aria-label="Dataset image navigation" hidden={!imagesPanelOpen}>
            <div className="list-heading"><strong>Images</strong><span>{total}</span></div>
            <input className="dataset-search" aria-label="Search images" placeholder="Search images"
              value={search} onChange={event => setSearch(event.target.value)} />
            {search && editorMatches.length > 100 && <div className="image-navigation search-pagination">
              <button type="button" disabled={busy || editorResultsPage === 0}
                onClick={() => setEditorSearchPage(editorResultsPage - 1)}>Previous search results</button>
              <span>{editorMatches.length} matches</span>
              <button type="button" disabled={busy || (editorResultsPage + 1) * 100 >= editorMatches.length}
                onClick={() => setEditorSearchPage(editorResultsPage + 1)}>Next search results</button>
            </div>}
            <div className="image-file-list">
              {editorMatches.slice(editorStart, editorStart + 100).map(item => <button key={item.id} type="button"
                className={`image-file${item.id === current.document.image.id ? ' active' : ''}`}
                aria-current={item.id === current.document.image.id ? 'true' : undefined}
                title={item.sourcePath} disabled={busy} onClick={() => void perform(() => openImage(item.id))}>
                <span>{item.name}</span>
                <small>{item.annotationCount} annotations · {item.review.replace('_', ' ')}</small>
              </button>)}
              {total > imageIndex.length && <button type="button" className="text-button" disabled={busy}
                onClick={() => void perform(async () => { await refreshIndex(imageIndex.length); })}>Load more images</button>}
            </div>
          </nav>
          <div className="drawing-tools" role="toolbar" aria-label="Annotation tools" aria-orientation="vertical">
            {toolGroups.filter(group => !guest || group.name !== 'Pixel masks').map(group => <div className="drawing-tool-group" key={group.name}>
              <span className="drawing-tool-group-label">{group.name}</span>
              {group.tools.map(id => {
                const item = tools.find(candidate => candidate.id === id)!;
                return <button key={item.id} type="button"
                  title={`${item.name} (${item.shortcut})`} aria-pressed={tool === item.id} disabled={busy}
                  className={`drawing-tool${tool === item.id ? ' active' : ''}`}
                  onClick={() => chooseTool(item.id)}>
                  <span className="drawing-tool-icon" aria-hidden="true">{item.icon}</span>
                  <span>{item.name}</span><kbd aria-hidden="true">{item.shortcut}</kbd>
                </button>;
              })}
            </div>)}
          </div>
          <div className="canvas-column">
            <div className="canvas-frame">
              <svg ref={svg} className={`annotation-canvas tool-${tool}`}
              viewBox={`${view.x} ${view.y} ${current.document.image.canonical.width / view.zoom} ${current.document.image.canonical.height / view.zoom}`}
              role="img" aria-label={`${current.document.image.name} annotation canvas`}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove}
              onPointerUp={onPointerUp} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}
              onClick={onCanvasClick}>
              <image href={current.url} x="0" y="0" width={current.document.image.canonical.width}
                height={current.document.image.canonical.height} preserveAspectRatio="xMidYMid meet" />
              <g pointerEvents={tool === 'select' ? 'auto' : 'none'}>
              {visibleAnnotations.map(annotation => {
                const selectedStyle = selected === annotation.id ? ' selected-annotation' : '';
                const color = current.document.classes.find(item => item.id === annotation.classId)?.color ?? '#39764d';
                if (annotation.kind === 'box') return <rect key={annotation.id}
                  data-annotation-id={annotation.id}
                  className={`annotation-shape${selectedStyle}`} x={annotation.x} y={annotation.y}
                  width={annotation.width} height={annotation.height} fill={color} fillOpacity=".12"
                  stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />;
                if (annotation.kind === 'polygon') return <polygon key={annotation.id}
                  data-annotation-id={annotation.id}
                  className={`annotation-shape${selectedStyle}`} points={annotation.points.map(point => `${point.x},${point.y}`).join(' ')}
                  fill={color} fillOpacity=".2" stroke={color}
                  strokeWidth="2" vectorEffect="non-scaling-stroke" />;
                if (annotation.kind === 'line') return <g key={annotation.id} data-annotation-id={annotation.id}>
                  <line className="annotation-line-hit" x1={annotation.points[0].x} y1={annotation.points[0].y}
                    x2={annotation.points[1].x} y2={annotation.points[1].y} />
                  <line className={`annotation-line${selectedStyle}`} x1={annotation.points[0].x} y1={annotation.points[0].y}
                    x2={annotation.points[1].x} y2={annotation.points[1].y} stroke={color}
                    strokeWidth="3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                </g>;
                if (annotation.kind === 'mask') return <g key={annotation.id} data-annotation-id={annotation.id}>
                  {annotation.tiles.map(tile => <image key={tile.blobId} className="annotation-mask"
                    href={maskUrls.get(tile.blobId)} x={tile.x} y={tile.y}
                    width={TILE_SIZE} height={TILE_SIZE} style={{ imageRendering: 'pixelated' }} />)}
                </g>;
                if (annotation.kind === 'keypoints') {
                  const skeleton = current.document.skeletons.find(item => item.id === annotation.skeletonId);
                  return <g key={annotation.id} data-annotation-id={annotation.id}>
                  {skeleton?.edges.map(([from, to], index) => {
                    const start = annotation.points[from], end = annotation.points[to];
                    return start && end && start.visibility !== 'absent' && end.visibility !== 'absent'
                      ? <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y}
                        stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                      : null;
                  })}
                  {annotation.points.filter(point => point.visibility !== 'absent').map((point, index) =>
                    <circle key={index} className={`annotation-point${selected === annotation.id ? ' selected-annotation' : ''}`}
                      cx={point.x} cy={point.y} r={handleRadius}
                      fill={color} vectorEffect="non-scaling-stroke" />)}
                  </g>;
                }
                return null;
              })}
              {tool === 'select' && activeShape?.kind === 'box' &&
                (['nw', 'ne', 'sw', 'se'] as const).map(corner =>
                  <circle key={corner} className="edit-handle" data-annotation-id={activeShape.id} data-handle={corner}
                    cx={activeShape.x + (corner.includes('e') ? activeShape.width : 0)}
                    cy={activeShape.y + (corner.includes('s') ? activeShape.height : 0)}
                    r={handleRadius} vectorEffect="non-scaling-stroke" />)}
              {tool === 'select' && (activeShape?.kind === 'polygon' || activeShape?.kind === 'keypoints') &&
                activeShape.points.map((point, index) => 'visibility' in point && point.visibility === 'absent' ? null :
                  <circle key={index} className="edit-handle" data-annotation-id={activeShape.id} data-handle={`point-${index}`}
                    cx={point.x} cy={point.y} r={handleRadius} vectorEffect="non-scaling-stroke" />)}
              {tool === 'select' && activeShape?.kind === 'line' &&
                activeShape.points.map((point, index) =>
                  <circle key={index} className="edit-handle" data-annotation-id={activeShape.id} data-handle={`point-${index}`}
                    cx={point.x} cy={point.y} r={handleRadius} vectorEffect="non-scaling-stroke" />)}
              </g>
              {strokePreview.length > 0 && <polyline points={strokePreview.map(point => `${point.x},${point.y}`).join(' ')}
                fill="none" stroke={tool === 'erase' ? '#b84d3b' : '#39764d'} opacity=".5"
                strokeWidth={brushRadius * 2} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />}
              {boxStart && boxEnd && <rect className="annotation-draft"
                vectorEffect="non-scaling-stroke"
                x={Math.min(boxStart.x, boxEnd.x)} y={Math.min(boxStart.y, boxEnd.y)}
                width={Math.abs(boxEnd.x - boxStart.x)} height={Math.abs(boxEnd.y - boxStart.y)} />}
              {lineStart && lineEnd && <line className="line-draft" x1={lineStart.x} y1={lineStart.y}
                x2={lineEnd.x} y2={lineEnd.y} vectorEffect="non-scaling-stroke" />}
              {polygon.length > 0 && polygonCursor && <>
                {polygon.length >= 3 && <polygon className="polygon-draft-fill"
                  points={[...polygon, polygonCursor].map(point => `${point.x},${point.y}`).join(' ')} />}
                <polyline className="annotation-draft" vectorEffect="non-scaling-stroke"
                  points={[...polygon, polygonCursor].map(point => `${point.x},${point.y}`).join(' ')} />
                {polygon.length >= 3 && <line className="polygon-draft-close" vectorEffect="non-scaling-stroke"
                  x1={polygonCursor.x} y1={polygonCursor.y} x2={polygon[0]!.x} y2={polygon[0]!.y} />}
              </>}
              {polygon.map((point, index) => <circle key={index} cx={point.x} cy={point.y}
                className={index === 0 && polygon.length >= 3 ? 'polygon-close-target' : 'polygon-draft-vertex'}
                r={index === 0 && polygon.length >= 3 ? handleRadius * 0.8 : handleRadius / 2}
                vectorEffect="non-scaling-stroke" pointerEvents="none">
                {index === 0 && polygon.length >= 3 && <title>Click this first point to close the polygon</title>}
              </circle>)}
              </svg>
            </div>
            <div className="image-stepper" aria-label="Image navigation">
              <button type="button" className="tool-button" disabled={busy || imagePosition <= 0}
                aria-label="Previous image" onClick={() => void navigateImage(-1)}>← Previous</button>
              <span>Image {imagePosition + 1} of {total}</span>
              <button type="button" className="tool-button" disabled={busy || imagePosition >= total - 1}
                aria-label="Next image" onClick={() => void navigateImage(1)}>Next →</button>
            </div>
          </div>
          <aside id="editor-inspector-panel" className="annotation-sidebar" hidden={!inspectorOpen}>
            <h2>Labels & annotations</h2>
            <p className="save-indicator" role="status">{notice}</p>
            <label className="review-select">Active class
              <select value={classId} disabled={busy} onChange={event => setClassId(event.target.value)}>
                {current.document.classes.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select>
            </label>
            <p className="panel-help">{tool === 'label'
              ? 'Toggle whole-image labels below. This does not draw on the image.'
              : 'New shapes use the active class. Select an annotation below to edit it.'}</p>
            {(tool === 'mask' || tool === 'erase') && <label>Brush radius (image pixels)
              <input aria-label="Brush radius" type="number" min="1" max="128" value={brushRadius}
                disabled={busy} onChange={event => setBrushRadius(Math.max(1, Math.min(128, Number(event.target.value) || 1)))} />
            </label>}
            {tool === 'label' && <div className="label-list" aria-label="Image labels">
              {current.document.classes.map(item => {
                const active = current.document.annotations.some(annotation =>
                  annotation.kind === 'label' && annotation.classId === item.id);
                return <button key={item.id} type="button" className={active ? 'label-chip active' : 'label-chip'}
                  disabled={busy} onClick={() => addClassification(item.id)}>{active ? '✓ ' : ''}{item.name}</button>;
              })}
            </div>}
            {tool === 'keypoints' && !guest && <form className="add-class-form" onSubmit={event => void addSkeletonPoint(event)}>
              <label htmlFor="new-point">Skeleton points: {current.document.skeletons[0]?.points.join(' · ')}</label>
              <div><input id="new-point" value={newPointName} maxLength={256}
                onChange={event => setNewPointName(event.target.value)} placeholder="Add point name" />
                <button type="submit" disabled={busy || !newPointName.trim()}>Add</button></div>
            </form>}
            {!guest && <form className="add-class-form" onSubmit={event => void addClass(event)}>
              <label htmlFor="new-class">Add a class</label>
              <div><input id="new-class" value={newClass} maxLength={256}
                onChange={event => setNewClass(event.target.value)} placeholder="e.g. vehicle" />
                <button type="submit" disabled={busy || !newClass.trim()}>Add</button></div>
            </form>}
            <p className="panel-help">{guest ? 'Classes are managed by the host.' : 'Classes and skeleton points apply to every image in this workspace.'}</p>
            <div className="annotation-list">
              <div className="list-heading"><strong>Annotations</strong><span>{current.document.annotations.length}</span></div>
              {current.document.annotations.map(annotation => {
                const label = current.document.classes.find(item => item.id === annotation.classId)?.name ?? 'Unknown';
                return <button type="button" key={annotation.id}
                  className={selected === annotation.id ? 'annotation-row active' : 'annotation-row'}
                  onClick={() => { setSelected(annotation.id); chooseTool('select'); }}>{label} · {annotation.kind}</button>;
              })}
              {current.document.annotations.length === 0 && <p className="empty-copy">No annotations yet.</p>}
            </div>
            {selectedAnnotation && <label className="review-select">Selected annotation class
              <select value={selectedAnnotation.classId} disabled={busy || selectedAnnotation.locked} onChange={event => {
                void addAnnotation({ ...selectedAnnotation, classId: event.target.value });
              }}>
                {current.document.classes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>}
            {selectedAnnotation && <fieldset disabled={busy} className="annotation-properties">
              <legend>Instance properties</legend>
              <label><input type="checkbox" checked={selectedAnnotation.visible !== false} disabled={selectedAnnotation.locked}
                onChange={event => void addAnnotation({ ...selectedAnnotation, visible: event.target.checked })} />Visible in editor</label>
              <label><input type="checkbox" checked={selectedAnnotation.locked === true}
                onChange={event => void addAnnotation({ ...selectedAnnotation, locked: event.target.checked })} />Lock annotation</label>
              <p className="panel-help">Visibility affects the editor, not exports. Locking prevents accidental edits; undo can reverse your own actions.</p>
              <label>Attributes (JSON object)
                <textarea aria-label="Annotation attributes" value={attributeText} maxLength={32768}
                  disabled={selectedAnnotation.locked} onChange={event => setAttributeText(event.target.value)} />
              </label>
              <button type="button" disabled={selectedAnnotation.locked} onClick={() => void perform(async () => {
                let attributes: unknown;
                try { attributes = JSON.parse(attributeText); }
                catch { throw new Error('Attributes must be a valid JSON object.'); }
                const parsed = documentSchema.safeParse({ ...current.document, annotations: current.document.annotations.map(
                  item => item.id === selectedAnnotation.id ? { ...item, attributes } : item) });
                if (!parsed.success) throw new Error('Invalid attributes. Use up to 64 non-reserved keys with text, finite numbers, or booleans.');
                await edit({ type: 'put', annotation: parsed.data.annotations.find(item => item.id === selectedAnnotation.id)! });
              })}>Save attributes</button>
              {selectedAnnotation.kind !== 'mask' && selectedAnnotation.kind !== 'label' && <button type="button" disabled={selectedAnnotation.locked}
                onClick={() => void addAnnotation({ ...selectedAnnotation, id: crypto.randomUUID() })}>Duplicate annotation</button>}
            </fieldset>}
            {selectedAnnotation?.kind === 'keypoints' && <fieldset disabled={busy || selectedAnnotation.locked}>
              <legend>Named keypoints</legend>
              <label>Point to place
                <select aria-label="Point to place" value={pointIndex} onChange={event => {
                  setPointIndex(Number(event.target.value)); setTool('keypoints');
                }}>
                  <option value="-1">Next absent point</option>
                  {current.document.skeletons.find(item => item.id === selectedAnnotation.skeletonId)?.points.map((name, index) =>
                    <option key={name} value={index}>{name}</option>)}
                </select>
              </label>
              {selectedAnnotation.points.map((point, index) => <label key={index}>
                {current.document.skeletons.find(item => item.id === selectedAnnotation.skeletonId)?.points[index]} visibility
                <select aria-label={`Point ${index + 1} visibility`} value={point.visibility} onChange={event => {
                  const visibility = event.target.value;
                  if (visibility !== 'absent' && visibility !== 'occluded' && visibility !== 'visible') return;
                  const points: typeof selectedAnnotation.points = selectedAnnotation.points.map((old, i) => i === index ? { ...old, visibility } : old);
                  void addAnnotation({ ...selectedAnnotation, points });
                }}>
                  <option value="absent">Absent</option><option value="occluded">Occluded</option><option value="visible">Visible</option>
                </select>
              </label>)}
            </fieldset>}
            {selectedAnnotation?.kind === 'polygon' && <fieldset disabled={busy || selectedAnnotation.locked}>
              <legend>Polygon vertices</legend>
              <label>Vertex<select aria-label="Polygon vertex" value={vertexIndex} onChange={event => setVertexIndex(Number(event.target.value))}>
                {selectedAnnotation.points.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}
              </select></label>
              <label>New vertex X<input type="number" value={newVertex.x} onChange={event => setNewVertex({ ...newVertex, x: event.target.value })} /></label>
              <label>New vertex Y<input type="number" value={newVertex.y} onChange={event => setNewVertex({ ...newVertex, y: event.target.value })} /></label>
              <button type="button" onClick={() => {
                const points = [...selectedAnnotation.points];
                points.splice(Math.min(vertexIndex + 1, points.length), 0, { x: Number(newVertex.x), y: Number(newVertex.y) });
                void addAnnotation({ ...selectedAnnotation, points });
              }}>Insert vertex after</button>
              <button type="button" disabled={selectedAnnotation.points.length <= 3} onClick={() => {
                const points = selectedAnnotation.points.filter((_, index) => index !== vertexIndex);
                void addAnnotation({ ...selectedAnnotation, points }); setVertexIndex(0);
              }}>Remove vertex</button>
            </fieldset>}
            {selected && <button type="button" className="remove-button" disabled={busy || selectedAnnotation?.locked}
              onClick={() => void perform(() => edit({ type: 'remove', id: selected }))}>Delete selected annotation</button>}
            <label className="review-select">Review
              <select aria-label="Review" value={current.document.review} disabled={busy} onChange={event => {
                const review = event.target.value as AnnotationDocument['review'];
                void perform(() => edit({ type: 'review', review }));
              }}>
                <option value="unannotated">Unannotated</option><option value="in_progress">In progress</option>
                <option value="annotated">Annotated</option><option value="reviewed">Reviewed</option>
              </select>
            </label>
            {!guest && <button type="button" className="remove-button" disabled={busy}
              onClick={() => void removeImage(current.document.image.id)}>Remove image from dataset</button>}
          </aside>
        </div>
      </> : <>
        <nav aria-label="Dataset pages" className="image-navigation">
          <button type="button" disabled={busy || visiblePage === 0} onClick={() => setGalleryPage(visiblePage - 1)}>Previous page</button>
          <span>{filteredImages.length} matching images · Page {visiblePage + 1} of {Math.max(1, Math.ceil(filteredImages.length / 100))}</span>
          <button type="button" disabled={busy || (visiblePage + 1) * 100 >= filteredImages.length}
            onClick={() => setGalleryPage(visiblePage + 1)}>Next page</button>
          <button type="button" disabled={busy || galleryImages.length === 0}
            onClick={() => void perform(() => loadThumbnails(galleryImages))}>Load page previews</button>
        </nav>
        <div className="dataset-overview">
          <div><strong>{total}</strong><span>Images in dataset</span></div>
          <div><strong>{imageIndex.filter(item => item.annotationCount > 0).length}</strong><span>Labeled images</span></div>
          <div><strong>{imageIndex.filter(item => item.review === 'reviewed').length}</strong><span>Reviewed images</span></div>
        </div>
        <div className="dataset-filters">
          <input className="dataset-search" aria-label="Search images" placeholder="Search images"
            value={search} onChange={event => setSearch(event.target.value)} />
          <label>Review status
            <select aria-label="Review status" value={reviewFilter} onChange={event => setReviewFilter(event.target.value)}>
              <option value="all">All images</option><option value="unannotated">Unannotated</option>
              <option value="in_progress">In progress</option><option value="annotated">Annotated</option>
              <option value="reviewed">Reviewed</option>
            </select>
          </label>
        </div>
        {!guest && <>
        <div className="storage-status">
          <span>{storageInfo || 'Checking local storage…'} · {persistentStorage ? 'protected from automatic eviction' : 'may be cleared by the browser'}</span>
          {!persistentStorage && <button type="button" className="text-button" disabled={busy}
            onClick={() => void perform(requestPersistentStorage)}>Keep on this device</button>}
        </div>
        <div className="storage-status offline-status">
          <span>{offlineReady ? 'Offline app shell ready' : 'Offline use is not installed yet'}</span>
          {offlineUpdateWaiting
            ? <button type="button" className="text-button" disabled={busy}
                onClick={() => void perform(applyOfflineUpdate)}>Apply app update</button>
            : <button type="button" className="text-button" disabled={busy}
                onClick={() => void perform(installOfflineShell)}>{offlineReady ? 'Check for app update' : 'Make available offline'}</button>}
        </div>
        {descriptor.passwordProtected && <label>Lock after inactivity
          <select aria-label="Lock after inactivity" value={idleMinutes} onChange={event => setIdleMinutes(Number(event.target.value))}>
            <option value="1">1 minute</option><option value="5">5 minutes</option><option value="15">15 minutes</option>
            <option value="30">30 minutes</option><option value="0">Never (this session)</option>
          </select>
        </label>}
        {descriptor.passwordProtected && <details className="workspace-recovery">
          <summary>Recovery secret</summary>
          <form className="workspace-card" onSubmit={event => {
            event.preventDefault();
            const current = recoveryCurrent; setRecoveryCurrent('');
            void perform(async () => {
              if (!storage.current) throw new Error('Unlock the workspace first.');
              const file = await storage.current.request({ type: 'vault-recovery-create', current }, recoverySecretSchema);
              setRecoveryUrl(URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' })));
              setNotice('New recovery credential created. Download it now. Previous recovery files no longer work.');
            });
          }}>
            <p>Anyone holding this file and the browser storage can decrypt your workspace. Store it separately and securely. Generating another invalidates the previous recovery file, not copies of the data or old vault headers.</p>
            <label>Current passphrase for recovery<input type="password" required minLength={12} maxLength={1024}
              value={recoveryCurrent} disabled={busy} onChange={event => setRecoveryCurrent(event.target.value)} /></label>
            <button type="submit" disabled={busy}>Generate recovery file</button>
            {recoveryUrl && <a href={recoveryUrl} download={`annotator-recovery-${descriptor.id}.json`}>Download recovery file</a>}
          </form>
        </details>}
        {descriptor.passwordProtected && <details className="workspace-rotation">
          <summary>Rotate workspace encryption key</summary>
          <form className="workspace-card" onSubmit={event => void rotateKey(event)}>
            <p>Creates a fresh root key and stages re-encrypted copies of every image, mask, and record before switching atomically. Requires temporary space for a second encrypted dataset. Cancellation or interruption before publication keeps the old key. Existing backups/copied data are not revoked. Recovery files must be regenerated afterward.</p>
            <label>Current rotation passphrase<input type="password" required minLength={12} maxLength={1024} disabled={busy}
              value={rotationSecrets.current} onChange={event => setRotationSecrets({ ...rotationSecrets, current: event.target.value })} /></label>
            <label>New rotation passphrase<input type="password" required minLength={12} maxLength={1024} disabled={busy}
              value={rotationSecrets.next} onChange={event => setRotationSecrets({ ...rotationSecrets, next: event.target.value })} /></label>
            <label>Confirm rotation passphrase<input type="password" required minLength={12} maxLength={1024} disabled={busy}
              value={rotationSecrets.confirmation} onChange={event => setRotationSecrets({ ...rotationSecrets, confirmation: event.target.value })} /></label>
            <button type="submit" disabled={busy}>Rotate encryption key</button>
          </form>
        </details>}
        {rotating && <button type="button" onClick={() => { cancelArchive.current = true; }}>Cancel rotation after current item</button>}
        <div className="workspace-actions">
          <label className="folder-button">Add folder
            <input type="file" multiple accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,.txt,.yaml,.yml"
              {...{ webkitdirectory: '' }} disabled={busy} aria-label="Choose a dataset folder"
              onChange={event => { void importFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
          </label>
          <label className="folder-button">Add images
            <input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy}
              aria-label="Add images" onChange={event => { void importFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
          </label>
          <span>{total} / 10,000 images stored locally</span>
        </div>
        <details className="dataset-schema">
          <summary>Dataset classes and skeletons</summary>
          <div className="workspace-card">
            <p>Shared by every image, including future imports. Removing a used class requires a replacement; annotations are never deleted by a schema migration.</p>
            <ul aria-label="Dataset classes">{datasetSchema.classes.map(item => <li key={item.id}>{item.name}</li>)}</ul>
            <form className="add-class-form" onSubmit={event => void addClass(event)}>
              <label htmlFor="dataset-new-class">Add a class</label>
              <div><input id="dataset-new-class" value={newClass} maxLength={256} disabled={busy}
                onChange={event => setNewClass(event.target.value)} placeholder="e.g. vehicle" />
                <button type="submit" disabled={busy || !newClass.trim()}>Add</button></div>
            </form>
            {datasetSchema.skeletons[0] && <form className="add-class-form" onSubmit={event => void addSkeletonPoint(event)}>
              <label htmlFor="dataset-new-point">Skeleton points: {datasetSchema.skeletons[0].points.join(' · ')}</label>
              <div><input id="dataset-new-point" value={newPointName} maxLength={256} disabled={busy}
                onChange={event => setNewPointName(event.target.value)} placeholder="Add point name" />
                <button type="submit" disabled={busy || !newPointName.trim()}>Add</button></div>
            </form>}
            <form className="workspace-card schema-migration" onSubmit={event => void previewSchemaMigration(event)}>
              <h3>Migrate dataset schema</h3>
              <label>Remove class<select aria-label="Remove class" value={removedClass} disabled={busy} onChange={event => {
                const id = event.target.value;
                setRemovedClass(id); setReplacementClass('');
                if (renamedClass === id) { setRenamedClass(''); setClassNameDraft(''); }
                setMigrationPreview(null);
              }}>
                <option value="">Keep all classes</option>
                {datasetSchema.classes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              {removedClass && <label>Replacement class<select aria-label="Replacement class" value={replacementClass} disabled={busy} onChange={event => {
                setReplacementClass(event.target.value); setMigrationPreview(null);
              }}>
                <option value="">None — removal allowed only if unused</option>
                {datasetSchema.classes.filter(item => item.id !== removedClass).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>}
              <label>Rename class<select aria-label="Rename class" value={renamedClass} disabled={busy}
                onChange={event => {
                  const id = event.target.value;
                  setRenamedClass(id);
                  setClassNameDraft(datasetSchema.classes.find(item => item.id === id)?.name ?? '');
                  setMigrationPreview(null);
                }}>
                <option value="">Keep class names</option>
                {datasetSchema.classes.filter(item => item.id !== removedClass).map(item =>
                  <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              {renamedClass && <label>New class name<input aria-label="New class name" value={classNameDraft}
                maxLength={256} disabled={busy} onChange={event => {
                  setClassNameDraft(event.target.value); setMigrationPreview(null);
                }} /></label>}
              <label>Remove skeleton<select aria-label="Remove skeleton" value={removedSkeleton} disabled={busy}
                onChange={event => {
                  const id = event.target.value;
                  setRemovedSkeleton(id);
                  if (renamedSkeleton === id) { setRenamedSkeleton(''); setSkeletonNameDraft(''); }
                  if (id) setPointDrafts(previous => {
                    const next = { ...previous }; delete next[id]; return next;
                  });
                  setMigrationPreview(null);
                }}>
                <option value="">Keep all skeletons</option>
                {datasetSchema.skeletons.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              <label>Rename skeleton<select aria-label="Rename skeleton" value={renamedSkeleton} disabled={busy}
                onChange={event => {
                  const id = event.target.value;
                  setRenamedSkeleton(id);
                  setSkeletonNameDraft(datasetSchema.skeletons.find(item => item.id === id)?.name ?? '');
                  setMigrationPreview(null);
                }}>
                <option value="">Keep skeleton names</option>
                {datasetSchema.skeletons.filter(item => item.id !== removedSkeleton).map(item =>
                  <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              {renamedSkeleton && <label>New skeleton name<input aria-label="New skeleton name" value={skeletonNameDraft}
                maxLength={256} disabled={busy} onChange={event => {
                  setSkeletonNameDraft(event.target.value); setMigrationPreview(null);
                }} /></label>}
              <p>One point name per line, in the desired order. Surviving names keep their coordinates. Renaming replaces a point name: its old coordinates are discarded, not transferred. Edges between surviving names are preserved. A skeleton used by keypoint annotations cannot be removed.</p>
              {datasetSchema.skeletons.map(item => <label key={item.id}>Point names for {item.name}
                <textarea aria-label={`Point names for ${item.name}`} rows={Math.min(10, item.points.length + 1)}
                  value={pointDrafts[item.id] ?? item.points.join('\n')} disabled={busy} maxLength={65_792}
                  onChange={event => { setPointDrafts(previous => ({ ...previous, [item.id]: event.target.value })); setMigrationPreview(null); }} />
              </label>)}
              <button type="submit" disabled={busy}>Preview schema migration</button>
            </form>
            {migrationPreview && <section aria-label="Schema migration preview" className="workspace-card schema-migration">
              <h3>Schema migration preview</h3>
              <ul aria-label="Schema changes">
                {datasetSchema.classes.flatMap(item => {
                  const next = migrationPreview.schema.classes.find(candidate => candidate.id === item.id);
                  return !next ? [`Class "${item.name}" will be removed${replacementClass ? ` and annotations remapped to "${datasetSchema.classes.find(candidate => candidate.id === replacementClass)?.name ?? 'the selected class'}"` : ''}.`]
                    : next.name !== item.name ? [`Class "${item.name}" will be renamed to "${next.name}".`] : [];
                }).map(change => <li key={change}>{change}</li>)}
                {datasetSchema.skeletons.flatMap(item => {
                  const next = migrationPreview.schema.skeletons.find(candidate => candidate.id === item.id);
                  if (!next) return [`Skeleton "${item.name}" will be removed.`];
                  const changes = next.name !== item.name ? [`Skeleton "${item.name}" will be renamed to "${next.name}".`] : [];
                  if (JSON.stringify(item.points) !== JSON.stringify(next.points)) {
                    changes.push(`Skeleton "${item.name}" points will be ${next.points.join(' · ')}.`);
                  }
                  return changes;
                }).map(change => <li key={change}>{change}</li>)}
              </ul>
              <p>{migrationPreview.discardedCoordinates} point coordinates will be discarded from {migrationPreview.affectedAnnotations} annotations across {migrationPreview.images.length} images. Absent placeholders with zero coordinates are not counted.</p>
              <ul aria-label="Affected annotation counts">{migrationPreview.images.map(item => <li key={item.id}>
                {item.name}: {item.affectedAnnotations} annotations, {item.discardedCoordinates} point coordinates
              </li>)}</ul>
              {migrationPreview.discardedCoordinates > 0 && <label><input type="checkbox" checked={confirmDiscard} disabled={busy}
                onChange={event => setConfirmDiscard(event.target.checked)} />I confirm discarding these point coordinates</label>}
              <button type="button" disabled={busy || (migrationPreview.discardedCoordinates > 0 && !confirmDiscard)}
                onClick={() => void applySchemaMigration()}>Apply schema migration</button>
              <button type="button" disabled={busy} onClick={() => void perform(async () => {
                if (!storage.current) return;
                await storage.current.request({ type: 'schema-cancel', token: migrationPreview.token }, archiveFinishedSchema);
                setMigrationPreview(null); setConfirmDiscard(false);
              })}>Cancel schema migration</button>
            </section>}
          </div>
        </details>
        {total > 0 && <details className="annotation-import">
          <summary>Import annotations</summary>
          <div className="workspace-card">
            <p>Match existing images by unique filename (or native image ID). All selected files are validated and staged before one atomic replacement. Image pixels and source folders are unchanged. A failed import publishes nothing.</p>
            <label>Annotation import format<select aria-label="Annotation import format" value={importFormat} disabled={busy} onChange={event => {
              const value = event.target.value;
              if (value === 'native' || value === 'coco' || value === 'voc' || value === 'yolo' || value === 'yolo-seg') setImportFormat(value);
            }}>
              <option value="native">Native JSON + mask sidecars</option><option value="coco">COCO JSON (uncompressed RLE)</option>
              <option value="voc">Pascal VOC boxes</option><option value="yolo">YOLO detection</option><option value="yolo-seg">YOLO segmentation polygons</option>
            </select></label>
            <p className="panel-help">Native preserves instance properties, attributes, and review. Training formats preserve supported geometry/classes only; COCO compressed RLE and multipart polygons are rejected, not silently converted. VOC uses enclosing integer boxes; YOLO class order comes from selected data.yaml or the current dataset class list.</p>
            <label><input type="checkbox" checked={replaceAnnotations} disabled={busy} onChange={event => setReplaceAnnotations(event.target.checked)} />
              Replace annotations on matched images (make an encrypted backup first)</label>
            <label className="folder-button">Choose annotation files<input type="file" multiple accept=".json,.xml,.txt,.yaml,.yml,.bin"
              aria-label="Choose annotation files" disabled={busy || !replaceAnnotations}
              onChange={event => { void importAnnotations(event.currentTarget.files); event.currentTarget.value = ''; }} /></label>
            <label className="folder-button">Choose annotation folder<input type="file" multiple {...{ webkitdirectory: '' }}
              aria-label="Choose annotation folder" disabled={busy || !replaceAnnotations}
              onChange={event => { void importAnnotations(event.currentTarget.files); event.currentTarget.value = ''; }} /></label>
          </div>
        </details>}
        {total === 0 && <label className="workspace-dropzone" onDragOver={event => event.preventDefault()}
          onDrop={event => {
            event.preventDefault();
            if (busy) return;
            if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry()?.isDirectory)) {
              setError('Choose Add folder to import a directory and its annotations. Drag and drop accepts image files.');
              return;
            }
            void importFiles(event.dataTransfer.files);
          }}>
          <span className="upload-icon" aria-hidden="true">↑</span>
          <strong>Drop images here</strong>
          <span>or click to select files</span>
          <small>Use Add folder for a complete dataset with annotations.</small>
          <input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy} aria-label="Select workspace images"
            onChange={event => { void importFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
        </label>}
        <label className="export-disclosure"><input type="checkbox" checked={resumeIntake} disabled={busy}
          onChange={event => setResumeIntake(event.target.checked)} />Resume intake: skip exact source inputs already saved</label>
        <p className="export-disclosure">To resume after cancellation or reload, enable Resume intake and reselect the original files/folder. Encrypted per-image checkpoints bind source bytes, relative path, and input labels/classes; edited annotations are not overwritten. Older imports and restored backups without checkpoints cannot be skipped automatically. Import reads YOLOv8 detection labels when data.yaml and matching labels/ files are present.</p>
        {progress && <div className="import-progress" role="status">{progress}
          <button type="button" className="text-button" onClick={() => { cancelImport.current = true; }}>Cancel</button>
        </div>}
        <details className="workspace-security" onToggle={event => {
          if (!event.currentTarget.open) setVaultSecrets({ current: '', next: '', confirmation: '' });
        }}>
          <summary>Workspace security</summary>
          {!descriptor.passwordProtected && <div className="workspace-card">
            <h2>No password protection</h2>
            <p>This workspace opens automatically in this browser profile. Its local key is stored on this device and does not protect against someone with access to this profile. Create a password-protected workspace and use encrypted backup/restore to move data into it.</p>
          </div>}
          {descriptor.passwordProtected && <form className="workspace-card" onSubmit={event => void changePassphrase(event)}>
            <h2>Change workspace passphrase</h2>
            <p>This protects the existing data key with a new passphrase. It does not rotate that key or change existing backup passphrases. Without your passphrase or an enabled recovery file, the app cannot reset access.</p>
            <label>Current workspace passphrase
              <input type="password" autoComplete="current-password" required minLength={12} maxLength={1024} disabled={busy}
                value={vaultSecrets.current} onChange={event => setVaultSecrets({ ...vaultSecrets, current: event.target.value })} />
            </label>
            <label>New workspace passphrase
              <input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} disabled={busy}
                value={vaultSecrets.next} onChange={event => setVaultSecrets({ ...vaultSecrets, next: event.target.value })} />
            </label>
            <label>Confirm new workspace passphrase
              <input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} disabled={busy}
                value={vaultSecrets.confirmation} onChange={event => setVaultSecrets({ ...vaultSecrets, confirmation: event.target.value })} />
            </label>
            <button type="submit" disabled={busy}>Change passphrase</button>
          </form>}
        </details>
        </>}
        <div className="workspace-gallery" role="list" aria-label="Workspace images">
          {galleryImages.map(item => <article className="gallery-item" role="listitem" key={item.id}>
            <button type="button" className="gallery-open" title={item.sourcePath} disabled={busy}
              onClick={() => void perform(() => openImage(item.id))}>
              {thumbnailUrls.has(item.id) && <img className="gallery-thumbnail" src={thumbnailUrls.get(item.id)} alt="" />}
              <span className="gallery-name">{item.name}</span>
              {(liveHost.current?.participants ?? participants).filter(person => person.imageId === item.id).length > 0 &&
                <span className="live-viewers" aria-label={`Viewing: ${(liveHost.current?.participants ?? participants)
                  .filter(person => person.imageId === item.id).map(person => person.name).join(', ')}`}>
                  {(liveHost.current?.participants ?? participants).filter(person => person.imageId === item.id)
                    .map(person => <span key={person.id} className="live-dot" style={{ background: person.color }} title={person.name} />)}
                </span>}
              <span className="gallery-path">{item.sourcePath} · {item.split}</span>
              <span>{item.width} × {item.height}</span>
              <span>{item.annotationCount} annotations · {item.review.replace('_', ' ')}</span>
            </button>
            {!guest && <button type="button" className="gallery-remove" disabled={busy}
              aria-label={`Remove ${item.name} from dataset`} onClick={() => void removeImage(item.id)}>Remove</button>}
          </article>)}
          {imageIndex.length > 0 && filteredImages.length === 0 && <p className="empty-copy">No images match these filters.</p>}
        </div>
        {total > imageIndex.length && <button type="button" className="text-button"
          onClick={() => void perform(async () => { await refreshIndex(imageIndex.length); })}>Load more</button>}
      </>}
    </>}

    <dialog ref={exportDialog} className="export-dialog" aria-label="Export dataset"
      onCancel={event => { if (busy) event.preventDefault(); else setExportOpen(false); }}>
      <form onSubmit={event => { event.preventDefault(); void exportDataset(); }}>
        <h2 id="export-title">Export dataset</h2>
        <p>Choose a training format or preserve mixed annotations with Native JSON or CSV.</p>
        <label>Export format
          <select aria-label="Export format" value={format} disabled={busy} onChange={event => setFormat(exportFormat(event.target.value))}>
            {exportFormats.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <p className="format-description">{exportFormats.find(item => item.id === format)!.detail}</p>
        <label>Export scope
          <select aria-label="Export scope" value={exportCurrent ? 'current' : 'all'} disabled={busy} onChange={event => setExportCurrent(event.target.value === 'current')}>
            <option value="all">Entire dataset ({total} images, regardless of search filters)</option>
            {current && <option value="current">Current image only</option>}
          </select>
        </label>
        <label className="export-checkbox"><input type="checkbox" checked={exportImages} disabled={busy}
          onChange={event => setExportImages(event.target.checked)} /> Include sanitized PNG images</label>
        <p className="export-warning">Exports are unencrypted copies. Unsupported annotation types stop the export before files are created. Training formats do not preserve all editor metadata; Native JSON does. In annotations-only mode, image paths refer to the PNG names in export-manifest.json. Interrupted writes can leave a partial new folder.</p>
        {error && <div className="error" role="alert">{error}</div>}
        {busy && <p role="status">{progress || 'Preparing export…'}</p>}
        <div className="dialog-actions">
          <button type="button" className="tool-button" disabled={busy} onClick={() => setExportOpen(false)}>Cancel</button>
          <button type="submit" className="tool-button primary-action" disabled={busy}>Choose destination & export</button>
        </div>
      </form>
    </dialog>
    <dialog ref={archiveDialog} className="export-dialog" aria-label={archiveMode === 'restore' ? 'Restore encrypted backup' : 'Create encrypted backup'}
      onCancel={event => { if (busy) event.preventDefault(); else { setArchiveMode(null); setArchivePassphrase(''); setArchiveConfirmation(''); } }}>
      <form onSubmit={event => { event.preventDefault(); void runArchive(); }}>
        <h2>{archiveMode === 'restore' ? 'Restore encrypted backup' : 'Create encrypted backup'}</h2>
        <p>{archiveMode === 'restore'
          ? 'Select a complete backup folder containing backup.json. Every image and annotation is authenticated and staged before the dataset becomes visible. Restore requires an empty workspace; it never overwrites existing images.'
          : 'Save encrypted images, classes, skeletons, annotations, source paths, and review state in a new backup folder. This backs up the dataset, not developer proof records. A separate backup key is protected by the passphrase below.'}</p>
        <label>Backup passphrase
          <input aria-label="Backup passphrase" type="password" autoComplete="new-password" required minLength={12} maxLength={1024}
            disabled={busy} value={archivePassphrase} onChange={event => setArchivePassphrase(event.target.value)} />
        </label>
        {archiveMode === 'backup' && <label>Confirm backup passphrase
          <input aria-label="Confirm backup passphrase" type="password" autoComplete="new-password" required minLength={12} maxLength={1024}
            disabled={busy} value={archiveConfirmation} onChange={event => setArchiveConfirmation(event.target.value)} />
        </label>}
        <p className="export-warning">{archiveMode === 'restore'
          ? 'Use the passphrase set when this backup was created, not necessarily your current workspace passphrase. Restored data is encrypted again under the current workspace key.'
          : 'Use at least 12 characters. There is no password reset. Store the folder and passphrase safely outside this browser profile. Incomplete or cancelled backups are not restorable.'}</p>
        {error && <div className="error" role="alert">{error}</div>}
        {busy && <p role="status">{progress || 'Working locally…'}</p>}
        <div className="dialog-actions">
          <button type="button" className="tool-button" onClick={() => {
            if (busy) cancelArchive.current = true;
            else { setArchiveMode(null); setArchivePassphrase(''); setArchiveConfirmation(''); }
          }}>{busy ? 'Cancel after current image' : 'Cancel'}</button>
          <button type="submit" className="tool-button primary-action" disabled={busy}>
            {archiveMode === 'restore' ? 'Choose backup folder & restore' : 'Choose destination & back up'}
          </button>
        </div>
      </form>
    </dialog>
    {cloudVisionOpen && current && !guest && <Suspense fallback={<p role="status">Loading cloud vision controls…</p>}><CloudVisionDialog
      imageUrl={current.url}
      imageSize={current.document.image.canonical}
      onClose={() => setCloudVisionOpen(false)}
      onAccept={addCloudSuggestions}
    /></Suspense>}
    {error && !exportOpen && !archiveMode && <div className="error" role="alert">{error}</div>}
    {notice && !current && <p className="workspace-notice" role="status">{notice}</p>}
    {busy && <p className="workspace-notice" role="status">Working locally…</p>}
  </section>;
}

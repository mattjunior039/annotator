import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  annotateResult, getAnnotationsResult, JOB_TTL, jobKinds, listImagesResult, pollResponse, viewImagesResult,
} from '../../services/bridge/protocol';
import type { AnnotateInput, JobKind, Scope } from '../../services/bridge/protocol';
import { editorConnections } from './editor-connection';
import type { EditorConnection } from './editor-connection';

type ListResult = z.infer<typeof listImagesResult>;
type AnnotationsResult = z.infer<typeof getAnnotationsResult>;
type AnnotateResult = z.infer<typeof annotateResult>;
export interface ImageForEditor { id: string; name: string; width: number; height: number; png: ArrayBuffer }
export interface AppliedBatch { result: AnnotateResult; summary: string; undo: () => Promise<string> }
export interface EditorBridgeHandlers {
  list(args: z.infer<typeof jobKinds.list.input>): ListResult;
  annotations(ids: readonly string[]): Promise<AnnotationsResult>;
  images(ids: readonly string[]): Promise<ImageForEditor[]>;
  preview(input: AnnotateInput): Promise<string[]>;
  apply(input: AnnotateInput): Promise<AppliedBatch>;
}
export class EditorRequestError extends Error {
  readonly code: 'declined' | 'stale' | 'invalid' | 'failed';
  constructor(code: EditorRequestError['code'], message: string) { super(message); this.code = code; }
}
export interface ImageRequest { id: string; images: { id: string; name: string; url: string }[] }
export interface ReviewRequest { id: string; lines: string[] }
export interface Activity { id: string; at: number; text: string; undo?: () => Promise<string>; undone?: boolean }
export type BridgeStatus =
  | { state: 'idle'; message?: string }
  | { state: 'waiting'; code: string; expiresAt: number }
  | { state: 'connected'; scopes: Scope[]; expiresAt: number };

const pairStart = z.strictObject({ code: z.string().regex(/^\d{6}$/), ticket: z.string(), expiresAt: z.number() });
const pairState = z.union([
  z.strictObject({ state: z.literal('pending'), expiresAt: z.number() }),
  z.strictObject({ state: z.literal('paired'), bearer: z.string().min(40).max(100), expiresAt: z.number(), scopes: z.array(z.enum(['metadata', 'pixels', 'propose'])) }),
]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function send(url: string, path: '/pair' | '/message', value: unknown, bearer?: string): Promise<unknown> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers, body: JSON.stringify(value), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(0, 'The local companion is not reachable. Start the annotator MCP server in your editor, and allow local network access if the browser asks.');
  }
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new HttpError(response.status, 'The local companion response is too large.');
  let result: unknown;
  try { result = JSON.parse(text); } catch { throw new HttpError(response.status, 'The local companion returned invalid JSON.'); }
  if (!response.ok) {
    const code = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new HttpError(response.status, `Local companion request failed (${code}).`);
  }
  return result;
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function encodeForEditor(image: ImageForEditor, maxSize: number) {
  const bitmap = await createImageBitmap(new Blob([image.png], { type: 'image/png' }));
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
    if (!context) throw new Error('Image encoding requires a 2D canvas.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return { id: image.id, width: image.width, height: image.height, sentWidth: width, sentHeight: height,
      mimeType: 'image/jpeg' as const, data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
  } finally { bitmap.close(); }
}

export function useEditorBridge(workspaceId: string, handlers: EditorBridgeHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [editor, setEditorState] = useState<EditorConnection>('copilot');
  const [status, setStatus] = useState<BridgeStatus>({ state: 'idle' });
  const [autoApply, setAutoApply] = useState(false);
  const [autoShare, setAutoShare] = useState(false);
  const [imageRequests, setImageRequests] = useState<ImageRequest[]>([]);
  const [reviews, setReviews] = useState<ReviewRequest[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const settings = useRef({ autoApply, autoShare });
  settings.current = { autoApply, autoShare };
  const session = useRef<{ url: string; bearer: string; active: boolean } | null>(null);
  const pairing = useRef<{ cancelled: boolean } | null>(null);
  const decisions = useRef(new Map<string, (allow: boolean) => void>());
  const editorName = editorConnections.find(item => item.id === editor)!.name;
  const nameRef = useRef(editorName);
  nameRef.current = editorName;

  const log = (text: string, undo?: Activity['undo']) => setActivity(previous => [
    { id: crypto.randomUUID(), at: Date.now(), text, ...(undo ? { undo } : {}) }, ...previous].slice(0, 50));

  function decide(id: string, allow: boolean) {
    decisions.current.get(id)?.(allow);
    decisions.current.delete(id);
  }
  // Expire just before the companion gives up, so stale prompts never linger.
  function waitForDecision(id: string) {
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => decide(id, false), JOB_TTL - 10_000);
      decisions.current.set(id, allow => { clearTimeout(timer); resolve(allow); });
    });
  }
  function dropDecisions() {
    for (const resolve of decisions.current.values()) resolve(false);
    decisions.current.clear();
    setImageRequests(previous => { for (const request of previous) for (const image of request.images) URL.revokeObjectURL(image.url); return []; });
    setReviews([]);
  }

  async function run(kind: JobKind, args: unknown): Promise<unknown> {
    const name = nameRef.current;
    switch (kind) {
      case 'list': return handlersRef.current.list(jobKinds.list.input.parse(args));
      case 'annotations': {
        const { imageIds } = jobKinds.annotations.input.parse(args);
        const result = await handlersRef.current.annotations(imageIds);
        log(`${name} read annotations of ${imageIds.length} image${imageIds.length === 1 ? '' : 's'}.`);
        return result;
      }
      case 'images': {
        const { imageIds, maxSize } = jobKinds.images.input.parse(args);
        const images = await handlersRef.current.images(imageIds);
        if (!settings.current.autoShare) {
          const id = crypto.randomUUID();
          const request = { id, images: images.map(image => ({ id: image.id, name: image.name,
            url: URL.createObjectURL(new Blob([image.png], { type: 'image/png' })) })) };
          setImageRequests(previous => [...previous, request]);
          const allowed = await waitForDecision(id);
          setImageRequests(previous => previous.filter(item => item.id !== id));
          for (const image of request.images) URL.revokeObjectURL(image.url);
          if (!allowed) {
            log(`Declined ${name}'s request to view ${images.length} image${images.length === 1 ? '' : 's'}.`);
            throw new EditorRequestError('declined', 'The user declined to share these images.');
          }
        }
        const encoded = [];
        for (const image of images) encoded.push(await encodeForEditor(image, maxSize ?? 1024));
        log(`Shared ${images.length} image${images.length === 1 ? '' : 's'} with ${name}.`);
        return viewImagesResult.parse({ images: encoded });
      }
      case 'annotate': {
        const input = jobKinds.annotate.input.parse(args);
        if (!settings.current.autoApply) {
          const id = crypto.randomUUID();
          const lines = await handlersRef.current.preview(input);
          setReviews(previous => [...previous, { id, lines }]);
          const approved = await waitForDecision(id);
          setReviews(previous => previous.filter(item => item.id !== id));
          if (!approved) {
            log(`Rejected ${name}'s proposed edits.`);
            return { state: 'rejected', createdClasses: [], images: [] };
          }
        }
        const batch = await handlersRef.current.apply(input);
        log(`${name}: ${batch.summary}${settings.current.autoApply ? ' (applied automatically)' : ''}`, batch.undo);
        return batch.result;
      }
    }
  }

  async function handle(url: string, bearer: string, job: { id: string; kind: JobKind; args: unknown }) {
    let message: unknown;
    try {
      message = { type: 'result', jobId: job.id, ok: true, value: await run(job.kind, job.args) };
    } catch (failure) {
      const error = failure instanceof EditorRequestError ? failure.code : failure instanceof z.ZodError ? 'invalid' : 'failed';
      const text = failure instanceof Error ? failure.message.slice(0, 500) : 'The request failed.';
      message = { type: 'result', jobId: job.id, ok: false, error, message: text };
      if (error !== 'declined') log(`${nameRef.current}'s request failed: ${text}`);
    }
    if (session.current?.active && session.current.bearer === bearer) await send(url, '/message', message, bearer).catch(() => {});
  }

  async function loop(current: { url: string; bearer: string; active: boolean }) {
    let failures = 0;
    while (current.active) {
      try {
        const response = pollResponse.parse(await send(current.url, '/message', { type: 'poll' }, current.bearer));
        failures = 0;
        for (const job of response.jobs) void handle(current.url, current.bearer, job);
      } catch (failure) {
        if (!current.active) return;
        if (failure instanceof HttpError && failure.status === 403) {
          finish('The editor ended the connection. Click Connect to pair again.'); return;
        }
        if (++failures >= 8) { finish('The local companion stopped responding. Restart it in your editor, then connect again.'); return; }
      }
      await sleep(600);
    }
  }

  function finish(message?: string) {
    if (session.current) session.current.active = false;
    session.current = null;
    dropDecisions();
    setStatus(message ? { state: 'idle', message } : { state: 'idle' });
  }

  async function connect(scopes: Scope[]) {
    if (status.state !== 'idle') return;
    const url = `http://127.0.0.1:${editorConnections.find(item => item.id === editor)!.port}`;
    const attempt = { cancelled: false };
    pairing.current = attempt;
    try {
      const start = pairStart.parse(await send(url, '/pair', { type: 'pair-request', workspaceId, scopes }));
      setStatus({ state: 'waiting', code: start.code, expiresAt: start.expiresAt });
      while (!attempt.cancelled) {
        await sleep(800);
        if (attempt.cancelled) return;
        const result = pairState.parse(await send(url, '/pair', { type: 'pair-check', ticket: start.ticket }));
        if (result.state === 'paired') {
          const current = { url, bearer: result.bearer, active: true };
          session.current = current;
          setStatus({ state: 'connected', scopes: result.scopes, expiresAt: result.expiresAt });
          log(`Connected to ${nameRef.current}.`);
          void loop(current);
          return;
        }
      }
    } catch (failure) {
      if (attempt.cancelled) return;
      setStatus({ state: 'idle', message: failure instanceof HttpError && failure.status === 403
        ? 'The code expired or was replaced. Click Connect to get a new code.'
        : failure instanceof Error ? failure.message : 'Unable to connect.' });
    } finally { if (pairing.current === attempt) pairing.current = null; }
  }

  function cancelPairing() {
    if (pairing.current) pairing.current.cancelled = true;
    setStatus({ state: 'idle' });
  }

  async function disconnect() {
    const current = session.current;
    finish();
    if (current) await send(current.url, '/message', { type: 'revoke' }, current.bearer).catch(() => {});
    log('Disconnected.');
  }

  async function undo(item: Activity) {
    if (!item.undo || item.undone) return;
    try {
      const message = await item.undo();
      setActivity(previous => previous.map(entry => entry.id === item.id ? { ...entry, undone: true } : entry));
      log(message);
    } catch (failure) { log(failure instanceof Error ? failure.message : 'Undo failed.'); }
  }

  useEffect(() => () => {
    if (pairing.current) pairing.current.cancelled = true;
    const current = session.current;
    if (current) {
      current.active = false;
      void send(current.url, '/message', { type: 'lock' }, current.bearer).catch(() => {});
    }
    for (const resolve of decisions.current.values()) resolve(false);
  }, []);

  return {
    editor, editorName, setEditor: (value: EditorConnection) => { if (status.state === 'idle') setEditorState(value); },
    status, connect, cancelPairing, disconnect,
    autoApply, setAutoApply, autoShare, setAutoShare,
    imageRequests, reviews, decide, activity, undo,
    pending: imageRequests.length + reviews.length,
  };
}
export type EditorBridge = ReturnType<typeof useEditorBridge>;

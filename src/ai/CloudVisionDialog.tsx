import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { z } from 'zod';
import {
  buildRedactedPng, detectionsSchema, detectionsToBoxes, requestCloudDetections,
  type PixelCrop, type Redaction, type SuggestedBox,
} from './cloud-vision';
import { visionProviders } from './providers';

const localResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('progress'), message: z.string().max(200) }),
  z.strictObject({ type: z.literal('error'), message: z.string().max(500) }),
  z.strictObject({ type: z.literal('result'), detections: detectionsSchema }),
]);
const modelRevision = '936f90b6a476c6da4dfe053fc521af55285976ba';

interface CloudVisionDialogProps {
  imageUrl: string;
  imageSize: { width: number; height: number };
  onClose: () => void;
  onAccept: (suggestions: readonly SuggestedBox[]) => Promise<void>;
}

function boundedCrop(size: { width: number; height: number }): PixelCrop {
  const width = Math.min(size.width, 2000);
  return { x: 0, y: 0, width, height: Math.min(size.height, Math.floor(4_000_000 / width)) };
}

export function CloudVisionDialog({ imageUrl, imageSize, onClose, onAccept }: CloudVisionDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const localWorker = useRef<Worker | null>(null);
  const [crop, setCrop] = useState<PixelCrop>(() => boundedCrop(imageSize));
  const [redactionDraft, setRedactionDraft] = useState({ x: '', y: '', width: '', height: '' });
  const [redactions, setRedactions] = useState<Redaction[]>([]);
  const [previewUrl, setPreviewUrl] = useState('');
  const [preparedImage, setPreparedImage] = useState<Blob | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [provider, setProvider] = useState('custom');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState('Find the visible objects in this crop.');
  const [consent, setConsent] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedBox[]>([]);
  const [inferenceComplete, setInferenceComplete] = useState(false);
  const [suggestionSource, setSuggestionSource] = useState<'local' | 'cloud' | null>(null);
  const [modelConsent, setModelConsent] = useState(false);
  const [modelBackend, setModelBackend] = useState<'wasm' | 'webgpu'>('wasm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modelProgress, setModelProgress] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      controller.current?.abort();
      localWorker.current?.terminate();
      localWorker.current = null;
      dialog.current?.close();
    };
  }, []);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function invalidatePreview() {
    setPreparedImage(null);
    setPreviewUrl('');
    setSuggestions([]);
    setInferenceComplete(false);
    setSuggestionSource(null);
    setError('');
    setConsent(false);
  }

  function updateCrop(field: keyof PixelCrop, value: string) {
    invalidatePreview();
    setCrop(previous => ({ ...previous, [field]: value === '' ? 0 : Number(value) }));
  }

  function addRedaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invalidatePreview();
    const value: Redaction = {
      x: Number(redactionDraft.x), y: Number(redactionDraft.y),
      width: Number(redactionDraft.width), height: Number(redactionDraft.height),
    };
    setRedactions(previous => [...previous, value]);
    setRedactionDraft({ x: '', y: '', width: '', height: '' });
  }

  async function preparePreview() {
    setBusy(true);
    invalidatePreview();
    try {
      const selectedCrop = crop;
      const image = new Image();
      image.src = imageUrl;
      await image.decode();
      const canvas = buildRedactedPng(image, imageSize, selectedCrop, redactions);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        result => result ? resolve(result) : reject(new Error('The redacted PNG preview could not be created.')),
        'image/png',
      ));
      const url = URL.createObjectURL(blob);
      setPreparedImage(blob);
      setPreviewUrl(url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to prepare the local redacted preview.');
    } finally { setBusy(false); }
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preparedImage || !consent) return;
    setBusy(true);
    setError('');
    setSuggestions([]);
    setInferenceComplete(false);
    const active = new AbortController();
    controller.current = active;
    try {
      const result = await requestCloudDetections({
        endpoint, model, apiKey, prompt, image: preparedImage, signal: active.signal,
      });
      setSuggestions(detectionsToBoxes(result, crop));
      setSuggestionSource('cloud');
      setInferenceComplete(true);
    } catch (failure) {
      if (!active.signal.aborted) setError(failure instanceof Error ? failure.message : 'Cloud vision request failed.');
    } finally {
      if (controller.current === active) controller.current = null;
      setBusy(false);
      setConsent(false);
    }
  }

  async function runLocalDetector() {
    if (!preparedImage || !modelConsent) return;
    setBusy(true);
    setError('');
    setModelProgress('');
    setSuggestions([]);
    setInferenceComplete(false);
    setSuggestionSource(null);
    let worker: Worker | null = null;
    try {
      const configuredOrigins = (import.meta.env.VITE_MODEL_ORIGINS as string | undefined ?? '')
        .split(',').map(value => value.trim()).filter(Boolean);
      if (!configuredOrigins.includes('https://huggingface.co')) {
        throw new Error('Local model download is disabled. Configure VITE_MODEL_ORIGINS with https://huggingface.co and matching deployment CSP origins.');
      }
      worker = new Worker(new URL('./local-model.worker.ts', import.meta.url), { type: 'module' });
      localWorker.current = worker;
      const detections = await new Promise<z.infer<typeof detectionsSchema>>((resolve, reject) => {
        worker!.onmessage = event => {
          const parsed = localResponseSchema.safeParse(event.data);
          if (!parsed.success) { reject(new Error('The local model worker returned an invalid response.')); return; }
          if (parsed.data.type === 'progress') setModelProgress(parsed.data.message);
          else if (parsed.data.type === 'error') reject(new Error(parsed.data.message));
          else resolve(parsed.data.detections);
        };
        worker!.onerror = () => reject(new Error('The local model worker failed. The model may be unsupported on this device.'));
        worker!.postMessage({ image: preparedImage, backend: modelBackend });
      });
      setSuggestions(detectionsToBoxes(detections, crop));
      setSuggestionSource('local');
      setInferenceComplete(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Local object detection failed.');
    } finally {
      worker?.terminate();
      if (localWorker.current === worker) localWorker.current = null;
      setBusy(false);
      setModelProgress('');
    }
  }

  async function acceptSuggestions() {
    setBusy(true);
    setError('');
    try {
      await onAccept(suggestions);
      setApiKey('');
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Suggestions could not be added.');
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="export-dialog cloud-vision-dialog" aria-label="AI suggestions"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading">
      <div><h2>AI suggestions</h2><p>Local inference stays in this browser. Cloud inference requires separate consent.</p></div>
      <button type="button" className="tool-button" aria-label="Close AI suggestions" disabled={busy} onClick={onClose}>×</button>
    </div>
    <div className="cloud-vision-fields">
      <fieldset>
        <legend>Choose the exact local crop (image pixels)</legend>
        {(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>
          {field}
          <input type="number" min={field === 'width' || field === 'height' ? 1 : 0} step="1"
            value={crop[field]} disabled={busy} onChange={event => updateCrop(field, event.target.value)} />
        </label>)}
        <p>A crop is limited to 4 megapixels. Coordinates are relative to the sanitized image.</p>
      </fieldset>
      <fieldset>
        <legend>Opaque redactions (image pixels)</legend>
        <form onSubmit={addRedaction} className="cloud-redaction-form">
          {(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>
            {field}
            <input type="number" min={field === 'width' || field === 'height' ? 1 : 0} step="1" required
              value={redactionDraft[field]} disabled={busy}
              onChange={event => setRedactionDraft(previous => ({ ...previous, [field]: event.target.value }))} />
          </label>)}
          <button type="submit" className="tool-button" disabled={busy}>Add black rectangle</button>
        </form>
        {redactions.length > 0 && <ul aria-label="Opaque redactions">{redactions.map((item, index) =>
          <li key={`${item.x}:${item.y}:${item.width}:${item.height}:${index}`}>
            Rectangle {index + 1}: {item.x}, {item.y}, {item.width} × {item.height}
            <button type="button" className="tool-button" disabled={busy} onClick={() => {
              invalidatePreview();
              setRedactions(previous => previous.filter((_, position) => position !== index));
            }}>Remove</button>
          </li>)}</ul>}
        <p>Black rectangles are irreversible in the PNG preview. Visual inspection is still required.</p>
      </fieldset>
      <button type="button" className="tool-button primary-action" disabled={busy} onClick={() => void preparePreview()}>
        Prepare local preview
      </button>
      {previewUrl && <figure>
        <img src={previewUrl} alt="Exact crop prepared locally with opaque black redactions" />
        <figcaption>This exact flattened PNG is used for local or cloud inference. It is sent to a provider only after separate cloud consent.</figcaption>
      </figure>}
      {previewUrl && <section className="local-model-consent" aria-label="Local object detector">
        <h3>Run a local object detector</h3>
        <p>This downloads a pinned 20.9 MB Apache-2.0 model once from Hugging Face. It is cached by the browser. The crop remains local; WASM inference is the default. Model: RT-DETR v2 R18vd, revision <code>{modelRevision}</code>.</p>
        <p><a href={`https://huggingface.co/onnx-community/rtdetr_v2_r18vd-ONNX/tree/${modelRevision}`}
          target="_blank" rel="noreferrer noopener">Inspect the model card, license and files</a></p>
        <label className="protection-choice"><input type="checkbox" checked={modelConsent} disabled={busy}
          onChange={event => setModelConsent(event.target.checked)} />
          I accept the model license and authorize this explicit model download. The browser may cache public model weights.</label>
        <label>Inference backend
          <select value={modelBackend} disabled={busy} onChange={event => {
            if (event.target.value === 'wasm' || event.target.value === 'webgpu') setModelBackend(event.target.value);
          }}>
            <option value="wasm">WASM (compatibility)</option>
            <option value="webgpu" disabled={!('gpu' in navigator)}>WebGPU (if available)</option>
          </select>
        </label>
        <button type="button" className="tool-button" disabled={busy || !modelConsent}
          onClick={() => void runLocalDetector()}>{busy ? 'Running local model…' : 'Download model and run locally'}</button>
      </section>}
      <form onSubmit={event => void analyze(event)}>
        <fieldset>
          <legend>Bring your own key (BYOK)</legend>
          <p>Use your own provider API key and a vision-capable model ID from that provider. Requests are billed by the provider. Keys are kept only in this dialog's memory, never saved or shared with friends. Copilot and Antigravity connect through the separate AI editor button, not as API keys here.</p>
          <label>AI provider<select value={provider} disabled={busy} onChange={event => {
            const selected = visionProviders.find(item => item.id === event.target.value);
            setProvider(selected?.id ?? 'custom'); setEndpoint(selected?.endpoint ?? '');
            setApiKey(''); setModel(''); setConsent(false); setSuggestions([]); setInferenceComplete(false);
          }}>
            <option value="custom">Custom OpenAI-compatible provider</option>
            {visionProviders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <p>OpenAI, Gemini and OpenRouter destinations are supported by this build. A custom destination must be enabled by the site operator through VITE_AI_ORIGINS. Your provider must permit browser requests (CORS); no proxy or automatic provider fallback is used.</p>
          <label>HTTPS endpoint
            <input type="url" required value={endpoint} disabled={busy} readOnly={provider !== 'custom'}
              onChange={event => { setEndpoint(event.target.value); setApiKey(''); setConsent(false); }} />
          </label>
          <label>Model
            <input required maxLength={100} value={model} disabled={busy} onChange={event => { setModel(event.target.value); setConsent(false); }} />
          </label>
          <label>API key (used in memory only)
            <input type="password" autoComplete="off" required maxLength={4096} value={apiKey}
              disabled={busy} onChange={event => setApiKey(event.target.value)} />
          </label>
          <label>Prompt
            <textarea required maxLength={1000} value={prompt} disabled={busy} onChange={event => { setPrompt(event.target.value); setConsent(false); }} />
          </label>
          <label className="protection-choice">
            <input type="checkbox" checked={consent} disabled={busy || !preparedImage}
              onChange={event => setConsent(event.target.checked)} />
            I consent to send this previewed PNG and prompt to the endpoint above. The provider receives both; its retention and processing are outside this app's control.
          </label>
          <button type="submit" className="tool-button primary-action"
            disabled={busy || !preparedImage || !consent || !endpoint || !model || !apiKey}>Send crop for suggestions</button>
        </fieldset>
      </form>
    </div>
    {suggestions.length > 0 && <section aria-label="AI suggestion review">
      <h3>Review {suggestionSource === 'local' ? 'local' : 'cloud'} suggestions before adding</h3>
      <ul>{suggestions.map((item, index) => <li key={`${item.label}:${index}`}>
        {item.label} · {Math.round(item.confidence * 100)}% · x {item.bounds.x}, y {item.bounds.y},
        {' '}{item.bounds.width} × {item.bounds.height}
      </li>)}</ul>
      <p>Suggestions are untrusted and may be wrong. {suggestionSource === 'cloud' ? 'Cloud suggestions came from the endpoint you selected.' : 'Local suggestions were produced in this browser.'} Adding them creates ordinary editable boxes on the current image.</p>
      <button type="button" className="tool-button primary-action" disabled={busy} onClick={() => void acceptSuggestions()}>
        Add all {suggestions.length} suggestions
      </button>
    </section>}
    {inferenceComplete && suggestions.length === 0 && <p role="status">No object suggestions were returned. No annotations were changed.</p>}
    {modelProgress && <p role="status">{modelProgress}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="tool-button" disabled={busy} onClick={onClose}>Close</button>
    </div>
  </dialog>;
}

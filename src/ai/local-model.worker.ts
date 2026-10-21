import { env, pipeline, RawImage } from '@huggingface/transformers';
import type { ObjectDetectionPipeline } from '@huggingface/transformers';
import wasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { normalizeLocalDetections } from './local-detections';

const MODEL = 'onnx-community/rtdetr_v2_r18vd-ONNX';
const REVISION = '936f90b6a476c6da4dfe053fc521af55285976ba';
let detector: ObjectDetectionPipeline | null = null;
let backend: 'wasm' | 'webgpu' | null = null;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = false;
env.logLevel = 40;
if (!env.backends.onnx.wasm) throw new Error('The local WASM runtime is unavailable.');
env.backends.onnx.wasm.wasmPaths = { mjs: wasmFactoryUrl, wasm: wasmUrl };

self.onmessage = async (event: MessageEvent<{ image: Blob; backend: 'wasm' | 'webgpu' }>) => {
  const { image, backend: requestedBackend } = event.data;
  try {
    if (!(image instanceof Blob) || image.type !== 'image/png' || image.size > 8 * 1024 * 1024) {
      throw new Error('The local detector requires a prepared PNG crop up to 8 MiB.');
    }
    if (backend && backend !== requestedBackend) {
      await detector?.dispose();
      detector = null;
    }
    if (!detector) {
      self.postMessage({ type: 'progress', message: 'Loading the pinned detector model into this worker…' });
      detector = await pipeline('object-detection', MODEL, {
        revision: REVISION,
        subfolder: 'onnx',
        model_file_name: 'model',
        dtype: 'q8',
        device: requestedBackend,
        progress_callback: progress => {
          const file = 'file' in progress ? progress.file.split('/').at(-1) : 'model data';
          const loaded = 'loaded' in progress ? progress.loaded : 0;
          const total = 'total' in progress ? progress.total : 0;
          self.postMessage({ type: 'progress', message: total
            ? `Preparing ${file} · ${(loaded / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB`
            : `Preparing ${file}…` });
        },
      });
      backend = requestedBackend;
    }
    self.postMessage({ type: 'progress', message: 'Running inference locally… image pixels are not uploaded.' });
    const input = await RawImage.fromBlob(image);
    const output = await detector(input, { threshold: 0.25, percentage: true });
    const detections = normalizeLocalDetections(output);
    self.postMessage({ type: 'result', detections });
  } catch (failure) {
    self.postMessage({
      type: 'error',
      message: failure instanceof Error ? failure.message.slice(0, 500) : 'Local inference failed.',
    });
  }
};

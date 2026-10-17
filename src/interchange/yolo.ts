import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { AnnotationDocument } from '../domain/model';

export type YoloSplit = 'train' | 'val' | 'test';
export interface YoloBox {
  classIndex: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

const yamlSchema = z.object({
  names: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
  nc: z.number().int().positive().optional(),
}).passthrough();
const maxLabelBytes = 2 * 1024 * 1024;
const maxLabelsTotalBytes = 128 * 1024 * 1024;

export interface YoloImportItem {
  file: File;
  sourcePath: string;
  split: YoloSplit;
  boxes: YoloBox[];
}
export interface YoloImportPlan {
  items: YoloImportItem[];
  classNames: string[];
  orphanLabels: number;
}

export function normalizeDatasetPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('Dataset contains an unsafe relative path.');
  }
  if (parts.length > 1) parts.shift();
  const result = parts.join('/');
  if (!result || result.length > 1024) throw new Error('Dataset path is empty or too long.');
  return result;
}

export function inferYoloSplit(path: string): YoloSplit {
  const parts = path.toLowerCase().split('/');
  const imagesIndex = parts.lastIndexOf('images');
  const candidate = imagesIndex > 0 ? parts[imagesIndex - 1] : '';
  if (candidate === 'val' || candidate === 'valid' || candidate === 'validation') return 'val';
  if (candidate === 'test') return 'test';
  return 'train';
}

export function labelPathForImage(path: string): string | null {
  const parts = path.split('/');
  const imagesIndex = parts.lastIndexOf('images');
  if (imagesIndex < 0) return null;
  parts[imagesIndex] = 'labels';
  const filename = parts.at(-1);
  if (!filename) return null;
  parts[parts.length - 1] = `${filename.replace(/\.[^.]+$/, '')}.txt`;
  return parts.join('/');
}

export function parseYoloNames(text: string): string[] | null {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
    throw new Error('YOLO data.yaml exceeds the 64 KiB import limit.');
  }
  let parsed: unknown;
  try { parsed = parse(text); }
  catch (error) {
    throw new Error(`Could not parse YOLO data.yaml: ${error instanceof Error ? error.message : 'invalid YAML'}`);
  }
  const config = yamlSchema.parse(parsed);
  let names: string[] | null = null;
  if (Array.isArray(config.names)) names = config.names;
  else if (config.names) {
    const entries = Object.entries(config.names);
    const indexed = entries.map(([key, value]) => {
      if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error('YOLO class names must use consecutive numeric indexes.');
      return [Number(key), value] as const;
    }).sort(([a], [b]) => a - b);
    if (indexed.some(([index], position) => index !== position)) {
      throw new Error('YOLO class names must use consecutive numeric indexes starting at zero.');
    }
    names = indexed.map(([, name]) => name);
  }
  if (names && (names.length === 0 || names.length > 10_000 ||
      names.some(name => !name.trim() || name.length > 256) || new Set(names).size !== names.length)) {
    throw new Error('YOLO data.yaml contains invalid or duplicate class names.');
  }
  if (config.nc !== undefined && names && config.nc !== names.length) {
    throw new Error('YOLO data.yaml nc does not match its names list.');
  }
  return names;
}

export function parseYoloLabels(text: string, classCount: number): YoloBox[] {
  if (new TextEncoder().encode(text).byteLength > maxLabelBytes) {
    throw new Error('YOLO label file exceeds the 2 MiB import limit.');
  }
  const boxes: YoloBox[] = [];
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    const value = line.trim();
    if (!value) continue;
    const fields = value.split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`YOLO detection label line ${lineIndex + 1} must contain exactly five values.`);
    }
    const [classText, centerXText, centerYText, widthText, heightText] = fields;
    if (!/^(0|[1-9]\d*)$/.test(classText!)) {
      throw new Error(`YOLO class index on line ${lineIndex + 1} is invalid.`);
    }
    const classIndex = Number(classText);
    const centerX = Number(centerXText), centerY = Number(centerYText);
    const width = Number(widthText), height = Number(heightText);
    if (!Number.isInteger(classIndex) || classIndex >= classCount ||
        ![centerX, centerY, width, height].every(Number.isFinite) ||
        centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1 ||
        width <= 0 || width > 1 || height <= 0 || height > 1 ||
        centerX - width / 2 < -1e-6 || centerY - height / 2 < -1e-6 ||
        centerX + width / 2 > 1 + 1e-6 || centerY + height / 2 > 1 + 1e-6) {
      throw new Error(`YOLO box on line ${lineIndex + 1} is outside the image or references an unknown class.`);
    }
    boxes.push({
      classIndex, centerX, centerY, width, height,
    });
  }
  return boxes;
}

export function boxesToAnnotations(
  boxes: readonly YoloBox[],
  width: number,
  height: number,
  classIds: readonly string[],
): AnnotationDocument['annotations'] {
  return boxes.map(box => {
    const classId = classIds[box.classIndex];
    if (!classId) throw new Error('YOLO annotation references an unknown class.');
    const left = (box.centerX - box.width / 2) * width;
    const top = (box.centerY - box.height / 2) * height;
    const right = (box.centerX + box.width / 2) * width;
    const bottom = (box.centerY + box.height / 2) * height;
    return {
      id: crypto.randomUUID(), kind: 'box' as const, classId, attributes: {},
      x: Math.max(0, left), y: Math.max(0, top),
      width: Math.min(width, right) - Math.max(0, left),
      height: Math.min(height, bottom) - Math.max(0, top),
    };
  });
}

export function annotationsToYolo(
  document: AnnotationDocument,
  classIndexes: ReadonlyMap<string, number>,
): string {
  const lines: string[] = [];
  for (const annotation of document.annotations) {
    if (annotation.kind !== 'box') {
      throw new Error(`YOLO detection export cannot represent ${annotation.kind} annotations. Nothing was exported.`);
    }
    const index = classIndexes.get(annotation.classId);
    if (index === undefined) throw new Error('An annotation uses a class missing from the dataset class list.');
    const { width, height } = document.image.canonical;
    const centerX = (annotation.x + annotation.width / 2) / width;
    const centerY = (annotation.y + annotation.height / 2) / height;
    lines.push(`${index} ${centerX} ${centerY} ${annotation.width / width} ${annotation.height / height}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function makeYoloYaml(names: readonly string[], splits: ReadonlySet<YoloSplit>): string {
  const trainSplit = splits.has('train') ? 'train' : splits.has('val') ? 'val' : 'test';
  const data: Record<string, unknown> = { path: '.', train: `${trainSplit}/images` };
  if (splits.has('val')) data.val = 'val/images';
  if (splits.has('test')) data.test = 'test/images';
  data.nc = names.length;
  data.names = [...names];
  return stringify(data, { lineWidth: 0 });
}

export async function prepareYoloImport(files: FileList | readonly File[]): Promise<YoloImportPlan> {
  const entries = Array.from(files).map(file => ({
    file,
    path: normalizeDatasetPath(file.webkitRelativePath || file.name),
  }));
  const manifests = entries.filter(entry => /^data\.ya?ml$/i.test(entry.path.split('/').at(-1) ?? ''));
  if (manifests.length > 1) throw new Error('Select one dataset folder at a time; multiple data.yaml files were found.');
  const manifestNames = manifests.length ? parseYoloNames(await manifests[0]!.file.text()) : null;
  const byPath = new Map(entries.map(entry => [entry.path, entry.file]));
  const images = entries.filter(({ file }) => /\.(jpe?g|png|webp)$/i.test(file.name));
  if (images.length === 0) throw new Error('The selected folder has no supported JPEG, PNG, or WebP images.');
  if (images.length > 10_000) throw new Error('A single import is limited to 10,000 images.');
  const jobs = images.map(({ file, path }) => {
    const labelPath = labelPathForImage(path);
    const siblingLabel = `${path.replace(/\.[^.]+$/, '')}.txt`;
    const label = (labelPath ? byPath.get(labelPath) : undefined) ?? byPath.get(siblingLabel);
    return { file, sourcePath: path, split: inferYoloSplit(path), label };
  });

  const totalLabelBytes = jobs.reduce((total, job) => total + (job.label?.size ?? 0), 0);
  if (totalLabelBytes > maxLabelsTotalBytes) {
    throw new Error('YOLO label files exceed the 128 MiB total import limit.');
  }
  let inferredClassCount = 0, orphanLabels = 0;
  const jobTexts = await Promise.all(jobs.map(async job => {
    if (!job.label) return '';
    if (job.label.size > maxLabelBytes) {
      throw new Error('A YOLO label file exceeds the 2 MiB import limit.');
    }
    return job.label.text();
  }));
  const usedLabelPaths = new Set(jobs.flatMap(job => job.label ? [job.label] : []));
  orphanLabels = entries.filter(({ file }) => /\.txt$/i.test(file.name) && !usedLabelPaths.has(file)).length;
  if (!manifestNames) {
    for (const text of jobTexts) {
      for (const line of text.split(/\r?\n/)) {
        const value = line.trim();
        if (!value) continue;
        const classText = value.split(/\s+/)[0]!;
        if (!/^(0|[1-9]\d*)$/.test(classText)) {
          throw new Error('YOLO label file contains an invalid class index.');
        }
        inferredClassCount = Math.max(inferredClassCount, Number(classText) + 1);
      }
    }
  }
  const classNames = manifestNames ?? Array.from(
    { length: Math.max(1, inferredClassCount) }, (_, index) => `class_${index}`,
  );
  const items = jobs.map((job, index) => ({
    file: job.file,
    sourcePath: job.sourcePath,
    split: job.split,
    boxes: parseYoloLabels(jobTexts[index]!, classNames.length),
  }));
  return { items, classNames, orphanLabels };
}

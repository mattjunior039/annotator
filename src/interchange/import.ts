import { z } from 'zod';
import { documentSchema } from '../domain/model';
import type { AnnotationDocument } from '../domain/model';
import { checkMaskPayloads, TILE_BYTES, TILE_SIZE } from '../domain/masks';
import type { MaskTile } from '../domain/masks';
import { signedArea } from '../domain/geometry';
import { boxesToAnnotations, parseYoloLabels, parseYoloNames } from './yolo';

export type ImportFormat = 'native' | 'coco' | 'voc' | 'yolo' | 'yolo-seg';
export interface ImportTarget { id: string; name: string; width: number; height: number; sourcePath: string }
export interface AnnotationImport { id: string; document: AnnotationDocument; tiles: MaskTile[] }
const maxBytes = 8 * 1024 * 1024;
const nameSchema = z.string().trim().min(1).max(256);
const number = z.number().finite();
const cocoSchema = z.object({
  images: z.array(z.object({ id: z.number().int().nonnegative(), file_name: z.string().min(1).max(1024),
    width: z.number().int().positive(), height: z.number().int().positive() })).max(10_000),
  categories: z.array(z.object({ id: z.number().int().nonnegative(), name: nameSchema,
    keypoints: z.array(nameSchema).max(256).optional(),
    skeleton: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).max(1024).optional(),
  })).min(1).max(10_000),
  annotations: z.array(z.object({
    id: z.number().int().nonnegative(), image_id: z.number().int().nonnegative(), category_id: z.number().int().nonnegative(),
    bbox: z.tuple([number, number, number, number]).optional(),
    segmentation: z.union([z.array(z.array(number).max(8192)).max(128),
      z.strictObject({ size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        counts: z.array(z.number().int().nonnegative()).max(4_000_001) })]).optional(),
    keypoints: z.array(number).max(768).optional(), num_keypoints: z.number().int().nonnegative().optional(),
    iscrowd: z.union([z.literal(0), z.literal(1)]).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })).max(100_000),
});
const palette = ['#39764d', '#b84d3b', '#416f9f', '#a56c19'];

function safeName(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '..' || part === '.' || part.includes('\0')) || path.startsWith('/')) {
    throw new Error('Annotation file contains an unsafe relative path.');
  }
  return parts.at(-1)!;
}
function targetFor(name: string, targets: readonly ImportTarget[], id?: string): ImportTarget {
  const filename = safeName(name);
  const exact = id && targets.find(item => item.id === id);
  if (exact) return exact;
  const matches = targets.filter(item => item.name === filename || item.sourcePath === name);
  if (matches.length !== 1) throw new Error(`Annotation image "${filename}" is missing or ambiguous. Match unique filenames or native image IDs.`);
  return matches[0]!;
}
function makeDocument(target: ImportTarget, names: readonly string[]): AnnotationDocument {
  return documentSchema.parse({
    version: 1, revision: 0, review: 'unannotated', annotations: [], skeletons: [],
    image: { version: 1, id: target.id, datasetId: crypto.randomUUID(), mediaId: crypto.randomUUID(), name: target.name,
      source: { width: target.width, height: target.height }, canonical: { width: target.width, height: target.height }, orientation: 1 },
    classes: names.map((name, index) => ({ id: crypto.randomUUID(), name, color: palette[index % palette.length]!, exclusiveGroup: null })),
  });
}
export function parseCoco(input: unknown, targets: readonly ImportTarget[]): AnnotationImport[] {
  const result = cocoSchema.safeParse(input);
  if (!result.success) throw new Error('Unsupported or invalid COCO JSON. Compressed RLE is not accepted; use uncompressed counts.');
  const source = result.data;
  for (const items of [source.images, source.categories, source.annotations]) {
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('COCO IDs must be unique within each collection.');
  }
  if (new Set(source.categories.map(item => item.name)).size !== source.categories.length) throw new Error('COCO category names must be unique.');
  if (source.categories.some(category => category.skeleton?.length && !category.keypoints?.length)) throw new Error('COCO skeleton edges require named keypoints.');
  const images = new Set(source.images.map(item => item.id));
  const categories = new Map(source.categories.map((item, index) => [item.id, index]));
  const grouped = new Map<number, typeof source.annotations>();
  for (const annotation of source.annotations) {
    if (!images.has(annotation.image_id) || !categories.has(annotation.category_id)) throw new Error('COCO annotation has an unknown image/category reference.');
    if (annotation.attributes && Object.keys(annotation.attributes).length) throw new Error('COCO custom attributes need native JSON to preserve their meaning. No annotations were changed.');
    const rows = grouped.get(annotation.image_id) ?? [];
    rows.push(annotation); grouped.set(annotation.image_id, rows);
  }
  return source.images.map(image => {
    const target = targetFor(image.file_name, targets);
    if (target.width !== image.width || target.height !== image.height) throw new Error('COCO image dimensions do not match the dataset.');
    const document = makeDocument(target, source.categories.map(item => item.name));
    const skeletons = new Map<number, string>();
    for (const [index, category] of source.categories.entries()) if (category.keypoints?.length) {
      const id = crypto.randomUUID();
      skeletons.set(category.id, id);
      document.skeletons.push({ id, name: `COCO ${category.name}`, points: category.keypoints,
        edges: (category.skeleton ?? []).map(([a, b]) => [a - 1, b - 1]) });
      if (!document.classes[index]) throw new Error('COCO category is missing.');
    }
    const tiles: MaskTile[] = [];
    for (const item of grouped.get(image.id) ?? []) {
      const common = { id: crypto.randomUUID(), classId: document.classes[categories.get(item.category_id)!]!.id, attributes: {} };
      if (item.keypoints?.length) {
        if (item.segmentation && (!Array.isArray(item.segmentation) || item.segmentation.length)) throw new Error('COCO instances with both segmentation and keypoints need an explicit conversion; nothing was changed.');
        if (item.keypoints.length % 3 || !skeletons.has(item.category_id)) throw new Error('COCO keypoints do not match a category skeleton.');
        const points = [];
        for (let i = 0; i < item.keypoints.length; i += 3) {
          const visibility = item.keypoints[i + 2]!;
          if (![0, 1, 2].includes(visibility)) throw new Error('COCO keypoint visibility must be 0, 1, or 2.');
          points.push({ x: item.keypoints[i]!, y: item.keypoints[i + 1]!,
            visibility: visibility === 0 ? 'absent' as const : visibility === 1 ? 'occluded' as const : 'visible' as const });
        }
        if (item.num_keypoints !== undefined && item.num_keypoints !== points.filter(point => point.visibility !== 'absent').length) {
          throw new Error('COCO num_keypoints does not match visibility values.');
        }
        document.annotations.push({ ...common, kind: 'keypoints', skeletonId: skeletons.get(item.category_id)!, points });
      } else if (item.segmentation && !Array.isArray(item.segmentation)) {
        const rle = item.segmentation;
        if (rle.size[0] !== target.height || rle.size[1] !== target.width || target.width * target.height > 4_000_000 ||
            rle.counts.reduce((a, b) => a + b, 0) !== target.width * target.height) throw new Error('Invalid COCO RLE dimensions or counts.');
        const grid = new Map<string, { x: number; y: number; id: string; pixels: Uint8Array<ArrayBuffer> }>();
        let position = 0;
        for (const [index, run] of rle.counts.entries()) {
          if (index % 2) for (let end = position + run; position < end; position++) {
            const x = Math.floor(position / target.height), y = position % target.height;
            const tx = Math.floor(x / TILE_SIZE) * TILE_SIZE, ty = Math.floor(y / TILE_SIZE) * TILE_SIZE, key = `${tx}:${ty}`;
            let tile = grid.get(key);
            if (!tile) {
              if (grid.size >= 128) throw new Error('COCO mask exceeds the 128-tile image budget.');
              tile = { x: tx, y: ty, id: crypto.randomUUID(), pixels: new Uint8Array(TILE_BYTES) }; grid.set(key, tile);
            }
            tile.pixels[(y - ty) * TILE_SIZE + x - tx] = 1;
          } else position += run;
        }
        document.annotations.push({ ...common, attributes: { iscrowd: item.iscrowd === 1 }, kind: 'mask', width: target.width, height: target.height, tileSize: 256,
          tiles: [...grid.values()].map(tile => ({ x: tile.x, y: tile.y, blobId: tile.id })) });
        tiles.push(...[...grid.values()].map(tile => ({ id: tile.id, pixels: tile.pixels.buffer })));
      } else if (item.segmentation?.length) {
        if (item.segmentation.length !== 1) throw new Error('Multipart COCO polygons cannot be represented as one simple polygon. Use a mask instead.');
        const coordinates = item.segmentation[0]!;
        if (coordinates.length < 6 || coordinates.length % 2) throw new Error('COCO polygon has invalid coordinate pairs.');
        const points = [];
        for (let i = 0; i < coordinates.length; i += 2) points.push({ x: coordinates[i]!, y: coordinates[i + 1]! });
        document.annotations.push({ ...common, kind: 'polygon', points: signedArea(points) < 0 ? points.reverse() : points });
      } else if (item.bbox) {
        if (item.iscrowd) throw new Error('COCO crowd instances require mask RLE, not an implicit bounding-box conversion.');
        const [x, y, width, height] = item.bbox;
        document.annotations.push({ ...common, kind: 'box', x, y, width, height });
      } else throw new Error('COCO annotation has no supported geometry.');
    }
    const parsed = documentSchema.safeParse(document);
    if (!parsed.success) throw new Error('COCO geometry, skeleton, or class references are invalid for this image.');
    checkMaskPayloads(parsed.data, tiles);
    return { id: target.id, document: parsed.data, tiles };
  });
}

export async function readAnnotationFile(file: File): Promise<string> {
  if (file.size > maxBytes) throw new Error('Annotation file exceeds the 8 MiB limit.');
  return file.text();
}
export async function importAnnotationFiles(
  files: readonly File[], format: ImportFormat, targets: readonly ImportTarget[], existingNames: readonly string[],
): Promise<AnnotationImport[]> {
  if (files.length > 30_000) throw new Error('Too many annotation/sidecar files.');
  if (files.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024) throw new Error('Annotation import exceeds its 128 MiB batch budget.');
  const documents = files.filter(file => format === 'voc' ? /\.xml$/i.test(file.name) :
    format === 'yolo' || format === 'yolo-seg' ? /\.txt$/i.test(file.name) : /\.json$/i.test(file.name) && file.name !== 'export-manifest.json');
  if (!documents.length || documents.length > 10_000) throw new Error('Select 1–10,000 annotation files for this format.');
  const yaml = files.filter(file => /^data\.ya?ml$/i.test(file.name));
  if (yaml.length > 1) throw new Error('Choose one dataset schema at a time.');
  const names = yaml.length ? parseYoloNames(await readAnnotationFile(yaml[0]!)) ?? existingNames : existingNames;
  const imports: AnnotationImport[] = [];
  for (const file of documents) {
    const text = await readAnnotationFile(file);
    if (format === 'native' || format === 'coco') {
      let input: unknown;
      try { input = JSON.parse(text); } catch { throw new Error(`Invalid annotation JSON: ${file.name}`); }
      if (format === 'coco') { imports.push(...parseCoco(input, targets)); continue; }
      const parsed = documentSchema.safeParse(input);
      if (!parsed.success) throw new Error(`Invalid native annotation document: ${file.name}`);
      const document = parsed.data, target = targetFor(document.image.name, targets, document.image.id);
      const tiles: MaskTile[] = [];
      for (const annotation of document.annotations) if (annotation.kind === 'mask') for (const tile of annotation.tiles) {
        const matching = files.filter(item => item.name === `${tile.blobId}.bin`);
        if (matching.length !== 1 || matching[0]!.size !== TILE_BYTES) throw new Error('Native mask sidecar is missing, ambiguous, or has the wrong size.');
        tiles.push({ id: tile.blobId, pixels: await matching[0]!.arrayBuffer() });
      }
      checkMaskPayloads(document, tiles);
      imports.push({ id: target.id, document, tiles }); continue;
    }
    if (format === 'voc') {
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('VOC DTDs and entities are not accepted.');
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      if (xml.querySelector('parsererror') || xml.documentElement.tagName !== 'annotation') throw new Error('Invalid VOC XML.');
      const value = (element: Element, name: string) => {
        const nodes = element.querySelectorAll(`:scope > ${name}`);
        if (nodes.length !== 1) throw new Error(`VOC requires one ${name} element.`);
        return nodes[0]!.textContent?.trim() ?? '';
      };
      const target = targetFor(value(xml.documentElement, 'filename'), targets);
      const size = xml.querySelector('annotation > size');
      if (!size || Number(value(size, 'width')) !== target.width || Number(value(size, 'height')) !== target.height) throw new Error('VOC dimensions do not match the dataset.');
      const objects = [...xml.querySelectorAll('annotation > object')];
      const classNames = [...new Set(objects.map(object => value(object, 'name')))];
      const document = makeDocument(target, classNames);
      for (const object of objects) {
        const bounds = object.querySelector(':scope > bndbox');
        if (!bounds) throw new Error('VOC objects require bounding boxes.');
        const [xmin, ymin, xmax, ymax] = ['xmin', 'ymin', 'xmax', 'ymax'].map(name => Number(value(bounds, name)));
        if (![xmin, ymin, xmax, ymax].every(v => v !== undefined && Number.isInteger(v) && v >= 1)) throw new Error('VOC uses positive one-based inclusive integer coordinates.');
        const attributes: Record<string, string | boolean> = {};
        for (const flag of ['difficult', 'truncated']) {
          const content = object.querySelector(`:scope > ${flag}`)?.textContent?.trim();
          if (content !== undefined) {
            if (content !== '0' && content !== '1') throw new Error(`VOC ${flag} must be 0 or 1.`);
            attributes[flag] = content === '1';
          }
        }
        document.annotations.push({ id: crypto.randomUUID(), kind: 'box', attributes,
          classId: document.classes[classNames.indexOf(value(object, 'name'))]!.id,
          x: xmin! - 1, y: ymin! - 1, width: xmax! - xmin! + 1, height: ymax! - ymin! + 1 });
      }
      const parsed = documentSchema.safeParse(document);
      if (!parsed.success) throw new Error('VOC boxes/classes are invalid or outside the image.');
      imports.push({ id: target.id, document: parsed.data, tiles: [] }); continue;
    }
    const stem = file.name.replace(/\.[^.]+$/, '');
    const matching = targets.filter(target => target.name.replace(/\.[^.]+$/, '') === stem);
    if (matching.length !== 1) throw new Error(`YOLO label ${file.name} needs one matching image stem.`);
    const target = matching[0]!, document = makeDocument(target, names);
    if (format === 'yolo') document.annotations = boxesToAnnotations(parseYoloLabels(text, names.length), target.width, target.height, document.classes.map(item => item.id));
    else for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 7 || fields.length % 2 !== 1 || !/^(0|[1-9]\d*)$/.test(fields[0]!)) throw new Error('YOLO segmentation needs a class index and at least three normalized coordinate pairs.');
      const index = Number(fields[0]), coordinates = fields.slice(1).map(Number);
      if (!document.classes[index] || coordinates.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('YOLO segmentation references an unknown class or invalid normalized coordinates.');
      const points = [];
      for (let i = 0; i < coordinates.length; i += 2) points.push({ x: coordinates[i]! * target.width, y: coordinates[i + 1]! * target.height });
      document.annotations.push({ id: crypto.randomUUID(), classId: document.classes[index]!.id, attributes: {}, kind: 'polygon',
        points: signedArea(points) < 0 ? points.reverse() : points });
    }
    const parsed = documentSchema.safeParse(document);
    if (!parsed.success) throw new Error('YOLO geometry is invalid for this image.');
    imports.push({ id: target.id, document: parsed.data, tiles: [] });
  }
  if (new Set(imports.map(item => item.id)).size !== imports.length) throw new Error('Annotation import repeats a destination image.');
  return imports;
}

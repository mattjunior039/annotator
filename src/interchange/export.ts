import type { Annotation, AnnotationDocument } from '../domain/model';
import { signedArea } from '../domain/geometry';
import { annotationsToYolo } from './yolo';

export const exportFormats = [
  { id: 'yolo', name: 'YOLO detection', detail: 'Normalized bounding boxes and data.yaml.', kinds: ['box'] },
  { id: 'yolo-seg', name: 'YOLO segmentation', detail: 'Normalized polygon vertices and data.yaml.', kinds: ['polygon'] },
  { id: 'coco', name: 'COCO JSON', detail: 'Bounding boxes and polygon segmentation, grouped by split.', kinds: ['box', 'polygon'] },
  { id: 'voc', name: 'Pascal VOC XML', detail: 'One XML file per image, with pixel bounding boxes.', kinds: ['box'] },
  { id: 'csv', name: 'CSV annotations', detail: 'One row per annotation; pixel geometry as JSON. Includes labels and keypoints.', kinds: ['box', 'polygon', 'label', 'keypoints'] },
  { id: 'native', name: 'Native annotation JSON', detail: 'Versioned per-image documents with classes, skeletons, attributes, and review state. Not a restorable vault backup.', kinds: ['box', 'polygon', 'label', 'keypoints'] },
] as const;
export type ExportFormat = typeof exportFormats[number]['id'];

export function exportFormat(value: string): ExportFormat {
  const format = exportFormats.find(item => item.id === value);
  if (!format) throw new Error('Unknown annotation export format.');
  return format.id;
}

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)) {
    throw new Error('Pascal VOC cannot represent control characters in class names or filenames.');
  }
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function validateExport(document: AnnotationDocument, format: ExportFormat): void {
  const definition = exportFormats.find(item => item.id === format)!;
  const allowed: readonly string[] = definition.kinds;
  for (const annotation of document.annotations) {
    if (!allowed.includes(annotation.kind)) {
      throw new Error(`${definition.name} cannot represent ${annotation.kind} annotations in ${document.image.name}. Choose Native annotation JSON or CSV for mixed annotations. No export files were created.`);
    }
  }
  if (new Set(document.classes.map(item => item.name)).size !== document.classes.length) {
    throw new Error('An image contains duplicate class names; export was stopped to avoid changing label meaning.');
  }
  if (format === 'voc') {
    xml(document.image.name);
    document.classes.forEach(item => xml(item.name));
  }
}

function classIndex(annotation: Annotation, indexes: ReadonlyMap<string, number>): number {
  const index = indexes.get(annotation.classId);
  if (index === undefined) throw new Error('An annotation references a missing export class.');
  return index;
}

export function yoloSegmentation(document: AnnotationDocument, indexes: ReadonlyMap<string, number>): string {
  validateExport(document, 'yolo-seg');
  const { width, height } = document.image.canonical;
  return document.annotations.map(annotation => {
    if (annotation.kind !== 'polygon') throw new Error('Expected a polygon.');
    return `${classIndex(annotation, indexes)} ${annotation.points.map(point => `${point.x / width} ${point.y / height}`).join(' ')}\n`;
  }).join('');
}

export function pascalVoc(document: AnnotationDocument, filename: string): string {
  validateExport(document, 'voc');
  const { width, height } = document.image.canonical;
  const objects = document.annotations.map(annotation => {
    if (annotation.kind !== 'box') throw new Error('Expected a bounding box.');
    const name = document.classes.find(item => item.id === annotation.classId)?.name;
    if (!name) throw new Error('An annotation references a missing class.');
    // VOC uses one-based inclusive integer coordinates; enclose subpixel boxes.
    const xmin = Math.min(width, Math.floor(annotation.x) + 1);
    const ymin = Math.min(height, Math.floor(annotation.y) + 1);
    const xmax = Math.max(xmin, Math.min(width, Math.ceil(annotation.x + annotation.width)));
    const ymax = Math.max(ymin, Math.min(height, Math.ceil(annotation.y + annotation.height)));
    return `  <object><name>${xml(name)}</name><pose>Unspecified</pose><truncated>0</truncated><difficult>0</difficult><bndbox><xmin>${xmin}</xmin><ymin>${ymin}</ymin><xmax>${xmax}</xmax><ymax>${ymax}</ymax></bndbox></object>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<annotation>\n  <filename>${xml(filename)}</filename>\n  <size><width>${width}</width><height>${height}</height><depth>3</depth></size>\n  <segmented>0</segmented>\n${objects.join('\n')}\n</annotation>\n`;
}

export const csvHeader = 'image,width,height,annotation_id,label,kind,geometry,skeleton,attributes,review\r\n';
function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}
export function annotationCsv(document: AnnotationDocument, filename: string): string {
  validateExport(document, 'csv');
  const { width, height } = document.image.canonical;
  return document.annotations.map(annotation => {
    const name = document.classes.find(item => item.id === annotation.classId)?.name;
    if (!name) throw new Error('An annotation references a missing class.');
    const geometry = annotation.kind === 'box'
      ? { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }
      : annotation.kind === 'polygon' || annotation.kind === 'keypoints' ? { points: annotation.points } : {};
    const skeleton = annotation.kind === 'keypoints'
      ? document.skeletons.find(item => item.id === annotation.skeletonId) : null;
    return [filename, width, height, annotation.id, name, annotation.kind, JSON.stringify(geometry),
      JSON.stringify(skeleton ?? null), JSON.stringify(annotation.attributes), document.review].map(csvCell).join(',') + '\r\n';
  }).join('');
}

export function cocoAnnotations(
  document: AnnotationDocument, imageId: number, indexes: ReadonlyMap<string, number>, firstId: number,
) {
  validateExport(document, 'coco');
  return document.annotations.map((annotation, index) => {
    let bbox: number[], area: number, segmentation: number[][] = [];
    if (annotation.kind === 'box') {
      bbox = [annotation.x, annotation.y, annotation.width, annotation.height];
      area = annotation.width * annotation.height;
    } else if (annotation.kind === 'polygon') {
      const xs = annotation.points.map(point => point.x), ys = annotation.points.map(point => point.y);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
      area = Math.abs(signedArea(annotation.points));
      segmentation = [annotation.points.flatMap(point => [point.x, point.y])];
    } else throw new Error('COCO export expects boxes or polygons.');
    return { id: firstId + index, image_id: imageId, category_id: classIndex(annotation, indexes) + 1,
      bbox, area, segmentation, iscrowd: 0 };
  });
}

export function perImageExport(
  document: AnnotationDocument, format: ExportFormat, indexes: ReadonlyMap<string, number>,
  filename: string,
): { extension: string; contents: string } {
  validateExport(document, format);
  switch (format) {
    case 'yolo': return { extension: 'txt', contents: annotationsToYolo(document, indexes) };
    case 'yolo-seg': return { extension: 'txt', contents: yoloSegmentation(document, indexes) };
    case 'voc': return { extension: 'xml', contents: pascalVoc(document, filename) };
    case 'native': return { extension: 'json', contents: JSON.stringify(document, null, 2) + '\n' };
    default: throw new Error('This format uses a dataset-level annotation file.');
  }
}

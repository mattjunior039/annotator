import { describe, expect, it } from 'vitest';
import { documentSchema } from '../domain/model';
import type { AnnotationDocument } from '../domain/model';
import {
  annotationCsv, cocoAnnotations, exportFormat, exportFormats, pascalVoc,
  perImageExport, validateExport, yoloSegmentation,
} from './export';

function fixture(): AnnotationDocument {
  const classId = crypto.randomUUID(), skeletonId = crypto.randomUUID();
  return documentSchema.parse({
    version: 1,
    image: { version: 1, id: crypto.randomUUID(), datasetId: crypto.randomUUID(), name: 'sample.png',
      source: { width: 100, height: 80 }, canonical: { width: 100, height: 80 },
      orientation: 1, mediaId: crypto.randomUUID() },
    revision: 4, review: 'reviewed',
    classes: [{ id: classId, name: 'pill & "tray"', color: '#39764d', exclusiveGroup: null }],
    skeletons: [{ id: skeletonId, name: 'pair', points: ['left', 'right'], edges: [[0, 1]] }],
    annotations: [
      { id: crypto.randomUUID(), classId, kind: 'box', attributes: {}, x: 10.5, y: 20, width: 25, height: 30 },
      { id: crypto.randomUUID(), classId, kind: 'polygon', attributes: {},
        points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 20, y: 30 }] },
      { id: crypto.randomUUID(), classId, kind: 'label', attributes: { source: 'human' } },
      { id: crypto.randomUUID(), classId, kind: 'keypoints', attributes: {}, skeletonId,
        points: [{ x: 10, y: 20, visibility: 'visible' }, { x: 0, y: 0, visibility: 'absent' }] },
    ],
  });
}

describe('annotation export formats', () => {
  it('rejects incompatible types for every training format, instead of dropping annotations', () => {
    const document = fixture();
    for (const format of ['yolo', 'yolo-seg', 'coco', 'voc'] as const) {
      expect(() => validateExport(document, format)).toThrow(/cannot represent/);
    }
    for (const format of ['native', 'csv'] as const) expect(() => validateExport(document, format)).not.toThrow();
    expect(exportFormats).toHaveLength(6);
    expect(exportFormat('coco')).toBe('coco');
    expect(() => exportFormat('unknown')).toThrow(/Unknown/);
  });
  it('writes normalized polygon coordinates and keeps image-level dimensions', () => {
    const document = fixture();
    document.annotations = document.annotations.filter(item => item.kind === 'polygon');
    const indexes = new Map([[document.classes[0]!.id, 2]]);
    expect(yoloSegmentation(document, indexes)).toBe('2 0.1 0.125 0.3 0.125 0.2 0.375\n');
    expect(perImageExport(document, 'yolo-seg', indexes, 'sample.png').extension).toBe('txt');
  });
  it('writes COCO boxes, polygon areas, category references, and unique numeric annotation IDs', () => {
    const document = fixture();
    document.annotations = document.annotations.slice(0, 2);
    const rows = cocoAnnotations(document, 7, new Map([[document.classes[0]!.id, 2]]), 15);
    expect(rows[0]).toMatchObject({ id: 15, image_id: 7, category_id: 3, bbox: [10.5, 20, 25, 30], area: 750, iscrowd: 0 });
    expect(rows[1]).toMatchObject({ id: 16, bbox: [10, 10, 20, 20], area: 200, segmentation: [[10, 10, 30, 10, 20, 30]] });
  });
  it('writes escaped VOC names and one-based inclusive integer boxes, including full-image boxes', () => {
    const document = fixture();
    document.annotations = document.annotations.slice(0, 1);
    const xml = pascalVoc(document, 'image&1.png');
    expect(xml).toContain('<name>pill &amp; &quot;tray&quot;</name>');
    expect(xml).toContain('<filename>image&amp;1.png</filename>');
    expect(xml).toContain('<xmin>11</xmin><ymin>21</ymin><xmax>36</xmax><ymax>50</ymax>');
    document.annotations = [{ ...document.annotations[0]!, kind: 'box', x: 0, y: 0, width: 100, height: 80 }];
    expect(pascalVoc(document, 'image.png')).toContain('<xmin>1</xmin><ymin>1</ymin><xmax>100</xmax><ymax>80</ymax>');
    document.classes[0]!.name = 'invalid\u0001name';
    expect(() => validateExport(document, 'voc')).toThrow(/control characters/);
  });
  it('preserves mixed native documents and writes CSV labels, keypoints, skeletons, and escaped text', () => {
    const document = fixture();
    const result = perImageExport(document, 'native', new Map(), 'sample.png');
    expect(documentSchema.parse(JSON.parse(result.contents))).toEqual(document);
    const csv = annotationCsv(document, 'train/images/sample.png');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(4);
    expect(csv).toContain('"pill & ""tray"""');
    expect(csv).toContain('"label","{}"');
    expect(csv).toContain('""visibility"":""absent""');
    expect(csv).toContain('""name"":""pair""');
    expect(csv).toContain('"reviewed"');
  });
  it('exports empty annotation files and rejects masks without their tile data', () => {
    const document = fixture();
    document.annotations = [];
    const indexes = new Map([[document.classes[0]!.id, 0]]);
    expect(perImageExport(document, 'yolo', indexes, 'sample.png').contents).toBe('');
    expect(annotationCsv(document, 'sample.png')).toBe('');
    document.annotations = [{ id: crypto.randomUUID(), classId: document.classes[0]!.id,
      kind: 'mask', attributes: {}, width: 100, height: 80, tileSize: 256, tiles: [] }];
    for (const { id } of exportFormats) expect(() => validateExport(document, id)).toThrow(/cannot represent mask/);
  });
});

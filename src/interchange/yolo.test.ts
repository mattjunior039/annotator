import { describe, expect, it } from 'vitest';
import { documentSchema } from '../domain/model';
import {
  annotationsToYolo, boxesToAnnotations, inferYoloSplit, labelPathForImage,
  makeYoloYaml, normalizeDatasetPath, parseYoloLabels, parseYoloNames, prepareYoloImport,
} from './yolo';

function folderFile(path: string, content: string, type = 'text/plain'): File {
  const name = path.split('/').at(-1)!;
  const file = new File([content], name, { type });
  Object.defineProperty(file, 'webkitRelativePath', { value: `dataset/${path}` });
  return file;
}

describe('YOLOv8 detection interchange', () => {
  it('reads common YAML class-name encodings and writes a valid dataset manifest', () => {
    expect(parseYoloNames("nc: 2\nnames: ['pill', 'tray']\n")).toEqual(['pill', 'tray']);
    expect(parseYoloNames('names:\n  0: pill\n  1: tray\n')).toEqual(['pill', 'tray']);
    expect(makeYoloYaml(['pill', 'tray'], new Set(['train', 'val']))).toContain('val: val/images');
    expect(() => parseYoloNames('nc: 3\nnames: [pill, tray]\n')).toThrow(/does not match/);
  });

  it('normalizes safe folder paths and pairs split labels with images', () => {
    expect(normalizeDatasetPath('dataset/train/images/pill.jpg')).toBe('train/images/pill.jpg');
    expect(labelPathForImage('train/images/pill.jpg')).toBe('train/labels/pill.txt');
    expect(inferYoloSplit('valid/images/pill.jpg')).toBe('val');
    expect(() => normalizeDatasetPath('dataset/train/../secret.jpg')).toThrow(/unsafe/);
  });

  it('validates normalized detection boxes and converts them to canonical pixels', () => {
    const boxes = parseYoloLabels('0 0.5 0.25 0.2 0.4\n', 1);
    const classId = crypto.randomUUID();
    const annotations = boxesToAnnotations(boxes, 100, 80, [classId]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.kind).toBe('box');
    if (annotations[0]?.kind === 'box') {
      expect(annotations[0]).toMatchObject({ x: 40, width: 20, height: 32 });
      expect(annotations[0].y).toBeCloseTo(4);
    }
    expect(() => parseYoloLabels('1 0.5 0.5 0.1 0.1', 1)).toThrow(/unknown class/);
    expect(() => parseYoloLabels('0 0.1 0.1 0.4 0.4', 1)).toThrow(/outside the image/);
    expect(() => parseYoloLabels('0 0.5 0.5 0.1 0.1 extra', 1)).toThrow(/five values/);
  });

  it('preflights a folder manifest and imports paired labels before writing images', async () => {
    const files = [
      folderFile('data.yaml', 'nc: 2\nnames: [acetaminophen, ibuprofen]\n'),
      folderFile('train/images/pill.png', 'synthetic image', 'image/png'),
      folderFile('train/labels/pill.txt', '1 0.5 0.5 0.2 0.4\n'),
    ];
    const plan = await prepareYoloImport(files);
    expect(plan.classNames).toEqual(['acetaminophen', 'ibuprofen']);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      sourcePath: 'train/images/pill.png', split: 'train',
      boxes: [{ classIndex: 1, centerX: 0.5, centerY: 0.5, width: 0.2, height: 0.4 }],
    });
    expect(plan.orphanLabels).toBe(0);
  });

  it('round-trips box annotations without silently exporting unsupported types', () => {
    const classId = crypto.randomUUID(), imageId = crypto.randomUUID();
    const document = documentSchema.parse({
      version: 1,
      image: {
        version: 1, id: imageId, datasetId: crypto.randomUUID(), name: 'pill.png',
        source: { width: 100, height: 80 }, canonical: { width: 100, height: 80 },
        orientation: 1, mediaId: crypto.randomUUID(),
      },
      revision: 0, classes: [{
        id: classId, name: 'pill', color: '#39764d', exclusiveGroup: null,
      }],
      skeletons: [], annotations: [{
        id: crypto.randomUUID(), classId, attributes: {}, kind: 'box',
        x: 10, y: 20, width: 25, height: 30,
      }],
      review: 'unannotated',
    });
    const text = annotationsToYolo(document, new Map([[classId, 0]]));
    const box = parseYoloLabels(text, 1)[0]!;
    expect(box.centerX).toBeCloseTo(0.225);
    expect(box.centerY).toBeCloseTo(0.4375);
    expect(box.width).toBeCloseTo(0.25);
    expect(box.height).toBeCloseTo(0.375);
    const polygon = documentSchema.parse({
      ...document, annotations: [{
        id: crypto.randomUUID(), classId, attributes: {}, kind: 'polygon',
        points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 3, y: 4 }],
      }],
    });
    expect(() => annotationsToYolo(polygon, new Map([[classId, 0]]))).toThrow(/cannot represent polygon/);
  });
});

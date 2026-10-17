import { describe, expect, it } from 'vitest';
import { importAnnotationFiles, parseCoco } from './import';
import { cocoAnnotations, perImageExport } from './export';
import { paintMask } from '../domain/masks';
import type { ImportTarget } from './import';

const target: ImportTarget = { id: crypto.randomUUID(), name: 'sample.png', width: 30, height: 20, sourcePath: 'train/images/sample.png' };
function source() {
  return { images: [{ id: 1, file_name: 'images/sample.png', width: 30, height: 20 }],
    categories: [{ id: 1, name: 'Pill' }], annotations: [
      { id: 1, image_id: 1, category_id: 1, bbox: [2, 3, 5, 6], segmentation: [], iscrowd: 0 },
    ] };
}
describe('validated annotation interchange', () => {
  it('round trips native JSON instance IDs/properties/attributes and exact mask sidecars', async () => {
    const document = parseCoco(source(), [target])[0]!.document;
    document.annotations[0]!.visible = false;
    document.annotations[0]!.locked = true;
    document.annotations[0]!.attributes = { checked: true, score: 2, text: 'private' };
    const painted = paintMask({ id: crypto.randomUUID(), classId: document.classes[0]!.id, attributes: {},
      kind: 'mask', width: 30, height: 20, tileSize: 256, tiles: [] }, new Map(), [{ x: 5, y: 5 }], 3, false);
    document.annotations.push(painted.mask);
    document.annotations.push({ id: crypto.randomUUID(), classId: document.classes[0]!.id, attributes: {}, kind: 'polygon',
      points: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 4, y: 8 }] });
    const exported = perImageExport(document, 'native', new Map([[document.classes[0]!.id, 0]]), 'sample.png');
    const files = [new File([exported.contents], 'sample.json'), ...painted.tiles.map(tile => new File([tile.pixels], `${tile.id}.bin`))];
    const imported = await importAnnotationFiles(files, 'native', [target], []);
    expect(imported[0]!.document).toEqual(document);
    expect(imported[0]!.tiles).toEqual(painted.tiles);
    await expect(importAnnotationFiles(files.slice(0, 1), 'native', [target], [])).rejects.toThrow('sidecar');
    await expect(importAnnotationFiles([files[0]!, files[0]!], 'native', [target], [])).rejects.toThrow('sidecar');
  });
  it('round trips COCO boxes, polygons, visibility values, and exact column-major mask RLE', () => {
    const document = parseCoco(source(), [target])[0]!.document;
    const painted = paintMask({ id: crypto.randomUUID(), classId: document.classes[0]!.id, attributes: {},
      kind: 'mask', width: 30, height: 20, tileSize: 256, tiles: [] }, new Map(), [{ x: 4, y: 5 }, { x: 10, y: 6 }], 2, false);
    document.annotations.push(painted.mask);
    const tiles = new Map(painted.tiles.map(tile => [tile.id, new Uint8Array(tile.pixels)]));
    document.annotations.push({ id: crypto.randomUUID(), classId: document.classes[0]!.id, attributes: {}, kind: 'polygon',
      points: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 4, y: 8 }] });
    const exported = cocoAnnotations(document, 1, new Map([[document.classes[0]!.id, 0]]), 1, tiles);
    expect(exported[1]).toMatchObject({ iscrowd: 0 });
    const imported = parseCoco({ ...source(), annotations: exported }, [target])[0]!;
    expect(imported.document.annotations[0]).toMatchObject({ x: 2, y: 3, width: 5, height: 6 });
    expect(imported.document.annotations.find(item => item.kind === 'polygon')?.points).toEqual([
      { x: 1, y: 1 }, { x: 8, y: 1 }, { x: 4, y: 8 },
    ]);
    expect(imported.tiles.map(tile => [...new Uint8Array(tile.pixels)])).toEqual(painted.tiles.map(tile => [...new Uint8Array(tile.pixels)]));
    const crowd = parseCoco({ ...source(), annotations: exported.map(item => ({ ...item, iscrowd: item.id === 2 ? 1 : 0 })) }, [target])[0]!;
    expect(crowd.document.annotations.find(item => item.kind === 'mask')?.attributes).toEqual({ iscrowd: true });
    const keypoints = parseCoco({ ...source(), categories: [{ id: 1, name: 'Pill', keypoints: ['tip', 'base'], skeleton: [[1, 2]] }],
      annotations: [{ id: 1, image_id: 1, category_id: 1, keypoints: [5, 6, 1, 0, 0, 0], num_keypoints: 1 }] }, [target])[0]!;
    expect(keypoints.document.annotations[0]).toMatchObject({ kind: 'keypoints', points: [
      { x: 5, y: 6, visibility: 'occluded' }, { x: 0, y: 0, visibility: 'absent' }] });
    expect(cocoAnnotations(keypoints.document, 1, new Map([[keypoints.document.classes[0]!.id, 0]]), 1)[0]).toMatchObject({
      keypoints: [5, 6, 1, 0, 0, 0], num_keypoints: 1 });
  });
  it('rejects hostile references, duplicate IDs, unsafe paths, malformed RLE, unsupported topology, and custom attributes', () => {
    for (const change of [
      { images: [{ id: 1, file_name: '../sample.png', width: 30, height: 20 }] },
      { images: [{ id: 1, file_name: 'sample.png', width: 31, height: 20 }] },
      { annotations: [{ ...source().annotations[0], image_id: 8 }] },
      { annotations: [source().annotations[0], source().annotations[0]] },
      { annotations: [{ ...source().annotations[0], attributes: { secret: 'not silently lost' } }] },
      { annotations: [{ ...source().annotations[0], segmentation: { size: [20, 30], counts: [599] } }] },
      { annotations: [{ ...source().annotations[0], segmentation: { size: [20, 30], counts: 'compressed' } }] },
      { annotations: [{ ...source().annotations[0], segmentation: [[0, 0, 3, 0, 1, 3], [4, 4, 8, 4, 6, 8]] }] },
    ]) expect(() => parseCoco({ ...source(), ...change }, [target])).toThrow();
  });
  it('imports normalized YOLO boxes and segmentation with explicit class mapping', async () => {
    const box = await importAnnotationFiles([new File(['0 .5 .5 .4 .4\n'], 'sample.txt')], 'yolo', [target], ['Pill']);
    expect(box[0]!.document.annotations[0]).toMatchObject({ kind: 'box', x: 9, y: 6, width: 12, height: 8 });
    const polygon = await importAnnotationFiles([new File(['0 .1 .1 .6 .1 .3 .7\n'], 'sample.txt')], 'yolo-seg', [target], ['Pill']);
    expect(polygon[0]!.document.annotations[0]).toMatchObject({ kind: 'polygon',
      points: [{ x: 3, y: 2 }, { x: 18, y: 2 }, { x: 9, y: 14 }] });
    await expect(importAnnotationFiles([new File(['0 .1 .1 2 .1 .3 .7'], 'sample.txt')], 'yolo-seg', [target], ['Pill'])).rejects.toThrow('normalized');
  });
});

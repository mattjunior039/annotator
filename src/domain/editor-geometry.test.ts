import { describe, expect, it } from 'vitest';
import { resizeBox, translateAnnotation } from './editor-geometry';
import type { Annotation } from './model';

const box: Extract<Annotation, { kind: 'box' }> = {
  id: 'box', classId: 'class', attributes: {}, kind: 'box', x: 10, y: 20, width: 30, height: 40,
};
const bounds = { width: 100, height: 80 };

describe('editor geometry', () => {
  it('moves a box without changing its size and clamps the whole shape to image bounds', () => {
    expect(translateAnnotation(box, { x: 200, y: -200 }, bounds)).toEqual({ ...box, x: 70, y: 0 });
    expect(box.x).toBe(10);
  });
  it('resizes each corner, preserving the opposite corner and a one-pixel minimum', () => {
    expect(resizeBox(box, 'nw', { x: -5, y: -5 }, bounds)).toEqual({ ...box, x: 0, y: 0, width: 40, height: 60 });
    expect(resizeBox(box, 'ne', { x: 200, y: 50 }, bounds)).toEqual({ ...box, y: 50, width: 90, height: 10 });
    expect(resizeBox(box, 'sw', { x: 50, y: 100 }, bounds)).toEqual({ ...box, x: 39, width: 1, height: 60 });
    expect(resizeBox(box, 'se', { x: 0, y: 0 }, bounds)).toEqual({ ...box, width: 1, height: 1 });
  });
  it('moves polygon vertices together and leaves absent keypoints unchanged', () => {
    const polygon: Annotation = { ...box, kind: 'polygon', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }] };
    expect(translateAnnotation(polygon, { x: -50, y: 70 }, bounds)).toMatchObject({
      points: [{ x: 0, y: 70 }, { x: 10, y: 70 }, { x: 10, y: 80 }],
    });
    const keypoints: Annotation = { ...box, kind: 'keypoints', skeletonId: 'skeleton',
      points: [{ x: 10, y: 10, visibility: 'visible' }, { x: 0, y: 0, visibility: 'absent' }] };
    expect(translateAnnotation(keypoints, { x: 5, y: 5 }, bounds)).toMatchObject({
      points: [{ x: 15, y: 15, visibility: 'visible' }, { x: 0, y: 0, visibility: 'absent' }],
    });
  });
});

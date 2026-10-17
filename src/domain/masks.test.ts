import { describe, expect, it } from 'vitest';
import { checkTile, maskRle, paintMask, TILE_BYTES } from './masks';
import type { Mask } from './masks';

const mask = (): Mask => ({ id: crypto.randomUUID(), classId: crypto.randomUUID(), attributes: {},
  kind: 'mask', width: 512, height: 512, tileSize: 256, tiles: [] });
describe('binary tiled masks', () => {
  it('paints continuous strokes across tile boundaries, preserves inputs, and erases exactly', () => {
    const original = mask();
    const painted = paintMask(original, new Map(), [{ x: 250, y: 255 }, { x: 265, y: 255 }], 4, false);
    expect(original.tiles).toEqual([]);
    expect(painted.tiles).toHaveLength(4);
    const pixels = new Map(painted.tiles.map(tile => [tile.id, new Uint8Array(tile.pixels)]));
    const before = [...pixels.values()].map(bytes => bytes.slice());
    const rle = maskRle(painted.mask, pixels);
    expect(rle.area).toBeGreaterThan(100);
    expect(rle.segmentation.counts.reduce((a, b) => a + b, 0)).toBe(512 * 512);
    const erased = paintMask(painted.mask, pixels, [{ x: 250, y: 255 }, { x: 265, y: 255 }], 4, true);
    expect(erased.mask.tiles).toEqual([]);
    expect([...pixels.values()]).toEqual(before);
  });
  it('clips to image edges and rejects malformed/oversized strokes and nonbinary tiles', () => {
    const painted = paintMask({ ...mask(), width: 3, height: 2 }, new Map(), [{ x: 0, y: 0 }], 10, false);
    const pixels = new Map(painted.tiles.map(tile => [tile.id, new Uint8Array(tile.pixels)]));
    expect(maskRle(painted.mask, pixels)).toMatchObject({ area: 6, bbox: [0, 0, 3, 2],
      segmentation: { size: [2, 3], counts: [0, 6] } });
    expect(() => paintMask(mask(), new Map(), [{ x: NaN, y: 1 }], 1, false)).toThrow();
    expect(() => paintMask(mask(), new Map(), [{ x: 1, y: 1 }], 129, false)).toThrow();
    expect(() => checkTile(new Uint8Array(TILE_BYTES).fill(2))).toThrow('binary');
    expect(() => paintMask(painted.mask, new Map(), [{ x: 1, y: 1 }], 1, true)).toThrow('not loaded');
  });
});

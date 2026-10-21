import { describe, expect, it } from 'vitest';
import { normalizeLocalDetections } from './local-detections';

describe('pinned local detector output', () => {
  it('normalizes percentages, filters low confidence, sorts and caps suggestions', () => {
    const result = normalizeLocalDetections([
      { label: 'cat', score: 0.8, box: { xmin: 10, ymin: 20, xmax: 60, ymax: 80 } },
      { label: 'weak', score: 0.2, box: { xmin: 0, ymin: 0, xmax: 100, ymax: 100 } },
      ...Array.from({ length: 35 }, (_, index) => ({
        label: `object ${index}`, score: 0.3 + index / 100,
        box: { xmin: 1, ymin: 2, xmax: 10, ymax: 20 },
      })),
    ]);
    expect(result).toHaveLength(32);
    expect(result[0]?.label).toBe('cat');
    expect(result[1]?.label).toBe('object 34');
    expect(result[1]?.confidence).toBeCloseTo(0.64);
    expect(result[1]?.x).toBeCloseTo(0.01);
    expect(result[1]?.y).toBeCloseTo(0.02);
    expect(result[1]?.width).toBeCloseTo(0.09);
    expect(result[1]?.height).toBeCloseTo(0.18);
    expect(result.some(item => item.label === 'weak')).toBe(false);
  });

  it('rejects malformed, nonfinite, reversed and over-limit model outputs', () => {
    expect(() => normalizeLocalDetections([{ label: 'bad', score: Number.NaN,
      box: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }])).toThrow();
    expect(() => normalizeLocalDetections([{ label: 'bad', score: 0.9,
      box: { xmin: 80, ymin: 0, xmax: 20, ymax: 1 } }])).toThrow();
    expect(() => normalizeLocalDetections(Array.from({ length: 301 }, () => ({
      label: 'object', score: 0.9, box: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    })))).toThrow();
  });
});

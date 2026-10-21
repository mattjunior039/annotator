import { z } from 'zod';
import { detectionsSchema } from './cloud-vision';
import type { Detection } from './cloud-vision';

const boxSchema = z.strictObject({
  xmin: z.number().finite().min(0).max(100),
  ymin: z.number().finite().min(0).max(100),
  xmax: z.number().finite().gt(0).max(100),
  ymax: z.number().finite().gt(0).max(100),
}).refine(box => box.xmax > box.xmin && box.ymax > box.ymin, 'Model boxes must have positive area.');
const outputSchema = z.array(z.strictObject({
  label: z.string().trim().min(1).max(80),
  score: z.number().finite().min(0).max(1),
  box: boxSchema,
})).max(300);

export function normalizeLocalDetections(value: unknown): Detection[] {
  const outputs = outputSchema.parse(value).filter(item => item.score >= 0.25)
    .sort((left, right) => right.score - left.score).slice(0, 32);
  return detectionsSchema.parse(outputs.flatMap(item => {
    const x = item.box.xmin / 100, y = item.box.ymin / 100;
    const right = item.box.xmax / 100, bottom = item.box.ymax / 100;
    if (right <= x || bottom <= y) return [];
    return [{ label: item.label, x, y, width: right - x, height: bottom - y, confidence: item.score }];
  }));
}

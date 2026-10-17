import type { Annotation } from './model';

export interface Point { x: number; y: number }
export interface Bounds { width: number; height: number }
export type BoxCorner = 'nw' | 'ne' | 'sw' | 'se';
type Box = Extract<Annotation, { kind: 'box' }>;

export function translateAnnotation(annotation: Annotation, delta: Point, bounds: Bounds): Annotation {
  const points = annotation.kind === 'box'
    ? [annotation, { x: annotation.x + annotation.width, y: annotation.y + annotation.height }]
    : annotation.kind === 'polygon' ? annotation.points
    : annotation.kind === 'keypoints' ? annotation.points.filter(point => point.visibility !== 'absent')
    : [];
  if (!points.length) return annotation;
  const dx = Math.max(-Math.min(...points.map(p => p.x)),
    Math.min(bounds.width - Math.max(...points.map(p => p.x)), delta.x));
  const dy = Math.max(-Math.min(...points.map(p => p.y)),
    Math.min(bounds.height - Math.max(...points.map(p => p.y)), delta.y));
  if (annotation.kind === 'box') return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
  if (annotation.kind === 'polygon') return {
    ...annotation, points: annotation.points.map(point => ({ x: point.x + dx, y: point.y + dy })),
  };
  if (annotation.kind === 'keypoints') return {
    ...annotation, points: annotation.points.map(point => point.visibility === 'absent'
      ? point : { ...point, x: point.x + dx, y: point.y + dy }),
  };
  return annotation;
}

export function resizeBox(box: Box, corner: BoxCorner, point: Point, bounds: Bounds): Box {
  const left = corner.includes('w') ? Math.max(0, Math.min(box.x + box.width - 1, point.x)) : box.x;
  const top = corner.includes('n') ? Math.max(0, Math.min(box.y + box.height - 1, point.y)) : box.y;
  const right = corner.includes('e')
    ? Math.min(bounds.width, Math.max(box.x + 1, point.x)) : box.x + box.width;
  const bottom = corner.includes('s')
    ? Math.min(bounds.height, Math.max(box.y + 1, point.y)) : box.y + box.height;
  return { ...box, x: left, y: top, width: right - left, height: bottom - top };
}

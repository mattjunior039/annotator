export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface ViewTransform { scale: number; offset: Point }
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

function assertSize(size: Size): void {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) ||
      size.width <= 0 || size.height <= 0) throw new Error('Image dimensions must be positive integers.');
}
function assertPoint(p: Point): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Point coordinates must be finite.');
}

export function orientedSize(size: Size, orientation: Orientation): Size {
  assertSize(size);
  return orientation >= 5 ? { width: size.height, height: size.width } : { ...size };
}

// Coordinates describe pixel edges, so an image occupies [0,width] x [0,height].
export function orientPoint(p: Point, size: Size, orientation: Orientation): Point {
  assertSize(size);
  assertPoint(p);
  const { width: w, height: h } = size;
  switch (orientation) {
    case 1: return { ...p };
    case 2: return { x: w - p.x, y: p.y };
    case 3: return { x: w - p.x, y: h - p.y };
    case 4: return { x: p.x, y: h - p.y };
    case 5: return { x: p.y, y: p.x };
    case 6: return { x: h - p.y, y: p.x };
    case 7: return { x: h - p.y, y: w - p.x };
    case 8: return { x: p.y, y: w - p.x };
  }
}

function assertTransform(t: ViewTransform): void {
  if (!Number.isFinite(t.scale) || t.scale <= 0 ||
      !Number.isFinite(t.offset.x) || !Number.isFinite(t.offset.y)) {
    throw new Error('Invalid viewport transform.');
  }
}

export function imageToScreen(p: Point, t: ViewTransform): Point {
  assertPoint(p);
  assertTransform(t);
  return { x: p.x * t.scale + t.offset.x, y: p.y * t.scale + t.offset.y };
}

export function screenToImage(p: Point, t: ViewTransform): Point {
  assertPoint(p);
  assertTransform(t);
  return { x: (p.x - t.offset.x) / t.scale, y: (p.y - t.offset.y) / t.scale };
}

export function signedArea(points: readonly Point[]): number {
  return points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length]!;
    return sum + p.x * next.y - next.x * p.y;
  }, 0) / 2;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return cross(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0) ||
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export function isSimpleClockwisePolygon(points: readonly Point[]): boolean {
  if (points.length < 3 || points.length > 4096 ||
      points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || signedArea(points) <= 0) return false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    if (a.x === b.x && a.y === b.y) return false;
    const previous = points[(i + points.length - 1) % points.length]!;
    if (cross(previous, a, b) === 0) return false;
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (intersects(a, b, points[j]!, points[(j + 1) % points.length]!)) return false;
    }
  }
  return true;
}

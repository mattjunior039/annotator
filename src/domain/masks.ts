import { z } from 'zod';
import type { AnnotationDocument } from './model';

export const TILE_SIZE = 256;
export const TILE_BYTES = TILE_SIZE * TILE_SIZE;
export const MAX_IMAGE_TILES = 128;
export const maskTileSchema = z.strictObject({
  id: z.uuid(), pixels: z.instanceof(ArrayBuffer).refine(buffer => buffer.byteLength === TILE_BYTES, 'Invalid mask tile size.'),
});
export type MaskTile = z.infer<typeof maskTileSchema>;
export type Mask = Extract<AnnotationDocument['annotations'][number], { kind: 'mask' }>;

export function maskIds(document: AnnotationDocument): string[] {
  const ids = document.annotations.flatMap(item => item.kind === 'mask' ? item.tiles.map(tile => tile.blobId) : []);
  if (ids.length > MAX_IMAGE_TILES || new Set(ids).size !== ids.length) {
    throw new Error('Workspace masks exceed the 128-tile image budget or reuse tile IDs.');
  }
  return ids;
}

export function checkTile(pixels: Uint8Array): void {
  if (pixels.length !== TILE_BYTES || pixels.some(value => value !== 0 && value !== 1)) {
    throw new Error('Workspace mask tiles must contain exactly 65,536 binary pixels.');
  }

}

export function checkMaskPayloads(document: AnnotationDocument, tiles: readonly MaskTile[]): void {
  const ids = new Set(maskIds(document)), supplied = new Map(tiles.map(tile => [tile.id, tile]));
  if (ids.size !== tiles.length || supplied.size !== tiles.length || [...ids].some(id => !supplied.has(id))) {
    throw new Error('Workspace mask references require their exact tile data.');
  }
  for (const annotation of document.annotations) if (annotation.kind === 'mask') for (const tile of annotation.tiles) {
    const bytes = new Uint8Array(supplied.get(tile.blobId)!.pixels);
    checkTile(bytes);
    for (let index = 0; index < TILE_BYTES; index++) if (bytes[index] &&
        (tile.x + index % TILE_SIZE >= annotation.width || tile.y + Math.floor(index / TILE_SIZE) >= annotation.height)) {
      throw new Error('Workspace mask tile contains pixels outside the image.');
    }
  }
}

export function paintMask(
  before: Mask, existing: ReadonlyMap<string, Uint8Array>, points: readonly { x: number; y: number }[],
  radius: number, erase: boolean,
): { mask: Mask; tiles: MaskTile[] } {
  if (!Number.isFinite(radius) || radius < 0.5 || radius > 128 || points.length < 1 || points.length > 4096 ||
      points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error('Invalid mask brush stroke.');
  }
  const grid = new Map(before.tiles.map(tile => [`${tile.x}:${tile.y}`, tile]));
  const changed = new Map<string, { x: number; y: number; pixels: Uint8Array<ArrayBuffer> }>();
  let samples = 0;
  const dab = (x: number, y: number) => {
    if (++samples > 50_000) throw new Error('Mask stroke is too long. Use shorter strokes.');
    const left = Math.max(0, Math.floor(x - radius)), right = Math.min(before.width - 1, Math.floor(x + radius));
    const top = Math.max(0, Math.floor(y - radius)), bottom = Math.min(before.height - 1, Math.floor(y + radius));
    for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
      if ((px + 0.5 - x) ** 2 + (py + 0.5 - y) ** 2 > radius ** 2) continue;
      const tx = Math.floor(px / TILE_SIZE) * TILE_SIZE, ty = Math.floor(py / TILE_SIZE) * TILE_SIZE;
      const key = `${tx}:${ty}`;
      let tile = changed.get(key);
      if (!tile) {
        if (changed.size >= 64) throw new Error('Mask stroke exceeds 64 tiles. Use shorter strokes.');
        const original = grid.get(key);
        const source = original && existing.get(original.blobId);
        if (original && !source) throw new Error('Workspace mask pixels are not loaded.');
        if (source) checkTile(source);
        tile = { x: tx, y: ty, pixels: source ? new Uint8Array(source) : new Uint8Array(TILE_BYTES) };
        changed.set(key, tile);
      }
      tile.pixels[(py - ty) * TILE_SIZE + px - tx] = erase ? 0 : 1;
    }
  };
  for (let i = 0; i < points.length; i++) {
    const end = points[i]!, start = points[Math.max(0, i - 1)]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / Math.max(0.5, radius / 2)));
    if (steps + samples > 50_000) throw new Error('Mask stroke is too long. Use shorter strokes.');
    for (let step = 1; step <= steps; step++) dab(start.x + (end.x - start.x) * step / steps, start.y + (end.y - start.y) * step / steps);
  }
  const tiles: MaskTile[] = [];
  for (const [key, tile] of changed) {
    const original = grid.get(key), source = original && existing.get(original.blobId);
    if (source && source.every((value, index) => value === tile.pixels[index])) continue;
    if (!tile.pixels.some(Boolean)) { grid.delete(key); continue; }
    const id = crypto.randomUUID();
    tiles.push({ id, pixels: tile.pixels.buffer });
    grid.set(key, { x: tile.x, y: tile.y, blobId: id });
  }
  if (grid.size > MAX_IMAGE_TILES) throw new Error('Workspace mask exceeds the 128-tile image budget.');
  return { mask: { ...before, tiles: [...grid.values()].sort((a, b) => a.y - b.y || a.x - b.x) }, tiles };
}

export function maskRle(mask: Mask, pixels: ReadonlyMap<string, Uint8Array>) {
  const grid = new Map(mask.tiles.map(tile => [`${tile.x}:${tile.y}`, tile]));
  const counts: number[] = [];
  let value = 0, run = 0, area = 0;
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
  if (mask.width * mask.height > 4_000_000) throw new Error('Workspace mask raster exceeds four million pixels.');
  for (const tile of mask.tiles) {
    const bytes = pixels.get(tile.blobId);
    if (!bytes) throw new Error('Workspace mask tile is missing.');
    checkTile(bytes);
  }
  for (let x = 0; x < mask.width; x++) for (let y = 0; y < mask.height; y++) {
    const tx = Math.floor(x / TILE_SIZE) * TILE_SIZE, ty = Math.floor(y / TILE_SIZE) * TILE_SIZE;
    const tile = grid.get(`${tx}:${ty}`);
    const next = tile ? pixels.get(tile.blobId)![(y - ty) * TILE_SIZE + x - tx]! : 0;
    if (next === value) run++;
    else { counts.push(run); run = 1; value = next; }
    if (next) { area++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  counts.push(run);
  return { segmentation: { size: [mask.height, mask.width], counts }, area,
    bbox: area ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : [0, 0, 0, 0] };
}

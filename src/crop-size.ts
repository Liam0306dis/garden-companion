/**
 * Crop size, across the two models the game has shipped.
 *
 * Old model: a grown crop carries `targetScale`, a multiplier from 1 up to the crop's `maxScale`,
 * and the game shows that as a 50-100% size (scale 1 is 50%, maxScale is 100%).
 *
 * New model (the size update): a crop carries an integer `size` from 50 to 100 directly, the catalog
 * gives `maxSizeMultiplier` in place of `maxScale`, and the scale a crop renders and weighs at is
 * `1 + (maxSizeMultiplier - 1) * (size - 50)/50` - so size 50 is 1x and size 100 is the full
 * multiplier. Size boost abilities add a flat whole number to `size`, capped at 100 for every crop.
 *
 * These read whichever fields are present, so the same code serves both until the update goes live.
 */

export const BASE_SIZE = 50;
export const MAX_SIZE = 100;

interface CropEntry { maxScale?: number; maxSizeMultiplier?: number }
interface CropSlot { size?: number; targetScale?: number }

/** A crop's maximum size multiplier: the new field when present, otherwise the old `maxScale`. */
export function maxSizeMultiplier(crop: CropEntry | undefined | null): number {
  return Number(crop?.maxSizeMultiplier ?? crop?.maxScale) || 1;
}

function clampSize(size: number): number {
  return Math.max(BASE_SIZE, Math.min(MAX_SIZE, Number(size)));
}

/** The scale a grown crop renders and weighs at, reading whichever size field the slot carries. */
export function slotScale(crop: CropEntry | undefined | null, slot: CropSlot | undefined | null): number {
  if (slot?.size != null && crop?.maxSizeMultiplier != null) {
    return 1 + (Number(crop.maxSizeMultiplier) - 1) * (clampSize(slot.size) - BASE_SIZE) / (MAX_SIZE - BASE_SIZE);
  }
  return Number(slot?.targetScale ?? 1);
}

/** Whether a grown crop is at maximum size, from either model. */
export function slotIsMaxSize(crop: CropEntry | undefined | null, slot: CropSlot | undefined | null): boolean {
  if (slot?.size != null) return Number(slot.size) >= MAX_SIZE;
  const max = Number(crop?.maxScale);
  return max > 0 && Number(slot?.targetScale ?? 0) >= max - 1e-6;
}

/** The new-model size (50-100) that renders at a given scale multiplier. Inverse of `slotScale`. */
export function sizeFromScale(maxMult: number, scale: number): number {
  if (maxMult <= 1) return BASE_SIZE;
  const size = BASE_SIZE + (MAX_SIZE - BASE_SIZE) * (scale - 1) / (maxMult - 1);
  return Math.round(Math.max(BASE_SIZE, Math.min(MAX_SIZE, size)));
}

/** The 50-100 size percentage the game shows for a grown crop. */
export function slotSizePercent(crop: CropEntry | undefined | null, slot: CropSlot | undefined | null): number {
  if (slot?.size != null) return Math.round(clampSize(slot.size));
  const max = Number(crop?.maxScale) || 1;
  const scale = Number(slot?.targetScale ?? 1);
  if (scale <= 1 || max <= 1) return BASE_SIZE;
  if (scale >= max) return MAX_SIZE;
  return Math.floor(BASE_SIZE + 50 * (scale - 1) / (max - 1));
}

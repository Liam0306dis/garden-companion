/**
 * Crop size.
 *
 * A crop carries an integer `size` from 50 to 100, the catalog gives the crop's
 * `maxSizeMultiplier`, and the scale a crop renders and weighs at is
 * `1 + (maxSizeMultiplier - 1) * (size - 50)/50` - so size 50 is 1x and size 100 is the full
 * multiplier. Size boost abilities add a flat whole number to `size`, capped at 100 for every crop.
 */

export const BASE_SIZE = 50;
export const MAX_SIZE = 100;

interface CropEntry { maxSizeMultiplier?: number }
interface CropSlot { size?: number }

/** A crop's maximum size multiplier. */
export function maxSizeMultiplier(crop: CropEntry | undefined | null): number {
  return Number(crop?.maxSizeMultiplier) || 1;
}

/** Rounded and clamped, as the game does before using a size for anything; unreadable is 50. */
function clampSize(size: number): number {
  const value = Number(size);
  return Number.isFinite(value) ? Math.min(MAX_SIZE, Math.max(BASE_SIZE, Math.round(value))) : BASE_SIZE;
}

/** The scale a grown crop renders and weighs at. */
export function slotScale(crop: CropEntry | undefined | null, slot: CropSlot | undefined | null): number {
  if (slot?.size == null) return 1;
  return 1 + (maxSizeMultiplier(crop) - 1) * (clampSize(slot.size) - BASE_SIZE) / (MAX_SIZE - BASE_SIZE);
}

/** Whether a grown crop is at maximum size. */
export function slotIsMaxSize(slot: CropSlot | undefined | null): boolean {
  return slot?.size != null && Number(slot.size) >= MAX_SIZE;
}

/** The size (50-100) that renders at a given scale multiplier. Inverse of `slotScale`. */
export function sizeFromScale(maxMult: number, scale: number): number {
  if (maxMult <= 1) return BASE_SIZE;
  const size = BASE_SIZE + (MAX_SIZE - BASE_SIZE) * (scale - 1) / (maxMult - 1);
  return Math.round(Math.max(BASE_SIZE, Math.min(MAX_SIZE, size)));
}

/** The 50-100 size percentage the game shows for a grown crop. */
export function slotSizePercent(slot: CropSlot | undefined | null): number {
  return slot?.size != null ? clampSize(slot.size) : BASE_SIZE;
}

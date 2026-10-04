/**
 * Cutting one sprite out of a decoded atlas sheet. Shared by the sprite worker and the main-thread
 * fallback, so both produce exactly the same pixels whichever one ends up doing the work.
 */

export interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  rotated?: boolean | number;
}

/** One sprite to cut: `trimmed` drops the atlas padding and keeps only the packed pixels. */
export interface CropJob { key: string; frame: AtlasFrame; trimmed: boolean }

/** A finished sprite, keyed as it was asked for. */
export type CropResult = [key: string, trimmed: boolean, dataUrl: string];

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The size of the canvas a frame is drawn into, and where in it the frame lands. */
export function frameLayout(descriptor: AtlasFrame, trimmed: boolean): { width: number; height: number; placement: { x: number; y: number } } {
  const frame = descriptor.frame;
  const trim = trimmed ? { x: 0, y: 0, w: frame.w, h: frame.h } : null;
  const placement = trim ?? descriptor.spriteSourceSize ?? { x: 0, y: 0, w: frame.w, h: frame.h };
  const source = trim ?? descriptor.sourceSize ?? { w: placement.x + frame.w, h: placement.y + frame.h };
  return { width: source.w, height: source.h, placement };
}

export function drawFrame(context: Context2D, sheet: CanvasImageSource | OffscreenCanvas, descriptor: AtlasFrame, placement: { x: number; y: number }): void {
  const frame = descriptor.frame;
  context.imageSmoothingEnabled = false;
  if (descriptor.rotated) {
    context.save();
    context.translate(placement.x + frame.w / 2, placement.y + frame.h / 2);
    context.rotate(-Math.PI / 2);
    context.drawImage(sheet, frame.x, frame.y, frame.h, frame.w, -frame.h / 2, -frame.w / 2, frame.h, frame.w);
    context.restore();
  } else {
    context.drawImage(sheet, frame.x, frame.y, frame.w, frame.h, placement.x, placement.y, frame.w, frame.h);
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * How long a decoded sheet is kept after it was last used. The startup pass and the panel pass cut
 * different sprites from the same sheets, so holding them briefly saves transcoding each one twice;
 * a full-size sheet is tens of megabytes, so they are not held any longer than that.
 */
export const SHEET_TTL_MS = 60_000;

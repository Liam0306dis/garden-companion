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

/**
 * One sprite to cut: `trimmed` drops the atlas padding and keeps only the packed pixels. `atlasWidth`
 * is the width the frame coordinates are measured in (the atlas's `meta.size.w`); a sheet decoded at
 * a smaller size is read at that ratio and the sprite drawn back at full size.
 */
export interface CropJob { key: string; frame: AtlasFrame; trimmed: boolean; atlasWidth?: number }

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

/**
 * Build 1973 stopped shipping a full-size sheet for most atlases - the largest is half size, and the
 * smallest pack has only its quarter-size one - while the frame coordinates stay in full-size space.
 * The sheet is read at its own scale and the sprite drawn back at full size, smoothed like the game
 * smooths the same texture, so sprites keep the size every caller lays them out at.
 */
export function drawFrame(context: Context2D, sheet: HTMLCanvasElement | OffscreenCanvas, descriptor: AtlasFrame, placement: { x: number; y: number }, atlasWidth?: number): void {
  const frame = descriptor.frame;
  const scale = atlasWidth && sheet.width ? sheet.width / atlasWidth : 1;
  context.imageSmoothingEnabled = scale !== 1;
  if (scale !== 1) context.imageSmoothingQuality = 'high';
  const sw = frame.w * scale;
  const sh = frame.h * scale;
  if (descriptor.rotated) {
    context.save();
    context.translate(placement.x + frame.w / 2, placement.y + frame.h / 2);
    context.rotate(-Math.PI / 2);
    context.drawImage(sheet, frame.x * scale, frame.y * scale, sh, sw, -frame.h / 2, -frame.w / 2, frame.h, frame.w);
    context.restore();
  } else {
    context.drawImage(sheet, frame.x * scale, frame.y * scale, sw, sh, placement.x, placement.y, frame.w, frame.h);
  }
}

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
/** VK_FORMAT_R8G8B8A8_UNORM and _SRGB: plain 8-bit RGBA, stored as-is. */
const RAW_RGBA_FORMATS = new Set([37, 43]);

/**
 * The pixels of a KTX2 sheet that holds plain RGBA, or null for anything else (a Basis sheet, which
 * needs the transcoder). Build 1973 dropped Basis for sheets pre-encoded per GPU format, listed in
 * `manifest.<format>.json`; the `rgba8` set is the one readable without a GPU decoder.
 *
 * Its pixels are premultiplied - the game uploads them as such, though the file's descriptor does not
 * say so - while ImageData is straight alpha, so each is divided back out. Left as they were, every
 * soft edge came out dark.
 */
export function rawKtx2Pixels(buffer: ArrayBuffer): ImageData | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 104 || !KTX2_IDENTIFIER.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(buffer);
  if (!RAW_RGBA_FORMATS.has(view.getUint32(12, true)) || view.getUint32(44, true) !== 0) return null;
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const offset = Number(view.getBigUint64(80, true));
  const length = Number(view.getBigUint64(88, true));
  if (!width || !height || length !== width * height * 4 || offset + length > buffer.byteLength) return null;
  const pixels = new Uint8ClampedArray(buffer.slice(offset, offset + length));
  for (let index = 0; index < length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    const factor = 255 / alpha;
    pixels[index] *= factor;
    pixels[index + 1] *= factor;
    pixels[index + 2] *= factor;
  }
  return new ImageData(pixels, width, height);
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

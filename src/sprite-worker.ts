/**
 * The sprite worker: fetches an atlas sheet, transcodes it, cuts the wanted sprites out of it and
 * encodes each one as a PNG - all off the game's main thread. Transcoding a full-size sheet is a
 * single blocking call that runs for a noticeable fraction of a second, and encoding a few hundred
 * PNGs adds up to more; here neither can hold a frame of the game.
 *
 * Built on its own and started from a blob url by the sprite loader, which falls back to doing the
 * same work itself if a page refuses workers.
 */
import { BasisUniversal, TranscoderTextureFormat } from '@h00w/basis-universal-transcoder';
import { blobToDataUrl, drawFrame, frameLayout, SHEET_TTL_MS, type CropJob, type CropResult } from './sprite-crop.js';

interface BasisTranscoder {
  init(bytes: Uint8Array): boolean;
  startTranscoding(): boolean;
  transcodeImageLevel(options: { format: number; level: number; layer: number; face: number }): { data: ArrayBuffer; width: number; height: number } | null;
}

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

type Request =
  | { type: 'init'; wasm: ArrayBuffer }
  | { type: 'decode'; id: number; sheetUrl: string; jobs: CropJob[] };

const scope = self as unknown as WorkerScope;
let transcoder: Promise<BasisTranscoder> | null = null;
const sheets = new Map<string, { sheet: Promise<OffscreenCanvas | null>; timer: number }>();
// One decode at a time: a second sheet arriving mid-decode would only double the memory held.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = event => {
  const request = event.data as Request;
  if (request.type === 'init') void init(request.wasm);
  else if (request.type === 'decode') queue = queue.then(() => decode(request.id, request.sheetUrl, request.jobs));
};

async function init(wasm: ArrayBuffer): Promise<void> {
  try {
    // A worker without a 2D OffscreenCanvas cannot cut sprites, so it hands the job back.
    if (typeof OffscreenCanvas !== 'function' || !new OffscreenCanvas(1, 1).getContext('2d')) throw new Error('No OffscreenCanvas');
    transcoder = BasisUniversal.getInstance(imports => WebAssembly.instantiate(wasm, imports as WebAssembly.Imports))
      // One transcoder reused for every sheet, as the library recommends, rather than one per sheet.
      .then(basis => (basis as unknown as { createKTX2Transcoder(): BasisTranscoder }).createKTX2Transcoder());
    await transcoder;
    scope.postMessage({ type: 'ready' });
  } catch {
    scope.postMessage({ type: 'unsupported' });
  }
}

/** A sheet from the short-lived cache, decoding it first if it is not there. */
function sheetFor(url: string): Promise<OffscreenCanvas | null> {
  let entry = sheets.get(url);
  if (!entry) {
    entry = { sheet: decodeSheet(url), timer: 0 };
    sheets.set(url, entry);
  }
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => sheets.delete(url), SHEET_TTL_MS) as unknown as number;
  // A failed sheet is not kept, so the next pass gets a fresh attempt.
  void entry.sheet.then(sheet => { if (!sheet) sheets.delete(url); });
  return entry.sheet;
}

async function decodeSheet(url: string): Promise<OffscreenCanvas | null> {
  try {
    const response = await fetch(url);
    if (!response.ok || !transcoder) return null;
    const ktx2 = await transcoder;
    if (!ktx2.init(new Uint8Array(await response.arrayBuffer())) || !ktx2.startTranscoding()) return null;
    const decoded = ktx2.transcodeImageLevel({ format: TranscoderTextureFormat.cTFRGBA32, level: 0, layer: 0, face: 0 });
    if (!decoded) return null;
    const canvas = new OffscreenCanvas(decoded.width, decoded.height);
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height), 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

async function decode(id: number, sheetUrl: string, jobs: CropJob[]): Promise<void> {
  try {
    const sheet = await sheetFor(sheetUrl);
    if (!sheet) { scope.postMessage({ id, results: null }); return; }
    const results: CropResult[] = [];
    for (const job of jobs) {
      const { width, height, placement } = frameLayout(job.frame, job.trimmed);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) continue;
      drawFrame(context, sheet, job.frame, placement);
      results.push([job.key, job.trimmed, await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }))]);
    }
    scope.postMessage({ id, results });
  } catch {
    scope.postMessage({ id, results: null });
  }
}

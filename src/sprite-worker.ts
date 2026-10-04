/**
 * The sprite worker: everything slow about building sprites, done off the game's main thread.
 *
 * Atlas sheets are fetched, transcoded, cut into sprites and encoded as PNGs. Transcoding a sheet is
 * a single blocking call, and encoding a few hundred PNGs adds up to more; here neither can hold a
 * frame of the game.
 *
 * Current pets are not in any atlas - they exist only in the game's Rive file - so they are drawn
 * here too, with Rive's low-level runtime. Starting that runtime and parsing the pet file were the
 * last long stalls left on the main thread. Each pet needs one still frame, so there is no render
 * loop: the file is parsed once and every pet is posed and drawn a single time.
 *
 * Built on its own and started from a blob url by the sprite loader, which falls back to doing the
 * same work itself if a page refuses workers. Both libraries arrive as messages, and only when there
 * is work for them.
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

/** The slice of Rive's low-level runtime used here. */
interface RiveLow {
  load(bytes: Uint8Array): Promise<RiveFile>;
  makeRenderer(canvas: OffscreenCanvas): RiveRenderer;
  StateMachineInstance: new (machine: unknown, artboard: RiveArtboard) => { advance(seconds: number): void; delete(): void };
  Fit: { contain: unknown };
  Alignment: { center: unknown };
  resolveAnimationFrame(): void;
}
interface RiveFile { artboardByName(name: string): RiveArtboard | null; delete(): void }
interface RiveArtboard {
  bounds: unknown;
  stateMachineByName(name: string): unknown;
  advance(seconds: number): void;
  draw(renderer: RiveRenderer): void;
  delete(): void;
}
interface RiveRenderer {
  clear(): void;
  save(): void;
  restore(): void;
  align(fit: unknown, alignment: unknown, frame: unknown, content: unknown): void;
  flush(): void;
  delete(): void;
}

type Request =
  | { type: 'init' }
  | { type: 'basis'; wasm: ArrayBuffer }
  | { type: 'decode'; id: number; sheetUrl: string; jobs: CropJob[] }
  | { type: 'rive'; id: number; source: string; file: ArrayBuffer; pets: Array<[species: string, artboard: string]> };

declare function importScripts(...urls: string[]): void;

const scope = self as unknown as WorkerScope;
let transcoder: Promise<BasisTranscoder> | null = null;
const sheets = new Map<string, { sheet: Promise<OffscreenCanvas | null>; timer: number }>();
// One job at a time: a second sheet arriving mid-decode would only double the memory held.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = event => {
  const request = event.data as Request;
  if (request.type === 'init') init();
  else if (request.type === 'basis') loadBasis(request.wasm);
  else if (request.type === 'decode') queue = queue.then(() => decode(request.id, request.sheetUrl, request.jobs));
  else if (request.type === 'rive') queue = queue.then(() => renderPets(request.id, request.source, request.file, request.pets));
};

function init(): void {
  // A worker without a 2D OffscreenCanvas cannot draw anything, so it hands the work back.
  const usable = typeof OffscreenCanvas === 'function' && Boolean(new OffscreenCanvas(1, 1).getContext('2d'));
  scope.postMessage({ type: usable ? 'ready' : 'unsupported' });
}

function loadBasis(wasm: ArrayBuffer): void {
  transcoder = BasisUniversal.getInstance(imports => WebAssembly.instantiate(wasm, imports as WebAssembly.Imports))
    // One transcoder reused for every sheet, as the library recommends, rather than one per sheet.
    .then(basis => (basis as unknown as { createKTX2Transcoder(): BasisTranscoder }).createKTX2Transcoder());
  // A failure surfaces as every sheet decode returning null; it must not go unhandled meanwhile.
  transcoder.catch(() => {});
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
    if (!transcoder) return null;
    const response = await fetch(url);
    if (!response.ok) return null;
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

async function encode(canvas: OffscreenCanvas): Promise<string> {
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
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
      results.push([job.key, job.trimmed, await encode(canvas)]);
    }
    scope.postMessage({ id, results });
  } catch {
    scope.postMessage({ id, results: null });
  }
}

// --- Rive ---

/**
 * Rive's 2D renderer was written for a page. It decodes the images embedded in a .riv with an
 * `Image` element and uploads them to a WebGL canvas it makes with `document.createElement` - and a
 * worker has neither. Both are supplied here: an `Image` that decodes through createImageBitmap,
 * and a `document` whose only canvas is an OffscreenCanvas. The stand-in image is not something
 * drawImage or texImage2D accept, so those two are taught to draw the bitmap it carries instead.
 */
let pendingImages = 0;
let imagesSettled: (() => void) | null = null;

function installRiveShims(): void {
  const global = self as unknown as Record<string, unknown>;
  if (global.__gcRiveShims) return;
  global.__gcRiveShims = true;

  class WorkerImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 0;
    height = 0;
    bitmap: ImageBitmap | null = null;
    set src(url: string) {
      pendingImages++;
      const settle = () => { if (--pendingImages === 0) imagesSettled?.(); };
      fetch(url).then(response => response.blob()).then(blob => createImageBitmap(blob)).then(bitmap => {
        this.bitmap = bitmap;
        this.width = bitmap.width;
        this.height = bitmap.height;
        try { this.onload?.(); } finally { settle(); }
      }, () => { try { this.onerror?.(); } finally { settle(); } });
    }
  }
  global.Image = WorkerImage;
  global.document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`No ${tag} elements in the sprite worker.`);
      return Object.assign(new OffscreenCanvas(1, 1), { style: {} });
    },
  };

  const unwrap = (image: unknown) => (image instanceof WorkerImage ? image.bitmap : image);
  type AnyFn = (...args: unknown[]) => unknown;
  const teach = (proto: Record<string, unknown> | undefined, method: string, imageArg: number) => {
    const original = proto?.[method] as AnyFn | undefined;
    if (!proto || typeof original !== 'function') return;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      args[imageArg] = unwrap(args[imageArg]);
      return original.apply(this, args);
    };
  };
  const proto = (name: string) => (global[name] as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  teach(proto('OffscreenCanvasRenderingContext2D'), 'drawImage', 0);
  teach(proto('OffscreenCanvasRenderingContext2D'), 'createPattern', 0);
  // texImage2D takes the image last: (target, level, internalformat, format, type, source).
  for (const gl of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const target = proto(gl);
    const original = target?.texImage2D as AnyFn | undefined;
    if (!target || typeof original !== 'function') continue;
    target.texImage2D = function (this: unknown, ...args: unknown[]) {
      args[args.length - 1] = unwrap(args[args.length - 1]);
      return original.apply(this, args);
    };
  }
}

let rive: Promise<RiveLow> | null = null;

/** The runtime, from the source the loader sent. It ships as an ES module, so its export is rewired. */
function riveRuntime(source: string): Promise<RiveLow> {
  return rive ??= (async () => {
    installRiveShims();
    const code = source.replace(/export\s+default\s+Rive\s*;?\s*$/, 'self.__gcRiveFactory = Rive;');
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { importScripts(url); } finally { URL.revokeObjectURL(url); }
    const factory = (self as unknown as { __gcRiveFactory?: () => Promise<RiveLow> }).__gcRiveFactory;
    if (typeof factory !== 'function') throw new Error('Rive runtime did not load.');
    return factory();
  })().catch(error => { rive = null; throw error; });
}

/** Resolves once every embedded image Rive started decoding has finished. */
function imagesReady(): Promise<void> {
  if (pendingImages === 0) return Promise.resolve();
  return new Promise(resolve => { imagesSettled = () => { imagesSettled = null; resolve(); }; });
}

const PET_WIDTH = 360;
const PET_HEIGHT = 510;

/** Crops a rendered pet to its opaque pixels, padded and centred on a square; null if blank. */
function trimToContent(source: OffscreenCanvas): OffscreenCanvas | null {
  const context = source.getContext('2d');
  if (!context) return null;
  const { width, height } = source;
  const pixels = context.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const padding = Math.max(4, Math.ceil(Math.max(w, h) * 0.06));
  const size = Math.max(w, h) + padding * 2;
  const output = new OffscreenCanvas(size, size);
  output.getContext('2d')?.drawImage(source, minX, minY, w, h, (size - w) / 2, (size - h) / 2, w, h);
  return output;
}

async function renderPets(id: number, source: string, fileBytes: ArrayBuffer, pets: Array<[string, string]>): Promise<void> {
  let file: RiveFile | null = null;
  try {
    const runtime = await riveRuntime(source);
    file = await runtime.load(new Uint8Array(fileBytes));
    await imagesReady();
    const results: Array<[string, string]> = [];
    for (const [species, artboardName] of pets) {
      const canvas = new OffscreenCanvas(PET_WIDTH, PET_HEIGHT);
      let artboard: RiveArtboard | null = null;
      let machine: { advance(seconds: number): void; delete(): void } | null = null;
      let renderer: RiveRenderer | null = null;
      try {
        artboard = file.artboardByName(artboardName);
        if (!artboard) continue;
        // The state machine sets the pet's resting pose; advancing by zero applies it without
        // moving time on, which is the still frame an icon wants.
        const definition = artboard.stateMachineByName('Pet State Machine');
        if (definition) {
          machine = new runtime.StateMachineInstance(definition, artboard);
          machine.advance(0);
        }
        artboard.advance(0);
        renderer = runtime.makeRenderer(canvas);
        renderer.clear();
        renderer.save();
        renderer.align(runtime.Fit.contain, runtime.Alignment.center, { minX: 0, minY: 0, maxX: PET_WIDTH, maxY: PET_HEIGHT }, artboard.bounds);
        artboard.draw(renderer);
        renderer.restore();
        renderer.flush();
        runtime.resolveAnimationFrame();
        const trimmed = trimToContent(canvas);
        if (trimmed) results.push([species, await encode(trimmed)]);
      } catch {
        // One pet failing to draw leaves just that pet missing.
      } finally {
        try { machine?.delete(); } catch {}
        try { artboard?.delete(); } catch {}
        try { renderer?.delete(); } catch {}
      }
    }
    scope.postMessage({ id, pets: results });
  } catch (error) {
    scope.postMessage({ id, pets: null, error: String(error) });
  } finally {
    try { file?.delete(); } catch {}
  }
}

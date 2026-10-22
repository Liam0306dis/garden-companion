import { findAtom } from '../atom-cache.js';
import {
  CARVING_GRID, CARVING_MAX_BYTES, FACE, MIN_LINE_WIDTH, PICTURE_DETAIL, encodeCarving, lumaOver, otsuThreshold, pictureBackground,
  type CarvingStroke, type PictureBackground, type PictureExtent, type PictureMode, type PictureSettings, type TraceResult,
} from '../carving-trace.js';
import { runCarvingJob, type CarvingJob, type CarvingMessage, type CarvingReply } from '../carving-worker.js';
import { feature } from '../config.js';
import { sendQuinoaCommandAwaitingResult } from '../game-connection.js';
import { gameStore } from '../game-store.js';
import { pixiSurface, findVisiblePixiNodes } from '../pixi.js';
import { quinoaEngine } from '../quinoa-engine.js';
import { retryUntil } from '../retry.js';
import { createTicker } from '../ticker.js';
import { toast } from '../toast.js';
import type { JotaiAtom } from '../types.js';
import { warn } from '../diagnostics.js';

/**
 * Carving a pumpkin from a picture. While the game's carving window is open (a Carving Knife used
 * on a mature pumpkin) a Select a picture button sits over the pumpkin; a picture picked there, or
 * dropped on the page, is traced into cut-outs (see carving-trace.ts), previewed with a few sliders, and
 * sent as the game's own CarvePumpkin command for the pumpkin the window was opened on. The game's
 * window is closed after, so its Done button cannot save its old strokes over the new carving.
 */

const BUTTON_ID = 'gc-carve-import';
const DIALOG_ID = 'gc-carve-dialog';
const MODAL_NAME = 'pumpkinCarving';
/** The game's pumpkin, which the button is placed over. */
const ART_LABEL = 'CarvablePumpkin';
/** Preview pixels per grid unit. */
const PREVIEW_SCALE = 1.6;
/** The rows of the grid the face covers, which is all the preview needs to show. */
const PREVIEW_TOP = Math.floor(FACE.cy - FACE.ry) - 2;
const PREVIEW_BOTTOM = Math.ceil(FACE.cy + FACE.ry) + 2;

let modalAtom: JotaiAtom | null = null;
let targetAtom: JotaiAtom | null = null;
let carvingOpen = false;
let artNode: Record<string, any> | null = null;

interface CarvingTarget { localTileIndex: number; growSlotId: string | number }

function carvingTarget(): CarvingTarget | null {
  const store = gameStore();
  if (!store || !targetAtom) return null;
  const value = store.get(targetAtom) as Partial<CarvingTarget> | null;
  return value && Number.isInteger(value.localTileIndex) && value.growSlotId != null ? value as CarvingTarget : null;
}

function closeGameCarving(): void {
  const store = gameStore();
  if (!store || !modalAtom) return;
  const current = store.get(modalAtom) as { modal?: unknown; openId?: number } | null;
  if (current?.modal !== MODAL_NAME) return;
  // As the game's own close does it: no modal, and a fresh openId.
  store.set(modalAtom, { modal: null, openId: (Number(current.openId) || 0) + 1 });
}

/**
 * Puts strokes on the pumpkin in the game's open carving window, as if cut there, so they can be
 * changed with the knife and are only saved when its Done is pressed. The window is the modals
 * system's cached pumpkinCarving view (bundle 1708: `nue`), which keeps the cuts in `strokes`, in
 * the same shape as ours, with `history` behind its Undo - pushed to here, so Undo takes the picture
 * off again. False when the window cannot be found.
 */
function loadIntoGameCarving(strokes: CarvingStroke[]): boolean {
  const view = quinoaEngine()?.getSystem?.('modals')?.built?.get?.(MODAL_NAME) as Record<string, any> | undefined;
  if (!view || !view.target || !Array.isArray(view.strokes) || !Array.isArray(view.history) || typeof view.redraw !== 'function') return false;
  const copy = (list: CarvingStroke[]) => list.map(({ closed, points }) => ({ closed, points: points.map(({ x, y }) => ({ x, y })) }));
  // A cut still being drawn is finished first, as the game does before it changes the strokes.
  view.endCut?.();
  view.history.push(copy(view.strokes));
  view.strokes = copy(strokes);
  view.redraw();
  return true;
}

/* ── The button over the game's pumpkin ─────────────────────────────────────────────────────── */

function placeButton(): void {
  const button = document.getElementById(BUTTON_ID);
  if (!button || button.hidden) return;
  const surface = pixiSurface();
  // Kept between ticks: finding it walks the whole scene graph.
  if (!artNode || artNode.destroyed || !artNode.parent) artNode = surface && findVisiblePixiNodes(surface, [ART_LABEL]).get(ART_LABEL) || null;
  const art = artNode;
  const bounds = art?.getBounds?.();
  if (!surface || !bounds || !(bounds.width > 0)) {
    button.style.left = '50%';
    button.style.top = '16px';
    button.style.transform = 'translateX(-50%)';
    return;
  }
  button.style.transform = '';
  // Centred over the top of the pumpkin, inside the stalk's empty corners.
  const left = surface.toScreenX(bounds.x + bounds.width / 2) - button.offsetWidth / 2;
  const top = surface.toScreenY(bounds.y) + 8;
  button.style.left = `${Math.max(8, Math.round(left))}px`;
  button.style.top = `${Math.max(8, Math.round(top))}px`;
}

const placeTicker = createTicker(placeButton, 250);

function syncButton(): void {
  const button = document.getElementById(BUTTON_ID);
  if (!button) return;
  const show = carvingOpen && feature('pumpkinImport');
  button.hidden = !show;
  placeTicker.sync(show);
  if (!show) document.getElementById(DIALOG_ID)?.remove();
}

export function updatePumpkinImport(): void { syncButton(); }

function pickFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => { const file = input.files?.[0]; if (file) void openPicture(file); };
  input.click();
}

export function mountPumpkinImport(): void {
  if (document.getElementById(BUTTON_ID)) return;
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.hidden = true;
  button.textContent = 'Select a picture';
  button.title = 'Carve this pumpkin from a picture';
  button.addEventListener('click', () => { button.blur(); pickFile(); });
  document.body.appendChild(button);

  // A dropped picture goes straight in while the carving window is open.
  window.addEventListener('dragover', event => {
    if (!button.hidden && event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', event => {
    if (button.hidden) return;
    const file = [...(event.dataTransfer?.files ?? [])].find(item => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void openPicture(file);
  });

  retryUntil(() => {
    modalAtom ??= findAtom('activeModalStateAtom');
    targetAtom ??= findAtom('pumpkinCarvingTargetAtom');
    const store = gameStore();
    if (!modalAtom || !targetAtom || !store) return false;
    const watched = modalAtom;
    const follow = () => {
      const value = store.get(watched) as { modal?: unknown } | string | null;
      const modal = typeof value === 'string' ? value : value?.modal;
      carvingOpen = modal === MODAL_NAME;
      syncButton();
    };
    store.sub(watched, follow);
    follow();
    return true;
  }, 'the pumpkin carving import');
}

/* ── Tracing in a worker ────────────────────────────────────────────────────────────────────────── */

let workerStart: Promise<Worker | null> | null = null;
/** Jobs sent to the worker, kept until it answers so they can be traced on the page if it fails. */
const workerJobs = new Map<number, { job: CarvingJob; resolve: (result: TraceResult | Promise<TraceResult>) => void }>();
let nextJobId = 1;
/** The picture the worker holds (see carving-worker.ts), so it is only sent again when it changes. */
let workerPictureKey: string | null = null;
let dialogCount = 0;

/** The carving worker, started on first use; null where the page will not run one. */
function carvingWorker(): Promise<Worker | null> {
  return workerStart ??= new Promise(resolve => {
    if (typeof Worker !== 'function' || typeof __CARVING_WORKER__ !== 'string') { resolve(null); return; }
    const url = URL.createObjectURL(new Blob([__CARVING_WORKER__], { type: 'text/javascript' }));
    let worker: Worker;
    try { worker = new Worker(url); } catch { URL.revokeObjectURL(url); resolve(null); return; }
    // A content policy can refuse a worker without throwing, so it counts as started only once it
    // says so, and gives up after a while.
    const timer = window.setTimeout(() => { worker.terminate(); resolve(null); }, 3000);
    worker.onmessage = event => {
      const message = event.data as { type?: string } & Partial<CarvingReply>;
      if (message.type === 'ready') { window.clearTimeout(timer); URL.revokeObjectURL(url); resolve(worker); return; }
      const pending = message.id ? workerJobs.get(message.id) : undefined;
      if (!pending) return;
      workerJobs.delete(message.id!);
      // Whatever failed, the next job carries its picture again rather than trust what the worker holds.
      if (!message.result) workerPictureKey = null;
      // A job the worker could not trace is traced here instead, so the preview never waits forever.
      pending.resolve(message.result ?? traceHere(pending.job));
    };
    // An error after it started means it is gone: every job still waiting is traced on the page, and
    // so is everything after.
    worker.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
      workerStart = Promise.resolve(null);
      worker.terminate();
      for (const [id, { job, resolve: answer }] of workerJobs) { workerJobs.delete(id); answer(traceHere(job)); }
    };
  });
}

/** Traces on the page, as a promise, so a throw rejects it rather than escaping a message handler. */
const traceHere = (job: CarvingJob) => Promise.resolve().then(() => runCarvingJob(job));

/** Traces in the worker, or on the page when there is none. */
async function traceInWorker(job: CarvingJob): Promise<TraceResult> {
  const worker = await carvingWorker();
  if (!worker) return traceHere(job);
  const id = nextJobId++;
  return new Promise(resolve => {
    workerJobs.set(id, { job, resolve });
    const message: CarvingMessage = workerPictureKey === job.pictureKey ? { ...job, id, data: undefined } : { ...job, id };
    workerPictureKey = job.pictureKey;
    worker.postMessage(message);
  });
}

/* ── Turning the picture into a carving ─────────────────────────────────────────────────────── */

interface Settings extends PictureSettings {
  zoom: number;
  smoothing: number;
  /** Where the picture's centre sits relative to the face's, in grid units. */
  offsetX: number;
  offsetY: number;
}

/**
 * The largest side a picture is kept at. The grid is 256 across and Size goes to 250%, so this keeps
 * every zoom sharp while a big photo is not resampled in full on each step of a drag.
 */
const SOURCE_MAX_PX = 1024;

/** The picture, decoded and shrunk once to SOURCE_MAX_PX. */
/**
 * Pictures past these are refused before they are drawn: a huge one would take the tab's memory
 * and stall the game while it decodes, and nothing past SOURCE_MAX_PX is kept anyway.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PICTURE_PIXELS = 40_000_000;

class PictureTooLarge extends Error {}

async function loadImage(file: File): Promise<HTMLCanvasElement> {
  if (file.size > MAX_FILE_BYTES) throw new PictureTooLarge();
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    // Loaded rather than decoded: the size is known from the header, before the pixels are
    // unpacked, so an oversized picture is turned away without decoding it.
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    if (image.naturalWidth * image.naturalHeight > MAX_PICTURE_PIXELS) throw new PictureTooLarge();
    const scale = Math.min(1, SOURCE_MAX_PX / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Where the picture sits on the grid, in grid units: fitted inside the face, scaled by the zoom and moved by the offset. */
function placement(image: HTMLCanvasElement, zoom: number, offsetX = 0, offsetY = 0) {
  const fit = Math.min(FACE.rx * 2 / image.width, FACE.ry * 2 / image.height) * zoom;
  const width = image.width * fit, height = image.height * fit;
  return { x: FACE.cx + offsetX - width / 2, y: FACE.cy + offsetY - height / 2, width, height };
}

/** The cells of the mask the picture covers (see PictureExtent). */
function pictureExtent(image: HTMLCanvasElement, zoom: number, offsetX = 0, offsetY = 0): PictureExtent {
  const { x, y, width, height } = placement(image, zoom, offsetX, offsetY);
  return {
    left: Math.floor(x * PICTURE_DETAIL), top: Math.floor(y * PICTURE_DETAIL),
    right: Math.ceil((x + width) * PICTURE_DETAIL) - 1, bottom: Math.ceil((y + height) * PICTURE_DETAIL) - 1,
  };
}

/** The picture drawn into the grid where placement puts it, as RGBA. */
function drawPicture(image: HTMLCanvasElement, zoom: number, offsetX = 0, offsetY = 0): Uint8ClampedArray {
  // Drawn PICTURE_DETAIL times finer than the grid, so the outlines are traced between its units.
  const size = CARVING_GRID * PICTURE_DETAIL;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.scale(PICTURE_DETAIL, PICTURE_DETAIL);
  const { x, y, width, height } = placement(image, zoom, offsetX, offsetY);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, x, y, width, height);
  return context.getImageData(0, 0, size, size).data;
}

/**
 * The background read off the picture on its own, at its full size (at most SOURCE_MAX_PX): shrunk,
 * a baked-in checkerboard's squares would blend into one grey and it could not be told apart.
 */
function readBackground(image: HTMLCanvasElement): PictureBackground {
  const data = image.getContext('2d')!.getImageData(0, 0, image.width, image.height).data;
  return pictureBackground(data, image.width, image.height);
}

/** A starting threshold for Light and dark: Otsu over the face only, so the margins around a wide picture do not pull it. */
function autoThreshold(drawn: Uint8ClampedArray): number {
  const inside: number[] = [];
  // One sample per grid unit is plenty for a histogram.
  const size = CARVING_GRID * PICTURE_DETAIL;
  for (let y = 0; y < size; y += PICTURE_DETAIL) for (let x = 0; x < size; x += PICTURE_DETAIL) {
    const dx = ((x + .5) / PICTURE_DETAIL - FACE.cx) / FACE.rx, dy = ((y + .5) / PICTURE_DETAIL - FACE.cy) / FACE.ry;
    if (dx * dx + dy * dy > 1) continue;
    inside.push(lumaOver(drawn, y * size + x, 255));
  }
  return Math.round(otsuThreshold(inside));
}

/** A freehand outline drawn round part of a picture, in its pixels; closed back to its start. */
type CropShape = Array<{ x: number; y: number }>;

/** An outline narrower or shorter than this, in picture pixels, is taken as a click and picks the whole picture. */
const MIN_CROP_PX = 8;

function cropBounds(shape: CropShape) {
  const xs = shape.map(point => point.x), ys = shape.map(point => point.y);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.ceil(Math.max(...xs)) - x, height: Math.ceil(Math.max(...ys)) - y };
}

const usableCrop = (shape: CropShape) => {
  if (shape.length < 3) return false;
  const { width, height } = cropBounds(shape);
  return width >= MIN_CROP_PX && height >= MIN_CROP_PX;
};

function tracePath(context: CanvasRenderingContext2D, shape: CropShape, dx = 0, dy = 0): void {
  context.beginPath();
  shape.forEach(({ x, y }, i) => i ? context.lineTo(x - dx, y - dy) : context.moveTo(x - dx, y - dy));
  context.closePath();
}

/**
 * The part of the picture inside the outline, on its own canvas just big enough for it. Outside the
 * outline is left transparent, which the tracing takes as background, so in Shape and Stained glass
 * the outline becomes the carving's silhouette.
 */
function cropped(image: HTMLCanvasElement, shape: CropShape): HTMLCanvasElement {
  const bounds = cropBounds(shape);
  // A transparent margin round a freehand outline: the picture's edge is not lined in inverted
  // stained glass (see pictureMask's extent), and without it the outline would run along that edge
  // at its furthest sides. Not round a rectangle, which is the picture's edge, and whose picture
  // must stay opaque for its background to be read off its border.
  const [a, b, c, d] = shape;
  const rectangle = shape.length === 4 && a.y === b.y && b.x === c.x && c.y === d.y && d.x === a.x;
  const margin = rectangle ? 0 : Math.max(2, Math.round(Math.max(bounds.width, bounds.height) * .02));
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width + margin * 2;
  canvas.height = bounds.height + margin * 2;
  const context = canvas.getContext('2d')!;
  context.translate(margin - bounds.x, margin - bounds.y);
  tracePath(context, shape);
  context.clip();
  context.drawImage(image, 0, 0);
  return canvas;
}

/** The whole picture, with everything outside the outline dimmed and the outline drawn. */
function drawCropView(canvas: HTMLCanvasElement, image: HTMLCanvasElement, shape: CropShape | null, drawing = false): void {
  const context = canvas.getContext('2d')!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  if (!shape || shape.length < 2) return;
  if (!drawing) {
    // The picture's rectangle with the outline cut out of it, by the even-odd rule.
    context.beginPath();
    context.rect(0, 0, canvas.width, canvas.height);
    shape.forEach(({ x, y }, i) => i ? context.lineTo(x, y) : context.moveTo(x, y));
    context.closePath();
    context.fillStyle = 'rgba(0,0,0,.6)';
    context.fill('evenodd');
  }
  // Sized to the picture, so the outline reads the same however big it is.
  context.lineWidth = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) / 300));
  context.lineJoin = context.lineCap = 'round';
  context.strokeStyle = '#ffd65a';
  context.beginPath();
  shape.forEach(({ x, y }, i) => i ? context.lineTo(x, y) : context.moveTo(x, y));
  if (!drawing) context.closePath();
  context.stroke();
}

function drawPreview(canvas: HTMLCanvasElement, strokes: CarvingStroke[]): void {
  const context = canvas.getContext('2d')!;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(PREVIEW_SCALE, 0, 0, PREVIEW_SCALE, 0, -PREVIEW_TOP * PREVIEW_SCALE);
  context.save();
  context.beginPath();
  context.ellipse(FACE.cx, FACE.cy, FACE.rx, FACE.ry, 0, 0, Math.PI * 2);
  context.clip();
  // As the game draws a carving: each cut filled on its own, then a one-unit outline round each
  // drawn behind the fills, which is what shows an island's slit as a fine line across it.
  const trace = (points: CarvingStroke['points']) => {
    context.beginPath();
    points.forEach(({ x, y }, i) => i ? context.lineTo(x + .5, y + .5) : context.moveTo(x + .5, y + .5));
    context.closePath();
  };
  context.fillStyle = context.strokeStyle = '#ffd65a';
  context.lineWidth = 1;
  context.lineJoin = 'round';
  for (const { points } of strokes) { trace(points); context.fill(); }
  context.globalCompositeOperation = 'destination-over';
  for (const { points } of strokes) { trace(points); context.stroke(); }
  // The pumpkin goes in last, behind everything.
  context.fillStyle = '#d9731f';
  context.fillRect(0, PREVIEW_TOP, CARVING_GRID, PREVIEW_BOTTOM - PREVIEW_TOP);
  context.restore();
}

async function openPicture(file: File): Promise<void> {
  let image: HTMLCanvasElement;
  try {
    image = await loadImage(file);
  } catch (error) {
    toast(error instanceof PictureTooLarge
      ? `That picture is too big - up to ${MAX_FILE_BYTES / 1024 / 1024} MB and ${MAX_PICTURE_PIXELS / 1_000_000} megapixels.`
      : 'That picture could not be opened.', 'error');
    return;
  }
  document.getElementById(DIALOG_ID)?.remove();

  /** The whole picture; `image` is the part of it picked with Crop, or all of it. */
  const original = image;
  let crop: CropShape | null = null;
  let background = readBackground(image);
  // Stained glass first: most pictures worth carving are colourful art, which it suits best.
  const settings: Settings = { mode: 'glass', threshold: 128, invert: false, tolerance: 40, edges: 35, lineWidth: 2, zoom: 1, smoothing: .4, offsetX: 0, offsetY: 0 };
  const drawn = drawPicture(image, 1);
  settings.threshold = autoThreshold(drawn);

  const backdrop = document.createElement('div');
  backdrop.id = DIALOG_ID;
  backdrop.className = 'gc-modal-backdrop';
  backdrop.innerHTML = `<div class="gc-carve-modal" role="dialog" aria-label="Carve from a picture">
    <div class="gc-modal-head"><h3>Carve from a picture</h3><button class="gc-modal-close" data-carve-close aria-label="Close">×</button></div>
    <div class="gc-modal-body">
      <canvas class="gc-carve-preview" width="${Math.round(CARVING_GRID * PREVIEW_SCALE)}" height="${Math.round((PREVIEW_BOTTOM - PREVIEW_TOP) * PREVIEW_SCALE)}" title="Drag to move the picture, scroll to resize it, double-click to centre it"></canvas>
      <p class="gc-carve-hint">Drag the picture to move it, scroll to resize, double-click to centre · <button type="button" class="gc-carve-link" data-crop-open>Crop</button></p>
      <div class="gc-carve-crop" data-crop-panel hidden>
        <div class="gc-carve-modes" role="radiogroup">${([['free', 'Freehand'], ['box', 'Rectangle']] as const).map(([tool, label]) =>
          `<label><input type="radio" name="gc-crop-tool" data-crop-tool value="${tool}" ${tool === 'free' ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
        <canvas class="gc-carve-crop-view" width="${original.width}" height="${original.height}"></canvas>
        <p class="gc-carve-hint">Draw round the part of the picture to carve</p>
        <div class="gc-carve-crop-actions"><button type="button" data-crop-cancel>Back</button><button type="button" data-crop-all>Whole picture</button><button type="button" class="gc-carve-go" data-crop-use>Use selection</button></div>
      </div>
      <p class="gc-carve-status" data-carve-status></p>
      <div class="gc-carve-modes" role="radiogroup">${([['glass', 'Stained glass'], ['shape', 'Shape'], ['shade', 'Light and dark']] as const).map(([mode, label]) =>
        `<label><input type="radio" name="gc-carve-mode" data-carve="mode" value="${mode}" ${mode === settings.mode ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
      <label class="gc-carve-slider" data-modes="shade"><span>Threshold</span><input type="range" min="1" max="254" data-carve="threshold" value="${settings.threshold}"></label>
      <label class="gc-carve-slider" data-modes="shape glass"><span>Background</span><input type="range" min="2" max="200" data-carve="tolerance" value="${settings.tolerance}" title="How different from the background a part must be to be cut"></label>
      <label class="gc-carve-slider" data-modes="glass"><span>Lines</span><input type="range" min="10" max="200" data-carve="edges" value="${210 - settings.edges}" title="More draws a line at smaller colour changes"></label>
      <label class="gc-carve-slider" data-modes="glass"><span>Line width</span><input type="range" min="${MIN_LINE_WIDTH}" max="5" data-carve="lineWidth" value="${settings.lineWidth}"></label>
      <label class="gc-carve-slider"><span>Size</span><input type="range" min="30" max="250" data-carve="zoom" value="100"></label>
      <label class="gc-carve-slider"><span>Smoothing</span><input type="range" min="3" max="60" data-carve="smoothing" value="4" title="The least the outlines are smoothed - more is used when a picture needs it to fit"></label>
      <label class="gc-carve-check" data-modes="shade glass"><input type="checkbox" data-carve="invert"><span data-modes="shade">Cut the light parts instead of the dark</span><span data-modes="glass">Cut the lines instead of the colours</span></label>
    </div>
    <div class="gc-carve-actions"><button data-carve-close>Cancel</button><button data-carve-edit title="Put the cuts on the game's pumpkin to change them with the knife; nothing is saved until you press Done">Edit in game</button><button class="gc-carve-go" data-carve-go>Carve pumpkin</button></div>
  </div>`;
  document.body.appendChild(backdrop);

  const canvas = backdrop.querySelector<HTMLCanvasElement>('.gc-carve-preview')!;
  const status = backdrop.querySelector<HTMLElement>('[data-carve-status]')!;
  const go = backdrop.querySelector<HTMLButtonElement>('[data-carve-go]')!;
  const edit = backdrop.querySelector<HTMLButtonElement>('[data-carve-edit]')!;
  let result: TraceResult | null = null;
  /** Set while CarvePumpkin is out, so a trace landing then does not offer the button again. */
  let carving = false;
  let frame = 0;
  // Numbered per dialog too, so a new picture never matches the one the worker still holds.
  const dialog = ++dialogCount;
  /** Counts the crops applied, so a new crop is never taken for the picture before it. */
  let crops = 0;
  const pictureKey = () => `${dialog}:${crops}:${settings.zoom}:${settings.offsetX}:${settings.offsetY}`;
  let picture = { key: pictureKey(), data: drawn };
  const showModeControls = () => backdrop.querySelectorAll<HTMLElement>('[data-modes]').forEach(element => {
    element.hidden = !element.dataset.modes!.split(' ').includes(settings.mode);
  });
  showModeControls();
  const show = (traced: TraceResult, asked: number) => {
    result = traced;
    drawPreview(canvas, traced.strokes);
    const used = Math.round(traced.bytes / CARVING_MAX_BYTES * 100);
    status.textContent = traced.strokes.length === 0
      ? 'Nothing to cut - try another style or moving the sliders.'
      : `${traced.strokes.length} cut${traced.strokes.length === 1 ? '' : 's'}, ${used}% of the carving limit` +
        (traced.smoothing > asked + .05 ? ', smoothed to fit' : '') +
        (traced.dropped ? `, ${traced.dropped} small piece${traced.dropped === 1 ? '' : 's'} left out` : '');
    go.disabled = edit.disabled = carving || traced.strokes.length === 0;
  };
  // One trace at a time, and only the newest settings: a slider dragged faster than tracing keeps
  // up skips the positions it passed through rather than queueing them all.
  let tracing = false;
  let stale = false;
  const retrace = () => {
    if (tracing) { stale = true; return; }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(async () => {
      tracing = true;
      stale = false;
      if (picture.key !== pictureKey()) picture = { key: pictureKey(), data: drawPicture(image, settings.zoom, settings.offsetX, settings.offsetY) };
      const { zoom: _zoom, offsetX: _x, offsetY: _y, smoothing, ...pictureSettings } = settings;
      let traced: TraceResult | null = null;
      try {
        const extent = pictureExtent(image, settings.zoom, settings.offsetX, settings.offsetY);
        traced = await traceInWorker({ id: 0, pictureKey: picture.key, data: picture.data, background, settings: pictureSettings, smoothing, scale: PICTURE_DETAIL, extent });
      } catch (error) {
        warn('Tracing the picture failed:', error);
      } finally {
        // Always cleared, or one failed trace would leave every later change waiting on it.
        tracing = false;
      }
      if (!backdrop.isConnected) return;
      if (traced) show(traced, smoothing);
      else { status.textContent = 'This picture could not be traced at these settings.'; go.disabled = edit.disabled = true; result = null; }
      if (stale) retrace();
    });
  };
  retrace();

  // Moving and resizing the picture on the preview itself.
  const zoomInput = backdrop.querySelector<HTMLInputElement>('[data-carve="zoom"]')!;
  const unitsPerPixel = () => CARVING_GRID / (canvas.getBoundingClientRect().width || CARVING_GRID);
  const reach = CARVING_GRID * .75;
  let dragFrom: { x: number; y: number; offsetX: number; offsetY: number } | null = null;
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    dragFrom = { x: event.clientX, y: event.clientY, offsetX: settings.offsetX, offsetY: settings.offsetY };
    canvas.dataset.dragging = 'true';
  });
  canvas.addEventListener('pointermove', event => {
    if (!dragFrom) return;
    const scale = unitsPerPixel();
    const clamp = (value: number) => Math.round(Math.max(-reach, Math.min(reach, value)) * 2) / 2;
    const offsetX = clamp(dragFrom.offsetX + (event.clientX - dragFrom.x) * scale);
    const offsetY = clamp(dragFrom.offsetY + (event.clientY - dragFrom.y) * scale);
    if (offsetX === settings.offsetX && offsetY === settings.offsetY) return;
    settings.offsetX = offsetX;
    settings.offsetY = offsetY;
    retrace();
  });
  const endDrag = () => { dragFrom = null; delete canvas.dataset.dragging; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => {
    settings.offsetX = settings.offsetY = 0;
    retrace();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    // Only up and down resize; a sideways swipe would otherwise count as zooming out.
    if (event.deltaY === 0) return;
    const percent = Math.max(Number(zoomInput.min), Math.min(Number(zoomInput.max), Math.round(settings.zoom * 100 * (event.deltaY < 0 ? 1.08 : 1 / 1.08))));
    zoomInput.value = String(percent);
    settings.zoom = percent / 100;
    retrace();
  }, { passive: false });

  // Cropping: the whole picture shown in place of the controls, with an outline drawn round a part of it.
  const cropPanel = backdrop.querySelector<HTMLElement>('[data-crop-panel]')!;
  const cropView = cropPanel.querySelector<HTMLCanvasElement>('canvas')!;
  let selection: CropShape | null = null;
  /** The outline while it is being drawn. */
  let drawing: CropShape | null = null;
  /** Freehand draws round the part to keep; Rectangle drags a box from corner to corner. */
  let cropTool: 'free' | 'box' = 'free';
  /** Where a rectangle's drag began. */
  let boxFrom: { x: number; y: number } | null = null;
  const cropHint = cropPanel.querySelector<HTMLElement>('.gc-carve-hint')!;
  cropPanel.querySelectorAll<HTMLInputElement>('[data-crop-tool]').forEach(input => input.addEventListener('change', () => {
    if (!input.checked) return;
    cropTool = input.value as typeof cropTool;
    cropHint.textContent = cropTool === 'box' ? 'Drag a box over the part of the picture to carve' : 'Draw round the part of the picture to carve';
  }));
  const toPicture = (event: PointerEvent) => {
    const box = cropView.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(original.width, (event.clientX - box.left) / (box.width || 1) * original.width)),
      y: Math.max(0, Math.min(original.height, (event.clientY - box.top) / (box.height || 1) * original.height)),
    };
  };
  const setCropping = (on: boolean) => {
    cropPanel.hidden = !on;
    backdrop.querySelector<HTMLElement>('.gc-carve-modal')!.dataset.cropping = String(on);
    if (on) { selection = crop; drawCropView(cropView, original, selection); }
  };
  const applyCrop = (shape: CropShape | null) => {
    crop = shape;
    image = shape ? cropped(original, shape) : original;
    crops++;
    background = readBackground(image);
    // The crop fills the face again, centred.
    settings.zoom = 1;
    settings.offsetX = settings.offsetY = 0;
    zoomInput.value = '100';
    picture = { key: pictureKey(), data: drawPicture(image, 1) };
    settings.threshold = autoThreshold(picture.data);
    backdrop.querySelector<HTMLInputElement>('[data-carve="threshold"]')!.value = String(settings.threshold);
    setCropping(false);
    retrace();
  };
  backdrop.querySelector('[data-crop-open]')!.addEventListener('click', () => setCropping(true));
  cropPanel.querySelector('[data-crop-cancel]')!.addEventListener('click', () => setCropping(false));
  cropPanel.querySelector('[data-crop-all]')!.addEventListener('click', () => applyCrop(null));
  cropPanel.querySelector('[data-crop-use]')!.addEventListener('click', () => applyCrop(selection));
  cropView.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    try { cropView.setPointerCapture(event.pointerId); } catch {}
    const start = toPicture(event);
    if (cropTool === 'box') { boxFrom = start; drawing = null; return; }
    drawing = [start];
    drawCropView(cropView, original, drawing, true);
  });
  cropView.addEventListener('pointermove', event => {
    if (boxFrom) {
      // A rectangle is a four-corner outline, so cropping it works just as a freehand one does. On
      // whole pixels, so its clipped edges are not left half transparent.
      const to = toPicture(event);
      const x0 = Math.round(boxFrom.x), y0 = Math.round(boxFrom.y), x1 = Math.round(to.x), y1 = Math.round(to.y);
      drawing = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      drawCropView(cropView, original, drawing);
      return;
    }
    if (!drawing) return;
    const point = toPicture(event);
    const last = drawing[drawing.length - 1];
    // A point every couple of picture pixels is plenty, and keeps a long outline quick to redraw.
    if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
    drawing.push(point);
    drawCropView(cropView, original, drawing, true);
  });
  // Let go and the outline closes back to where it began; one too small to use clears the selection.
  const endSelect = () => {
    const wasBox = boxFrom !== null;
    boxFrom = null;
    if (!drawing) { if (wasBox) { selection = null; drawCropView(cropView, original, null); } return; }
    selection = usableCrop(drawing) ? drawing : null;
    drawing = null;
    drawCropView(cropView, original, selection);
  };
  cropView.addEventListener('pointerup', endSelect);
  cropView.addEventListener('pointercancel', endSelect);

  // Keys typed here (arrows on a slider) stay out of the game, which would walk the player.
  backdrop.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { if (cropPanel.hidden) close(); else setCropping(false); }
  });
  const close = () => { cancelAnimationFrame(frame); backdrop.remove(); };
  backdrop.addEventListener('input', event => {
    const input = (event.target as HTMLInputElement);
    switch (input.dataset.carve) {
      case 'threshold': settings.threshold = Number(input.value); break;
      case 'zoom': settings.zoom = Number(input.value) / 100; break;
      case 'smoothing': settings.smoothing = Number(input.value) / 10; break;
      case 'invert': settings.invert = input.checked; break;
      case 'tolerance': settings.tolerance = Number(input.value); break;
      case 'edges': settings.edges = 210 - Number(input.value); break;
      case 'lineWidth': settings.lineWidth = Number(input.value); break;
      case 'mode': settings.mode = input.value as PictureMode; showModeControls(); break;
      default: return;
    }
    retrace();
  });
  backdrop.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target === backdrop || target.closest('[data-carve-close]')) close();
  });
  edit.addEventListener('click', () => {
    if (carving) return;
    if (!result || !carvingOpen) {
      toast('Open the carving window on a pumpkin first.', 'error');
      return;
    }
    if (!loadIntoGameCarving(result.strokes)) {
      warn('Edit in game: the game\'s carving window could not be found.');
      toast('Could not reach the game\'s carving window - use Carve pumpkin instead.', 'error');
      return;
    }
    close();
    toast('Edit the carving, then press Done to save it');
  });
  go.addEventListener('click', async () => {
    const target = carvingTarget();
    if (!result || !target || !carvingOpen) {
      toast('Open the carving window on a pumpkin first.', 'error');
      return;
    }
    if (carving) return;
    carving = true;
    // Edit in game too: the window it would load into is closed once the carving lands.
    go.disabled = edit.disabled = true;
    go.textContent = 'Carving...';
    let answer;
    try {
      answer = await sendQuinoaCommandAwaitingResult({
        type: 'CarvePumpkin', slot: target.localTileIndex, growSlotId: target.growSlotId, carving: encodeCarving(result.strokes),
      });
    } catch (error) {
      answer = { ok: false, code: (error as Error).message };
    }
    carving = false;
    if (!answer.ok) {
      go.disabled = edit.disabled = !result || result.strokes.length === 0;
      go.textContent = 'Carve pumpkin';
      toast(answer.timedOut ? 'The game did not answer - check the pumpkin before trying again.' : `The game refused the carving${answer.code ? ` (${answer.code})` : ''}.`, 'error');
      return;
    }
    close();
    closeGameCarving();
    toast('Pumpkin carved');
  });
}

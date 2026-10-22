/**
 * Turning a picture into a pumpkin carving.
 *
 * The game keeps a carving as a list of closed cut-outs - polygons on a 256 x 256 grid, one byte per
 * coordinate - base64'd into the CarvePumpkin command (bundle 1650: deriveAvailableActions' encoder,
 * `{closed}{count}{x y}...`). Only closed cuts count; each is filled on its own, so the visible cut is
 * the union of them all. The game caps a carving at 2304 bytes (2 per cut plus 2 per point) and a
 * cut at 255 points, and only draws inside the pumpkin's face, an ellipse centred on the grid.
 *
 * A picture becomes a carving by thresholding it into cut and uncut cells, tracing the boundary of
 * every cut region, and simplifying the outlines until they fit the budget. Uncut islands inside a
 * cut (the pupil in an eye) are kept by joining each to its surrounding outline with a zero-width
 * slit: the outline runs clockwise and the island anticlockwise, so the island's winding cancels and
 * it is left unfilled, all inside one polygon.
 */

export interface CarvingPoint { x: number; y: number }
export interface CarvingStroke { closed: boolean; points: CarvingPoint[] }

export const CARVING_GRID = 256;
/** The game's limit on one carving, in encoded bytes (bundle 1650, raised from 1536 in 1608). */
export const CARVING_MAX_BYTES = 2304;
export const CARVING_MAX_POINTS = 255;

/**
 * The carvable face in grid units: the game's `{centerX:(307-37)/H, centerY:(345-75)/H,
 * radiusX:270/H, radiusY:180/H}` with H = 540/256.
 */
const FACE_SCALE = 540 / 256;
export const FACE = { cx: 270 / FACE_SCALE, cy: 270 / FACE_SCALE, rx: 270 / FACE_SCALE, ry: 180 / FACE_SCALE };
/** Cells are kept this far inside the face edge, so every traced corner lands inside it too. */
const FACE_MARGIN = 1.5;

export function insideFace(x: number, y: number, margin = 0): boolean {
  const dx = (x - FACE.cx) / (FACE.rx - margin);
  const dy = (y - FACE.cy) / (FACE.ry - margin);
  return dx * dx + dy * dy <= 1;
}

/**
 * One byte per cell, 1 where the pumpkin is cut. A mask may be finer than the carving grid -
 * `scale` cells to a grid unit, CARVING_GRID * scale to a row - so outlines are traced to a fraction
 * of a unit and follow a picture's real edges instead of stepping along whole cells.
 */
export type CarvingMask = Uint8Array;

/** Mask cells per grid unit the picture import traces at. */
export const PICTURE_DETAIL = 3;

/** Clears every cell that is not fully inside the face. */
export function clipMaskToFace(mask: CarvingMask, scale = 1): void {
  const n = CARVING_GRID * scale;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!insideFace((x + .5) / scale, (y + .5) / scale, FACE_MARGIN)) mask[y * n + x] = 0;
    }
  }
}

/** Otsu's threshold over 0-255 values, a starting point that suits most pictures. */
export function otsuThreshold(values: ArrayLike<number>): number {
  const histogram = new Array<number>(256).fill(0);
  for (let i = 0; i < values.length; i++) histogram[Math.max(0, Math.min(255, Math.round(values[i])))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let below = 0, sumBelow = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    below += histogram[t];
    if (below === 0) continue;
    const above = total - below;
    if (above === 0) break;
    sumBelow += t * histogram[t];
    const meanBelow = sumBelow / below;
    const meanAbove = (sum - sumBelow) / above;
    const between = below * above * (meanBelow - meanAbove) ** 2;
    if (between > best) { best = between; threshold = t + .5; }
  }
  return threshold;
}

type Loop = CarvingPoint[];

/** Twice the signed area; positive for loops running clockwise on screen (y down). */
function doubleArea(loop: Loop): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area;
}

/**
 * Every boundary between cut and uncut cells, as closed loops of grid corners. Each edge runs with
 * the cut cell on its right, so outlines come out clockwise and the islands inside them
 * anticlockwise. Where two cut cells meet only at a corner the walk turns right, keeping them apart.
 */
export function traceLoops(mask: CarvingMask, scale = 1, from = 0, to = CARVING_GRID * scale): Loop[] {
  const n = CARVING_GRID * scale;
  // Only the columns from..to are traced, as if the rest were uncut (see bandCuts).
  const cut = (x: number, y: number) => x >= from && y >= 0 && x < to && y < n && mask[y * n + x] === 1;
  const stride = n + 1;
  const key = (x: number, y: number) => y * stride + x;
  // Up to two edges leave a corner (two at a diagonal touch); each stored as a direction 0-3.
  const outgoing = new Map<number, number[]>();
  const add = (x: number, y: number, direction: number) => {
    const k = key(x, y);
    const list = outgoing.get(k);
    if (list) list.push(direction); else outgoing.set(k, [direction]);
  };
  // Directions: 0 right, 1 down, 2 left, 3 up.
  for (let y = 0; y < n; y++) {
    for (let x = from; x < to; x++) {
      if (!cut(x, y)) continue;
      if (!cut(x, y - 1)) add(x, y, 0);
      if (!cut(x + 1, y)) add(x + 1, y, 1);
      if (!cut(x, y + 1)) add(x + 1, y + 1, 2);
      if (!cut(x - 1, y)) add(x, y + 1, 3);
    }
  }
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const loops: Loop[] = [];
  for (const [start, list] of outgoing) {
    while (list.length) {
      let x = start % stride, y = Math.floor(start / stride);
      let direction = list.pop()!;
      const loop: Loop = [];
      for (;;) {
        loop.push({ x, y });
        x += step[direction][0];
        y += step[direction][1];
        if (key(x, y) === start) break;
        const here = outgoing.get(key(x, y));
        if (!here || here.length === 0) break;
        // Right turn first, then straight on, then left.
        const order = [(direction + 1) % 4, direction, (direction + 3) % 4];
        const pick = order.find(candidate => here.includes(candidate));
        if (pick === undefined) break;
        here.splice(here.indexOf(pick), 1);
        direction = pick;
      }
      if (loop.length >= 4) loops.push(dropStraights(loop));
    }
  }
  return loops;
}

/** Drops the corners a straight edge passes through, leaving only the turns. */
function dropStraights(loop: Loop): Loop {
  const out: Loop = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length], b = loop[i], c = loop[(i + 1) % loop.length];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) out.push(b);
  }
  return out;
}

function segmentDistance(p: CarvingPoint, a: CarvingPoint, b: CarvingPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function simplifyOpen(points: Loop, epsilon: number): Loop {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = -1, index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(points[i], points[first], points[last]);
      if (distance > worst) { worst = distance; index = i; }
    }
    if (worst > epsilon) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas-Peucker on a closed loop, split at its two furthest-apart corners. */
export function simplifyLoop(loop: Loop, epsilon: number, pinned?: (point: CarvingPoint) => boolean): Loop {
  if (loop.length <= 4 || epsilon <= 0) return loop.slice();
  const pins = pinned ? loop.flatMap((point, i) => pinned(point) ? [i] : []) : [];
  if (pins.length === 1) {
    // One pin: started from, it is one of the two corners always kept.
    return simplifyLoop([...loop.slice(pins[0]), ...loop.slice(0, pins[0])], epsilon);
  }
  if (pins.length > 1) {
    // Several: each stretch between two is simplified on its own, keeping both ends.
    const result: Loop = [];
    pins.forEach((from, k) => {
      const to = pins[(k + 1) % pins.length];
      const stretch = to > from ? loop.slice(from, to + 1) : [...loop.slice(from), ...loop.slice(0, to + 1)];
      result.push(...simplifyOpen(stretch, epsilon).slice(0, -1));
    });
    return result.length >= 3 ? result : loop.slice(0, 3);
  }
  let far = 0, best = -1;
  for (let i = 1; i < loop.length; i++) {
    const distance = Math.hypot(loop[i].x - loop[0].x, loop[i].y - loop[0].y);
    if (distance > best) { best = distance; far = i; }
  }
  const first = simplifyOpen(loop.slice(0, far + 1), epsilon);
  const second = simplifyOpen([...loop.slice(far), loop[0]], epsilon);
  const result = [...first, ...second.slice(1, -1)];
  return result.length >= 3 ? result : loop.slice(0, 3);
}

function pointInLoop(point: CarvingPoint, loop: Loop): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A cut region: its outline and the uncut islands inside it, largest first. */
interface Region { outline: Loop; islands: Loop[]; area: number }

/**
 * The most islands one region keeps. Each costs at least five of a cut's 255 points (three corners
 * and the slit's two), so no more than about fifty could ever fit; a noisy picture can have
 * thousands, and carrying them all through the smoothing made the preview take minutes.
 */
const MAX_ISLANDS = 60;

/**
 * Groups the traced loops into regions. An island belongs to the smallest outline holding a point
 * half a mask cell (`cell`, in grid units) off its first edge on the cut side - inside the cut cell
 * next to that edge, so inside the surrounding cut however thin it is.
 */
function groupRegions(loops: Loop[], minArea: number, cell: number): Region[] {
  const outlines: Array<Region & { box: [number, number, number, number] }> = [];
  const islands: Array<{ loop: Loop; area: number }> = [];
  for (const loop of loops) {
    const area = doubleArea(loop) / 2;
    if (Math.abs(area) < minArea) continue;
    if (area > 0) {
      const xs = loop.map(point => point.x), ys = loop.map(point => point.y);
      outlines.push({ outline: loop, islands: [], area, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    } else islands.push({ loop, area: -area });
  }
  outlines.sort((a, b) => a.area - b.area);
  islands.sort((a, b) => b.area - a.area);
  for (const { loop: island } of islands) {
    const a = island[0], b = island[1];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // The cut side is to the right of travel: (dy, -dx) is right on screen with y down.
    const off = cell / 2;
    const probe = { x: (a.x + b.x) / 2 - (b.y - a.y) / length * off, y: (a.y + b.y) / 2 + (b.x - a.x) / length * off };
    const owner = outlines.find(({ box, outline }) => probe.x >= box[0] && probe.x <= box[2] && probe.y >= box[1] && probe.y <= box[3]
      && pointInLoop(probe, outline));
    if (owner && owner.islands.length < MAX_ISLANDS) owner.islands.push(island);
  }
  return outlines.map(({ outline, islands: own, area }) => ({ outline, islands: own, area }));
}

function segmentsCross(a: CarvingPoint, b: CarvingPoint, c: CarvingPoint, d: CarvingPoint): boolean {
  const side = (p: CarvingPoint, q: CarvingPoint, r: CarvingPoint) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const shared = (p: CarvingPoint, q: CarvingPoint) => p.x === q.x && p.y === q.y;
  if (shared(a, c) || shared(a, d) || shared(b, c) || shared(b, d)) return false;
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/**
 * One polygon for a region: each island spliced into the outline through the shortest slit that
 * crosses no other edge. An island with no clear slit is left out (the region is cut whole there).
 */
function bridge(outline: Loop, islands: Loop[]): Loop {
  let polygon = outline.slice();
  const pending = islands.slice();
  const edgesOf = (loop: Loop) => loop.map((point, i) => [point, loop[(i + 1) % loop.length]] as const);
  while (pending.length) {
    const island = pending.shift()!;
    const blockers = [...edgesOf(polygon), ...pending.flatMap(edgesOf), ...edgesOf(island)];
    const pairs: Array<{ i: number; j: number; distance: number }> = [];
    for (let i = 0; i < polygon.length; i++) {
      for (let j = 0; j < island.length; j++) {
        pairs.push({ i, j, distance: Math.hypot(polygon[i].x - island[j].x, polygon[i].y - island[j].y) });
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);
    const clear = pairs.slice(0, 400).find(({ i, j }) => blockers.every(([c, d]) => !segmentsCross(polygon[i], island[j], c, d)));
    if (!clear) continue;
    const { i, j } = clear;
    const rotated = [...island.slice(j), ...island.slice(0, j)];
    polygon = [...polygon.slice(0, i + 1), ...rotated, island[j], ...polygon.slice(i)];
  }
  return polygon;
}

export function carvingBytes(strokes: CarvingStroke[]): number {
  return strokes.reduce((total, stroke) => total + 2 + stroke.points.length * 2, 0);
}

/** The game's own encoding: per cut a closed flag, a point count, then x,y bytes; base64'd. */
export function encodeCarving(strokes: CarvingStroke[]): string {
  const bytes: number[] = [];
  for (const stroke of strokes) {
    bytes.push(stroke.closed ? 1 : 0, stroke.points.length);
    for (const { x, y } of stroke.points) bytes.push(x, y);
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeCarving(carving: string): CarvingStroke[] {
  const binary = atob(carving);
  const strokes: CarvingStroke[] = [];
  let i = 0;
  while (i + 2 <= binary.length) {
    const closed = binary.charCodeAt(i++) === 1;
    const count = binary.charCodeAt(i++);
    const points: CarvingPoint[] = [];
    for (let k = 0; k < count; k++) points.push({ x: binary.charCodeAt(i++), y: binary.charCodeAt(i++) });
    strokes.push({ closed, points });
  }
  return strokes;
}

function toStroke(loop: Loop): CarvingStroke {
  const points: CarvingPoint[] = [];
  for (const point of loop) {
    const x = Math.max(0, Math.min(255, Math.round(point.x)));
    const y = Math.max(0, Math.min(255, Math.round(point.y)));
    const last = points[points.length - 1];
    if (!last || last.x !== x || last.y !== y) points.push({ x, y });
  }
  if (points.length > 1 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y) points.pop();
  return { closed: true, points };
}

export interface TraceOptions {
  /** The least the outlines are smoothed, in grid units. More is used if the picture will not fit. */
  smoothing?: number;
  /** Cut regions and islands smaller than this, in square grid units, are dropped. */
  minArea?: number;
  /** Mask cells per grid unit (see CarvingMask). */
  scale?: number;
}

export interface TraceResult {
  strokes: CarvingStroke[];
  bytes: number;
  /** The smoothing used in the end, at least the one asked for. */
  smoothing: number;
  /** Regions left out because even the most smoothing would not fit them all. */
  dropped: number;
}

const MAX_SMOOTHING = 12;

/** A region simplified at one smoothing, before its islands are bridged in. */
interface RegionPlan { outline: Loop; islands: Loop[] }

/** Whether a point must survive smoothing: the corners where a cut meets a band seam (see bandCuts). */
type Pinned = (point: CarvingPoint) => boolean;

function planRegion(region: Region, epsilon: number, pinned?: Pinned): RegionPlan | null {
  // An outline too detailed for one cut is smoothed further on its own, so it is not the whole
  // picture that loses its detail.
  let outline = simplifyLoop(region.outline, epsilon, pinned);
  for (let e = epsilon * 1.35; outline.length > CARVING_MAX_POINTS && e <= MAX_SMOOTHING * 8; e *= 1.35) outline = simplifyLoop(region.outline, e, pinned);
  if (outline.length > CARVING_MAX_POINTS) return null;
  // Islands, largest first, while the cut has points to spare: each costs its corners and the two
  // ends of its slit.
  let room = CARVING_MAX_POINTS - outline.length;
  const islands: Loop[] = [];
  for (const island of region.islands) {
    const simplified = simplifyLoop(island, epsilon);
    if (simplified.length < 3 || simplified.length + 2 > room) continue;
    islands.push(simplified);
    room -= simplified.length + 2;
  }
  return { outline, islands };
}

/**
 * The most a plan's cut can take in bytes. Bridging only ever drops points (an island with no clear
 * slit, a corner that rounds onto its neighbour), so the search for a smoothing that fits can count
 * plans and leave the slow bridging to the one smoothing it settles on.
 */
const planBytes = ({ outline, islands }: RegionPlan) => 2 + 2 * islands.reduce((total, island) => total + island.length + 2, outline.length);

function regionStroke({ outline, islands }: RegionPlan): CarvingStroke | null {
  const stroke = toStroke(bridge(outline, islands));
  return stroke.points.length >= 3 && stroke.points.length <= CARVING_MAX_POINTS ? stroke : null;
}

/** The regions' plans at one smoothing; a region that cannot be one cut has none. */
const plansAt = (regions: Region[], epsilon: number, pinned?: Pinned) => regions.map(region => planRegion(region, epsilon, pinned)).filter(plan => plan !== null);

/** The regions' cuts at one smoothing, and how many regions could not be made into one. */
function strokesAt(regions: Region[], epsilon: number, pinned?: Pinned): { strokes: CarvingStroke[]; failed: number } {
  const strokes: CarvingStroke[] = [];
  for (const plan of plansAt(regions, epsilon, pinned)) {
    const stroke = regionStroke(plan);
    if (stroke) strokes.push(stroke);
  }
  return { strokes, failed: regions.length - strokes.length };
}

/** Islands at least this big, in square grid units, are opened up by a band cut rather than bridged. */
const BAND_ISLAND_AREA = 8;
const MAX_BAND_CUTS = 40;

/**
 * Columns, in mask cells on whole grid units, to split the mask at so its bigger islands are opened
 * up. A bridged island has to share its cut's 255 points with the outline around it, and a big one -
 * the face left uncut in a dark picture, the lines round an eye in stained glass - rarely fits and
 * is dropped, cutting the whole region. A vertical line through an island instead leaves it as a
 * notch in the cuts either side, which costs only the few corners where the line crosses an
 * outline, and keeps each cut smaller too. The cuts either side meet edge to edge, so the seam is
 * hidden under the game's outline. One cut through an island opens it; biggest islands first.
 */
function bandCuts(loops: Loop[], scale: number): number[] {
  const islands = loops
    .map(loop => ({ loop, area: -doubleArea(loop) / 2 }))
    .filter(({ area }) => area >= BAND_ISLAND_AREA * scale * scale)
    .sort((a, b) => b.area - a.area);
  const cuts: number[] = [];
  for (const { loop } of islands) {
    let min = Infinity, max = -Infinity;
    for (const { x } of loop) { if (x < min) min = x; if (x > max) max = x; }
    if (cuts.some(cut => cut > min && cut < max)) continue;
    const cut = Math.round((min + max) / 2 / scale) * scale;
    if (cut <= min || cut >= max) continue;
    cuts.push(cut);
    if (cuts.length >= MAX_BAND_CUTS) break;
  }
  return cuts.sort((a, b) => a - b);
}

/** The outlines of a mask, as a carving that fits the game's limits. */
export function traceCarving(mask: CarvingMask, options: TraceOptions = {}): TraceResult {
  const minSmoothing = Math.max(.3, options.smoothing ?? .8);
  const scale = options.scale ?? 1;
  let loops = traceLoops(mask, scale);
  const cuts = bandCuts(loops, scale);
  if (cuts.length) {
    const edges = [0, ...cuts, CARVING_GRID * scale];
    loops = edges.slice(1).flatMap((to, k) => traceLoops(mask, scale, edges[k], to));
  }
  if (scale !== 1) for (const loop of loops) for (const point of loop) { point.x /= scale; point.y /= scale; }
  // Corners on a seam are kept where they are, so the cuts either side of it go on meeting edge to
  // edge however much they are smoothed, rather than each drifting off and leaving a gap.
  const seams = new Set(cuts.map(cut => cut / scale));
  const pinned: Pinned | undefined = seams.size ? point => seams.has(point.x) : undefined;
  let regions = groupRegions(loops, options.minArea ?? 2, 1 / scale).sort((a, b) => b.area - a.area);
  const fits = (epsilon: number) => plansAt(regions, epsilon, pinned).reduce((total, plan) => total + planBytes(plan), 0) <= CARVING_MAX_BYTES;
  let dropped = 0;
  let epsilon = minSmoothing;
  // Most pictures fit as asked, and then none of the searching below is needed.
  if (!fits(epsilon)) {
    // Too many separate specks fit at no smoothing: the smallest go until the rest can.
    while (regions.length > 1 && !fits(MAX_SMOOTHING)) {
      const keep = Math.max(1, Math.floor(regions.length * .85));
      dropped += regions.length - keep;
      regions = regions.slice(0, keep);
    }
    let low = minSmoothing, high = MAX_SMOOTHING;
    for (let i = 0; i < 10; i++) {
      const middle = (low + high) / 2;
      if (fits(middle)) high = middle; else low = middle;
    }
    epsilon = high;
  }
  const { strokes, failed } = strokesAt(regions, epsilon, pinned);
  // Regions too intricate for one cut at any smoothing are left out too.
  dropped += failed;
  // A lone region still too big: cut whole regions from the end until it fits.
  while (strokes.length && carvingBytes(strokes) > CARVING_MAX_BYTES) { strokes.pop(); dropped++; }
  return { strokes, bytes: carvingBytes(strokes), smoothing: epsilon, dropped };
}

/* ── From a picture to a mask ──────────────────────────────────────────────────────────────────── */

/**
 * How a picture becomes cut and uncut cells.
 * - shade: by brightness, dark parts cut (or light, inverted) - suits black and white pictures.
 * - shape: everything that is not background cut - the picture's silhouette.
 * - glass: the silhouette with uncut lines left along every colour boundary, like stained glass -
 *   suits colourful cartoon art, whose parts differ in colour more than in brightness.
 */
export type PictureMode = 'shade' | 'shape' | 'glass';

/** The narrowest stained-glass line, in grid units, that still shows once the outlines are snapped. */
export const MIN_LINE_WIDTH = 2;

export interface PictureSettings {
  mode: PictureMode;
  /** shade: the brightness that splits cut from uncut, 0-255. */
  threshold: number;
  /** shade: cut the light parts instead of the dark. glass: cut only the lines, and the shape's outline. */
  invert: boolean;
  /** shape and glass: how far from the background colour a cell must be to be cut, 0-255. */
  tolerance: number;
  /** glass: how big a colour change draws a line, 0-255 - lower draws more lines. */
  edges: number;
  /** glass: line width in grid units, at least MIN_LINE_WIDTH. */
  lineWidth: number;
}

/** The cells of a mask a picture is drawn over, inclusive. */
export interface PictureExtent { left: number; top: number; right: number; bottom: number }

/** A pixel's brightness, 0-255, with its transparency showing `backdrop` (0-255) behind it. */
export function lumaOver(data: ArrayLike<number>, pixel: number, backdrop: number): number {
  const a = data[pixel * 4 + 3] / 255;
  return (.299 * data[pixel * 4] + .587 * data[pixel * 4 + 1] + .114 * data[pixel * 4 + 2]) * a + backdrop * (1 - a);
}

type Colour = { r: number; g: number; b: number };

/**
 * The picture's background: none when it has transparency, else the colour around its edge - or,
 * for a picture saved with an image editor's grey and white checkerboard baked in where it was
 * transparent, both of the checkerboard's colours (`alt` the second).
 */
export type PictureBackground = (Colour & { alt?: Colour }) | null;

/**
 * Reads the background off the picture drawn on its own (RGBA, width x height): transparent if any
 * pixel is, otherwise the median of its border pixels, or a checkerboard's two colours.
 */
export function pictureBackground(data: ArrayLike<number>, width: number, height: number): PictureBackground {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) return null;
  const border: Colour[] = [];
  const take = (x: number, y: number) => { const i = (y * width + x) * 4; border.push({ r: data[i], g: data[i + 1], b: data[i + 2] }); };
  for (let x = 0; x < width; x++) { take(x, 0); take(x, height - 1); }
  for (let y = 0; y < height; y++) { take(0, y); take(width - 1, y); }
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
  const background = { r: median(border.map(c => c.r)), g: median(border.map(c => c.g)), b: median(border.map(c => c.b)) };
  return { ...background, ...checkerboard(border) };
}

/**
 * A checkerboard's two colours, from a picture's border pixels: almost all of them grey, at two
 * clearly different shades with little in between. A gradient or a photo's edge is grey at many
 * shades, so is never taken for one.
 */
function checkerboard(border: Colour[]): { r: number; g: number; b: number; alt: Colour } | null {
  const grey = border.filter(({ r, g, b }) => Math.max(r, g, b) - Math.min(r, g, b) <= 20);
  if (grey.length < border.length * .85) return null;
  const luma = ({ r, g, b }: Colour) => .299 * r + .587 * g + .114 * b;
  const shades = grey.map(luma).sort((a, b) => a - b);
  const dark = shades[Math.floor(shades.length * .15)], light = shades[Math.floor(shades.length * .85)];
  if (light - dark < 12) return null;
  const near = (level: number) => grey.filter(colour => Math.abs(luma(colour) - level) <= 8);
  const darks = near(dark), lights = near(light);
  // Two shades, each a good share of the border, making up most of it between them.
  if (darks.length < grey.length * .2 || lights.length < grey.length * .2 || darks.length + lights.length < grey.length * .7) return null;
  const mean = (colours: Colour[]) => ({
    r: colours.reduce((t, c) => t + c.r, 0) / colours.length,
    g: colours.reduce((t, c) => t + c.g, 0) / colours.length,
    b: colours.reduce((t, c) => t + c.b, 0) / colours.length,
  });
  return { ...mean(lights), alt: mean(darks) };
}

/**
 * The cut cells for a picture drawn into the grid (RGBA, CARVING_GRID square, transparent where the
 * picture does not reach), clipped to the face.
 */
export function pictureMask(picture: ArrayLike<number>, background: PictureBackground, settings: PictureSettings, scale = 1, extent?: PictureExtent): CarvingMask {
  const n = CARVING_GRID * scale;
  const data = denoised(picture, n);
  const mask: CarvingMask = new Uint8Array(n * n);
  const alpha = (i: number) => data[i * 4 + 3] / 255;
  if (settings.mode === 'shade') {
    // Transparency shows white, or black inverted, so empty parts of a picture are never cut.
    const backdrop = settings.invert ? 0 : 255;
    for (let i = 0; i < mask.length; i++) {
      const luma = lumaOver(data, i, backdrop);
      mask[i] = (settings.invert ? luma >= settings.threshold : luma < settings.threshold) ? 1 : 0;
    }
    return cleaned(mask, scale);
  }
  if (background) markForeground(mask, data, background, settings.tolerance, n);
  else for (let i = 0; i < mask.length; i++) mask[i] = alpha(i) >= .5 ? 1 : 0;
  if (settings.mode === 'glass') {
    // A cell is on a line when it differs from a neighbour on either side, so a boundary marks a
    // cell each side of itself; the line is then widened to lineWidth grid units. Only
    // neighbours inside the shape count: the shape's own edge already meets uncut pumpkin, and
    // lining it too would shrink the outline and wipe out its thin parts.
    const difference = (i: number, j: number) => Math.max(
      Math.abs(data[i * 4] * alpha(i) - data[j * 4] * alpha(j)),
      Math.abs(data[i * 4 + 1] * alpha(i) - data[j * 4 + 1] * alpha(j)),
      Math.abs(data[i * 4 + 2] * alpha(i) - data[j * 4 + 2] * alpha(j)),
      Math.abs(data[i * 4 + 3] - data[j * 4 + 3]),
    );
    const neighbours = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    // Past the picture's extent is not background but no picture at all, so a shape running to the
    // picture's edge is not lined along that straight cut-off. Without one given, the whole mask.
    const { left, top, right, bottom } = extent ?? { left: 0, top: 0, right: n - 1, bottom: n - 1 };
    let line = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!mask[i]) continue;
      for (const [dx, dy] of neighbours) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        // Inverted, only the lines are cut, so the shape's edge is lined too or it would have no outline.
        if (!mask[ny * n + nx]) {
          // Marked both sides, as a colour boundary is, so the outline comes out as wide as the other lines.
          if (settings.invert && nx >= left && nx <= right && ny >= top && ny <= bottom) { line[i] = line[ny * n + nx] = 1; break; }
          continue;
        }
        if (difference(i, ny * n + nx) > settings.edges) { line[i] = 1; break; }
      }
    }
    // Marked from both sides it is two cells wide, and each pass adds one cell each side. Never
    // under MIN_LINE_WIDTH: the outlines either side are smoothed and snapped to whole units, which
    // can close a narrower gap, and the line would vanish from the carving.
    const width = Math.max(MIN_LINE_WIDTH, settings.lineWidth);
    const passes = Math.max(0, Math.round((width * scale - 2) / 2));
    for (let grow = 0; grow < passes; grow++) {
      const wider = line.slice();
      for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        if (line[i - 1] || line[i + 1] || line[i - n] || line[i + n]) wider[i] = 1;
      }
      line = wider;
    }
    if (settings.invert) mask.set(line);
    else for (let i = 0; i < mask.length; i++) if (line[i]) mask[i] = 0;
  }
  return cleaned(mask, scale);
}

/**
 * Cut parts and uncut holes smaller than this, in square grid units, are dropped from a picture's
 * mask before it is traced. Photos and compressed pictures are full of them, and each costs a cut's
 * worth of the byte budget while being too small to see on the pumpkin.
 */
const SPECK_AREA = 6;

/** Each picture's denoised copy, kept while the worker or preview holds the picture. */
const denoiseCache = new WeakMap<object, Uint8ClampedArray>();

/**
 * The picture with a 3 x 3 median over each colour: it clears the speckle of photo grain and
 * compression without blurring edges, so stained-glass lines still land on them, and only loses
 * features one mask cell thin, which are finer than a carving can show anyway.
 */
function denoised(data: ArrayLike<number>, n: number): ArrayLike<number> {
  const cached = denoiseCache.get(data as object);
  if (cached) return cached;
  const out = new Uint8ClampedArray(n * n * 4);
  const p = new Int32Array(9);
  const sort = (a: number, b: number) => { if (p[a] > p[b]) { const t = p[a]; p[a] = p[b]; p[b] = t; } };
  for (let y = 0; y < n; y++) {
    const up = Math.max(0, y - 1) * n * 4, row = y * n * 4, down = Math.min(n - 1, y + 1) * n * 4;
    for (let x = 0; x < n; x++) {
      const left = Math.max(0, x - 1) * 4, centre = x * 4, right = Math.min(n - 1, x + 1) * 4;
      const i = row + centre;
      for (let c = 0; c < 3; c++) {
        p[0] = data[up + left + c]; p[1] = data[up + centre + c]; p[2] = data[up + right + c];
        p[3] = data[row + left + c]; p[4] = data[row + centre + c]; p[5] = data[row + right + c];
        p[6] = data[down + left + c]; p[7] = data[down + centre + c]; p[8] = data[down + right + c];
        // Devillard's nine-value median network.
        sort(1, 2); sort(4, 5); sort(7, 8); sort(0, 1); sort(3, 4); sort(6, 7); sort(1, 2); sort(4, 5); sort(7, 8);
        sort(0, 3); sort(5, 8); sort(4, 7); sort(3, 6); sort(1, 4); sort(2, 5); sort(4, 7); sort(4, 2); sort(6, 4); sort(4, 2);
        out[i + c] = p[4];
      }
      out[i + 3] = data[i + 3];
    }
  }
  if (typeof data === 'object') denoiseCache.set(data, out);
  return out;
}

/**
 * Marks the cells that are not background. Background is what can be reached from the edge of the
 * grid, or from around the picture, through cells within `tolerance` of the background colour - so
 * parts of the subject that happen to share that colour stay cut. Patches of it shut in by the
 * subject (the inside of an O) count as background too when, on average, they match it closely.
 */
function markForeground(mask: CarvingMask, data: ArrayLike<number>, background: NonNullable<PictureBackground>, tolerance: number, n: number): void {
  const total = n * n;
  const opaque = (i: number) => data[i * 4 + 3] >= 128;
  const from = (i: number, { r, g, b }: Colour) => Math.max(Math.abs(data[i * 4] - r), Math.abs(data[i * 4 + 1] - g), Math.abs(data[i * 4 + 2] - b));
  // A checkerboard's cells count as background by whichever of its two colours they are nearer.
  const { alt } = background;
  const distance = alt ? (i: number) => Math.min(from(i, background), from(i, alt)) : (i: number) => from(i, background);
  const like = new Uint8Array(total);
  for (let i = 0; i < total; i++) like[i] = !opaque(i) || distance(i) <= tolerance ? 1 : 0;
  const outside = new Uint8Array(total);
  const stack = new Int32Array(total);
  let top = 0;
  const visit = (i: number) => { if (like[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; } };
  for (let i = 0; i < total; i++) {
    const x = i % n, y = (i - x) / n;
    if (!opaque(i) || x === 0 || y === 0 || x === n - 1 || y === n - 1) visit(i);
  }
  const flood = (step: (i: number) => void) => {
    while (top) {
      const i = stack[--top], x = i % n;
      if (x > 0) step(i - 1);
      if (x < n - 1) step(i + 1);
      if (i >= n) step(i - n);
      if (i < total - n) step(i + n);
    }
  };
  flood(visit);
  // The shut-in patches, one at a time: gathered into `patch`, then given to the background if
  // their average is close.
  const seen = new Uint8Array(total);
  const patch = new Int32Array(total);
  for (let start = 0; start < total; start++) {
    if (!like[start] || outside[start] || seen[start]) continue;
    let count = 0, read = 0, sum = 0;
    seen[start] = 1;
    patch[count++] = start;
    const next = (j: number) => { if (like[j] && !outside[j] && !seen[j]) { seen[j] = 1; patch[count++] = j; } };
    while (read < count) {
      const i = patch[read++], x = i % n;
      sum += distance(i);
      if (x > 0) next(i - 1);
      if (x < n - 1) next(i + 1);
      if (i >= n) next(i - n);
      if (i < total - n) next(i + n);
    }
    if (sum / count <= tolerance / 2) for (let k = 0; k < count; k++) outside[patch[k]] = 1;
  }
  for (let i = 0; i < total; i++) mask[i] = opaque(i) && !outside[i] ? 1 : 0;
}

/**
 * A picture's mask made ready to trace: clipped to the face, its ragged edges evened out, and its
 * specks of cut and uncut dropped.
 */
function cleaned(mask: CarvingMask, scale: number): CarvingMask {
  const n = CARVING_GRID * scale;
  clipMaskToFace(mask, scale);
  if (scale > 1) {
    // Each cell takes the majority of the nine around it, which rounds off the single-cell
    // jaggies a picture's edge leaves. Only on a fine mask, where a cell is finer than a carving shows.
    const source = mask.slice();
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const sum = source[i - n - 1] + source[i - n] + source[i - n + 1] + source[i - 1] + source[i] + source[i + 1]
        + source[i + n - 1] + source[i + n] + source[i + n + 1];
      mask[i] = sum >= 5 ? 1 : 0;
    }
    clipMaskToFace(mask, scale);
  }
  // Every connected patch of cut or of uncut smaller than SPECK_AREA takes the value around it. Read
  // from a copy, so a patch flipped early does not merge into one met later.
  const source = mask.slice();
  const minCells = SPECK_AREA * scale * scale;
  const seen = new Uint8Array(n * n);
  const patch = new Int32Array(n * n);
  for (let start = 0; start < n * n; start++) {
    if (seen[start]) continue;
    const value = source[start];
    let count = 0, read = 0;
    seen[start] = 1;
    patch[count++] = start;
    while (read < count) {
      const i = patch[read++], x = i % n;
      const next = (j: number) => { if (!seen[j] && source[j] === value) { seen[j] = 1; patch[count++] = j; } };
      if (x > 0) next(i - 1);
      if (x < n - 1) next(i + 1);
      if (i >= n) next(i - n);
      if (i < n * n - n) next(i + n);
    }
    if (count < minCells) for (let k = 0; k < count; k++) mask[patch[k]] = 1 - value;
  }
  return mask;
}

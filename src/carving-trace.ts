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
export function traceLoops(mask: CarvingMask, scale = 1): Loop[] {
  const n = CARVING_GRID * scale;
  const cut = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && mask[y * n + x] === 1;
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
    for (let x = 0; x < n; x++) {
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
export function simplifyLoop(loop: Loop, epsilon: number): Loop {
  if (loop.length <= 4 || epsilon <= 0) return loop.slice();
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

function regionStroke(region: Region, epsilon: number): CarvingStroke | null {
  // An outline too detailed for one cut is smoothed further on its own, so it is not the whole
  // picture that loses its detail.
  let outline = simplifyLoop(region.outline, epsilon);
  for (let e = epsilon * 1.35; outline.length > CARVING_MAX_POINTS && e <= MAX_SMOOTHING * 8; e *= 1.35) outline = simplifyLoop(region.outline, e);
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
  const stroke = toStroke(bridge(outline, islands));
  return stroke.points.length >= 3 && stroke.points.length <= CARVING_MAX_POINTS ? stroke : null;
}

/** The regions' cuts at one smoothing, and how many regions could not be made into one. */
function strokesAt(regions: Region[], epsilon: number): { strokes: CarvingStroke[]; failed: number } {
  const strokes: CarvingStroke[] = [];
  for (const region of regions) {
    const stroke = regionStroke(region, epsilon);
    if (stroke) strokes.push(stroke);
  }
  return { strokes, failed: regions.length - strokes.length };
}

/** The outlines of a mask, as a carving that fits the game's limits. */
export function traceCarving(mask: CarvingMask, options: TraceOptions = {}): TraceResult {
  const minSmoothing = Math.max(.3, options.smoothing ?? .8);
  const scale = options.scale ?? 1;
  const loops = traceLoops(mask, scale);
  if (scale !== 1) for (const loop of loops) for (const point of loop) { point.x /= scale; point.y /= scale; }
  let regions = groupRegions(loops, options.minArea ?? 2, 1 / scale).sort((a, b) => b.area - a.area);
  const fits = (epsilon: number) => carvingBytes(strokesAt(regions, epsilon).strokes) <= CARVING_MAX_BYTES;
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
  const { strokes, failed } = strokesAt(regions, epsilon);
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
  invert: boolean;
  /** shape and glass: how far from the background colour a cell must be to be cut, 0-255. */
  tolerance: number;
  /** glass: how big a colour change draws a line, 0-255 - lower draws more lines. */
  edges: number;
  /** glass: line width in grid units, at least MIN_LINE_WIDTH. */
  lineWidth: number;
}

/** A pixel's brightness, 0-255, with its transparency showing `backdrop` (0-255) behind it. */
export function lumaOver(data: ArrayLike<number>, pixel: number, backdrop: number): number {
  const a = data[pixel * 4 + 3] / 255;
  return (.299 * data[pixel * 4] + .587 * data[pixel * 4 + 1] + .114 * data[pixel * 4 + 2]) * a + backdrop * (1 - a);
}

/** The picture's background: none when it has transparency, else the colour around its edge. */
export type PictureBackground = { r: number; g: number; b: number } | null;

/**
 * Reads the background off the picture drawn on its own (RGBA, width x height): transparent if any
 * pixel is, otherwise the median of its border pixels.
 */
export function pictureBackground(data: ArrayLike<number>, width: number, height: number): PictureBackground {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) return null;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const take = (x: number, y: number) => { const i = (y * width + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); };
  for (let x = 0; x < width; x++) { take(x, 0); take(x, height - 1); }
  for (let y = 0; y < height; y++) { take(0, y); take(width - 1, y); }
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
  return { r: median(rs), g: median(gs), b: median(bs) };
}

/**
 * The cut cells for a picture drawn into the grid (RGBA, CARVING_GRID square, transparent where the
 * picture does not reach), clipped to the face.
 */
export function pictureMask(data: ArrayLike<number>, background: PictureBackground, settings: PictureSettings, scale = 1): CarvingMask {
  const n = CARVING_GRID * scale;
  const mask: CarvingMask = new Uint8Array(n * n);
  const alpha = (i: number) => data[i * 4 + 3] / 255;
  if (settings.mode === 'shade') {
    // Transparency shows white, or black inverted, so empty parts of a picture are never cut.
    const backdrop = settings.invert ? 0 : 255;
    for (let i = 0; i < mask.length; i++) {
      const luma = lumaOver(data, i, backdrop);
      mask[i] = (settings.invert ? luma >= settings.threshold : luma < settings.threshold) ? 1 : 0;
    }
    clipMaskToFace(mask, scale);
    return mask;
  }
  for (let i = 0; i < mask.length; i++) {
    if (alpha(i) < .5) continue;
    if (!background) { mask[i] = 1; continue; }
    const distance = Math.max(Math.abs(data[i * 4] - background.r), Math.abs(data[i * 4 + 1] - background.g), Math.abs(data[i * 4 + 2] - background.b));
    mask[i] = distance > settings.tolerance ? 1 : 0;
  }
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
    let line = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!mask[i]) continue;
      for (const [dx, dy] of neighbours) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n || !mask[ny * n + nx]) continue;
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
    for (let i = 0; i < mask.length; i++) if (line[i]) mask[i] = 0;
  }
  clipMaskToFace(mask, scale);
  return mask;
}

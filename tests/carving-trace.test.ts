import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CARVING_GRID, CARVING_MAX_BYTES, CARVING_MAX_POINTS, carvingBytes, clipMaskToFace, decodeCarving, encodeCarving, insideFace,
  pictureBackground, pictureMask, traceCarving, traceLoops,
} from '../src/carving-trace.js';

const N = CARVING_GRID;
function maskOf(cut: (x: number, y: number) => boolean): Uint8Array {
  const mask = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) mask[y * N + x] = cut(x + .5, y + .5) ? 1 : 0;
  return mask;
}

/** Whether a point is filled the way the game fills a carving: each cut on its own, nonzero. */
function filled(strokes: ReturnType<typeof traceCarving>['strokes'], x: number, y: number): boolean {
  return strokes.some(({ points }) => {
    let winding = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const cross = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (a.y <= y && b.y > y && cross > 0) winding++;
      else if (a.y > y && b.y <= y && cross < 0) winding--;
    }
    return winding !== 0;
  });
}

test('a square traces to one clockwise loop of four corners', () => {
  const loops = traceLoops(maskOf((x, y) => x > 100 && x < 120 && y > 100 && y < 130));
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);
});

test('a ring keeps its uncut middle', () => {
  const mask = maskOf((x, y) => { const r = Math.hypot(x - 128, y - 128); return r < 60 && r > 30; });
  const { strokes } = traceCarving(mask);
  // Split down the middle, so the hole opens into both halves rather than being bridged.
  assert.equal(strokes.length, 2);
  assert.ok(filled(strokes, 128 + 45, 128));
  assert.ok(!filled(strokes, 128, 128));
  assert.ok(!filled(strokes, 128 + 70, 128));
});

test('a busy picture fits the game limits and round-trips through the encoding', () => {
  const mask = maskOf((x, y) => (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0);
  clipMaskToFace(mask);
  const result = traceCarving(mask);
  assert.ok(result.bytes <= CARVING_MAX_BYTES);
  assert.equal(result.bytes, carvingBytes(result.strokes));
  for (const stroke of result.strokes) {
    assert.ok(stroke.points.length >= 3 && stroke.points.length <= CARVING_MAX_POINTS);
    for (const point of stroke.points) assert.ok(insideFace(point.x + .5, point.y + .5));
  }
  const encoded = encodeCarving(result.strokes);
  assert.ok(encoded.length <= Math.ceil(CARVING_MAX_BYTES / 3) * 4);
  assert.deepEqual(decodeCarving(encoded), result.strokes);
});

test('a mostly cut, speckled picture traces quickly and still carves', () => {
  let seed = 1;
  const mask = maskOf(() => (seed = (seed * 16807) % 2147483647) / 2147483647 < .9);
  clipMaskToFace(mask);
  const started = performance.now();
  const result = traceCarving(mask);
  assert.ok(performance.now() - started < 1000);
  assert.ok(result.strokes.length > 0 && result.bytes <= CARVING_MAX_BYTES);
});

test('stained glass leaves uncut lines between colours, shape cuts the whole silhouette', () => {
  const N4 = N * N * 4;
  const data = new Uint8ClampedArray(N4);
  // Two touching colour blocks on a transparent background.
  for (let y = 100; y < 150; y++) for (let x = 60; x < 200; x++) {
    const i = (y * N + x) * 4;
    data.set(x < 130 ? [220, 60, 30, 255] : [60, 200, 200, 255], i);
  }
  const settings = { mode: 'glass', threshold: 128, invert: false, tolerance: 40, edges: 35, lineWidth: 2 } as const;
  const glass = pictureMask(data, pictureBackground(data, N, N), settings);
  assert.equal(glass[125 * N + 100], 1);
  // The shape's own edge is not lined.
  assert.equal(glass[125 * N + 60], 1);
  assert.equal(glass[100 * N + 100], 1);
  assert.equal(glass[125 * N + 129], 0);
  assert.equal(glass[125 * N + 130], 0);
  const shape = pictureMask(data, null, { ...settings, mode: 'shape' });
  assert.equal(shape[125 * N + 129], 1);
  assert.equal(traceCarving(glass).strokes.length, 2);
});

test('inverted stained glass lines a shape\'s edge, but not where the picture itself ends', () => {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 100; y < 150; y++) for (let x = 60; x < 200; x++) data.set([220, 60, 30, 255], (y * N + x) * 4);
  const settings = { mode: 'glass', threshold: 128, invert: true, tolerance: 40, edges: 35, lineWidth: 2 } as const;
  // The block is the whole picture: its edges are where the picture stops, so nothing is cut.
  const whole = pictureMask(data, null, settings, 1, { left: 60, top: 100, right: 199, bottom: 149 });
  assert.equal(whole[125 * N + 60], 0);
  // The block inside a larger, transparent picture (a freehand crop): its edge is the outline.
  const inside = pictureMask(data, null, settings, 1, { left: 50, top: 90, right: 209, bottom: 159 });
  assert.equal(inside[125 * N + 60], 1);
  assert.equal(inside[125 * N + 100], 0);
});

test('a checkerboard baked in for transparency is taken as background', () => {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const square = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 255 : 204;
    const subject = Math.hypot(x - 128, y - 128) < 40;
    data.set(subject ? [200, 40, 40, 255] : [square, square, square, 255], (y * N + x) * 4);
  }
  const background = pictureBackground(data, N, N);
  assert.ok(background?.alt);
  const mask = pictureMask(data, background, { mode: 'shape', threshold: 128, invert: false, tolerance: 40, edges: 35, lineWidth: 2 });
  assert.equal(mask[128 * N + 128], 1);
  assert.equal(mask[128 * N + 60], 0);
  assert.equal(mask[128 * N + 68], 0);
  // A plain background is still one colour.
  const plain = new Uint8ClampedArray(N * N * 4).fill(255);
  assert.equal(pictureBackground(plain, N, N)?.alt, undefined);
});

test('only background reachable from the edge is left uncut, and specks are dropped', () => {
  const scale = 3, n = N * scale;
  const data = new Uint8ClampedArray(n * n * 4);
  const paint = (x0: number, y0: number, x1: number, y1: number, rgb: number[]) => {
    for (let y = y0 * scale; y < y1 * scale; y++) for (let x = x0 * scale; x < x1 * scale; x++) data.set([...rgb, 255], (y * n + x) * 4);
  };
  paint(0, 0, N, N, [200, 200, 200]);
  // A dark ring holding a patch near the background colour, and a pure background patch.
  paint(80, 90, 180, 170, [30, 30, 30]);
  paint(95, 110, 125, 150, [180, 175, 185]);
  paint(140, 110, 165, 150, [200, 200, 200]);
  // A one-unit speck of dark out on the background.
  paint(60, 128, 61, 129, [30, 30, 30]);
  const settings = { mode: 'shape', threshold: 128, invert: false, tolerance: 40, edges: 35, lineWidth: 2 } as const;
  const started = performance.now();
  const mask = pictureMask(data, pictureBackground(data, n, n), settings, scale);
  assert.ok(performance.now() - started < 2000);
  const at = (x: number, y: number) => mask[(y * scale + 1) * n + x * scale + 1];
  assert.equal(at(100, 130), 1);
  assert.equal(at(150, 130), 0);
  assert.equal(at(60, 128), 0);
  assert.equal(at(40, 128), 0);
});

test('a finer mask traces a slanted edge as a straight line, not steps', () => {
  const scale = 3, n = N * scale;
  const mask = new Uint8Array(n * n);
  // A triangle with a 1:3 slope, which on the coarse grid would trace as a staircase.
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const gx = (x + .5) / scale, gy = (y + .5) / scale;
    mask[y * n + x] = gx > 90 && gx < 170 && gy > 100 && gy < 160 && gy - 100 > (gx - 90) / 3 ? 1 : 0;
  }
  const { strokes } = traceCarving(mask, { scale, smoothing: .5 });
  assert.equal(strokes.length, 1);
  assert.ok(strokes[0].points.length <= 5, `${strokes[0].points.length} points`);
  for (const point of strokes[0].points) assert.ok(point.x >= 89 && point.x <= 171 && point.y >= 99 && point.y <= 161);
});

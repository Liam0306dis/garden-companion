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
  assert.equal(strokes.length, 1);
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

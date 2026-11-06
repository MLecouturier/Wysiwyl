// Unit tests for the shared viewer rendering helpers (src/js/viewer-render.js).
// Only the pure helpers are exercised here: computeLayout and
// cellSetFromZones need no canvas, the drawing functions do and are out
// of scope for the node test runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    computeLayout, cellSetFromZones, MUTE_GLYPH,
    clampZoom, clampZoomCenter, computeZoomedLayout, zoomAtPoint,
} from '../src/js/core/geometry.js';

test('computeLayout contains a square grid in a square viewer', () => {
    assert.deepEqual(computeLayout(100, 100, 10, 10), {
        renderW: 100,
        renderH: 100,
        offsetX: 0,
        offsetY: 0,
        cellW: 10,
        cellH: 10,
        gridW: 10,
        gridH: 10,
    });
});

test('computeLayout letterboxes a wide grid in a square viewer', () => {
    const l = computeLayout(100, 100, 20, 10); // ratio 2 > viewer ratio 1
    assert.equal(l.renderW, 100);
    assert.equal(l.renderH, 50);
    assert.equal(l.offsetX, 0);
    assert.equal(l.offsetY, 25);
    assert.equal(l.cellW, 5);
    assert.equal(l.cellH, 5);
});

test('computeLayout pillarboxes a tall grid in a square viewer', () => {
    const l = computeLayout(100, 100, 10, 20); // ratio 0.5 < viewer ratio 1
    assert.equal(l.renderW, 50);
    assert.equal(l.renderH, 100);
    assert.equal(l.offsetX, 25);
    assert.equal(l.offsetY, 0);
});

test('computeLayout returns null when a dimension is missing', () => {
    assert.equal(computeLayout(0, 100, 10, 10), null);
    assert.equal(computeLayout(100, 0, 10, 10), null);
    assert.equal(computeLayout(100, 100, 0, 10), null);
    assert.equal(computeLayout(100, 100, 10, 0), null);
});

test('cellSetFromZones enumerates the covered cells as col,row keys', () => {
    const cells = cellSetFromZones([
        { order: 0, runs: [{ y: 0, x0: 0, x1: 1 }] },
        { order: 1, runs: [{ y: 2, x0: 3, x1: 3 }] },
    ]);
    assert.deepEqual([...cells].sort(), ['0,0', '1,0', '3,2']);
});

test('MUTE_GLYPH is the music rest character', () => {
    assert.equal(MUTE_GLYPH, '\u{1d19d}');
});

// ---------- Zoomed layout ----------

test('clampZoom keeps the zoom within its bounds', () => {
    assert.equal(clampZoom(0.2), 1);
    assert.equal(clampZoom(1000), 40);
    assert.equal(clampZoom(NaN), 1);
    assert.equal(clampZoom(2.5), 2.5);
});

test('clampZoomCenter centers an axis smaller than the viewer', () => {
    const c = clampZoomCenter(0.1, 0.9, 100, 100, 50, 200);
    assert.equal(c.x, 0.5); // 50 <= 100: centered
    // 200 > 100: margin = 100/(2*200) = 0.25, so 0.9 clamps to 0.75
    assert.equal(c.y, 0.75);
});

test('computeZoomedLayout falls back to the plain fit at zoom 1', () => {
    assert.deepEqual(
        computeZoomedLayout(100, 100, 10, 10, 1, 0.2, 0.8),
        computeLayout(100, 100, 10, 10),
    );
});

test('computeZoomedLayout magnifies around the center fraction', () => {
    const l = computeZoomedLayout(100, 100, 10, 10, 2, 0.5, 0.5);
    assert.equal(l.renderW, 200);
    assert.equal(l.renderH, 200);
    assert.equal(l.offsetX, -50); // 50 - 0.5 * 200
    assert.equal(l.offsetY, -50);
    assert.equal(l.cellW, 20);
    assert.equal(l.cellH, 20);
});

test('computeZoomedLayout clamps the center to keep the edges flush', () => {
    // Center asked at 0 (top-left): clamped to the margin 100/(2*200)
    const l = computeZoomedLayout(100, 100, 10, 10, 2, 0, 0);
    assert.equal(l.offsetX, 0);
    assert.equal(l.offsetY, 0);
});

test('zoomAtPoint keeps the image point under the cursor fixed', () => {
    const base = computeLayout(100, 100, 10, 10);
    const current = base; // zoom 1
    const next = zoomAtPoint(base, current, 25, 25, 2, 100, 100);
    assert.equal(next.zoom, 2);
    const l = computeZoomedLayout(100, 100, 10, 10, next.zoom, next.centerX, next.centerY);
    // The fraction 0.25 must land back under x = 25
    assert.ok(Math.abs(l.offsetX + 0.25 * l.renderW - 25) < 1e-9);
    assert.ok(Math.abs(l.offsetY + 0.25 * l.renderH - 25) < 1e-9);
});

test('zoomAtPoint resets to fit when the new zoom is at or below 1', () => {
    const base = computeLayout(100, 100, 10, 10);
    assert.deepEqual(zoomAtPoint(base, base, 30, 30, 0.5, 100, 100),
        { zoom: 1, centerX: 0.5, centerY: 0.5 });
});



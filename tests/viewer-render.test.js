// Unit tests for the shared viewer rendering helpers (src/js/viewer-render.js).
// Only the pure helpers are exercised here: computeLayout and
// cellSetFromZones need no canvas, the drawing functions do and are out
// of scope for the node test runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout, cellSetFromZones, MUTE_GLYPH } from '../src/js/core/geometry.js';

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

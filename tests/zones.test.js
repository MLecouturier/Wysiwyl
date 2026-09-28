// Unit tests for the frontend zone model (src/js/zones.js), the twin of
// the Rust `zone` module. Pure logic, no DOM and no Tauri globals: run
// with `npm test` (node --test, no bundler needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    nextZoneOrder,
    seedZoneOrder,
    rectZone,
    zoneCellSet,
    zoneContains,
    zoneIntersectsRect,
    zonesPixelCount,
    zonesEqual,
    rebuildZones,
} from '../src/js/core/geometry.js';

const sortedCells = (set) => [...set].sort();
const runsOf = (zone) => zone.runs.map((r) => [r.y, r.x0, r.x1]);
const cellSet = (cells) => new Set(cells.map(([x, y]) => `${x},${y}`));

test('rectZone builds one run per row', () => {
    const z = rectZone(2, 1, 3, 2, 0);
    assert.deepEqual(runsOf(z), [[1, 2, 4], [2, 2, 4]]);
    assert.equal(z.order, 0);
});

test('rectZone without an explicit order consumes the creation counter', () => {
    seedZoneOrder([]); // counter back to 1
    assert.equal(rectZone(0, 0, 1, 1).order, 1);
    assert.equal(rectZone(0, 0, 1, 1).order, 2);
});

test('zoneCellSet enumerates the covered cells as col,row keys', () => {
    const z = rectZone(2, 1, 3, 2, 0);
    assert.deepEqual(sortedCells(zoneCellSet([z])),
        ['2,1', '2,2', '3,1', '3,2', '4,1', '4,2']);
});

test('zoneContains checks the cell against the runs', () => {
    const z = rectZone(2, 1, 3, 2, 0); // rows 1-2, cols 2-4
    assert.equal(zoneContains(z, 2, 1), true);
    assert.equal(zoneContains(z, 4, 2), true);
    assert.equal(zoneContains(z, 5, 1), false); // right of the run
    assert.equal(zoneContains(z, 1, 1), false); // left of the run
    assert.equal(zoneContains(z, 2, 0), false); // above
    assert.equal(zoneContains(z, 2, 3), false); // below
});

test('zoneContains scans every run of a row (U-shape)', () => {
    // A U-shaped component: the middle row carries two disjoint runs,
    // joined through the row below
    const cells = [
        [0, 0], [1, 0],
        [0, 1], [1, 1], [4, 1], [5, 1],
        [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2],
    ];
    const u = rebuildZones([], cellSet(cells))[0];
    assert.equal(zoneContains(u, 0, 1), true);
    assert.equal(zoneContains(u, 1, 1), true);
    assert.equal(zoneContains(u, 4, 1), true);
    assert.equal(zoneContains(u, 5, 1), true);
    assert.equal(zoneContains(u, 2, 1), false); // the gap
    assert.equal(zoneContains(u, 2, 2), true); // the bridge below
});

test('zoneIntersectsRect detects overlap', () => {
    const z = rectZone(2, 1, 3, 2, 0); // rows 1-2, cols 2-4
    assert.equal(zoneIntersectsRect(z, { x: 0, y: 0, w: 3, h: 3 }), true);
    assert.equal(zoneIntersectsRect(z, { x: 0, y: 0, w: 2, h: 2 }), false);
    assert.equal(zoneIntersectsRect(z, { x: 5, y: 0, w: 2, h: 2 }), false);
    assert.equal(zoneIntersectsRect(z, { x: 4, y: 2, w: 1, h: 1 }), true);
});

test('zonesPixelCount sums the run lengths exactly', () => {
    assert.equal(zonesPixelCount([rectZone(2, 1, 3, 2, 0)]), 6);
    assert.equal(zonesPixelCount([
        rectZone(0, 0, 2, 2, 0),
        rectZone(5, 5, 3, 1, 1),
    ]), 4 + 3);
});

test('zonesEqual is order-sensitive on zones and runs', () => {
    const a = [rectZone(0, 0, 2, 1, 0)];
    assert.equal(zonesEqual(a, [rectZone(0, 0, 2, 1, 0)]), true);
    assert.equal(zonesEqual(a, [rectZone(0, 0, 2, 1, 1)]), false); // order differs
    assert.equal(zonesEqual(a, [rectZone(0, 0, 3, 1, 0)]), false); // runs differ
    assert.equal(zonesEqual(a, []), false);
});

test('rebuildZones fuses components keeping the eldest order', () => {
    seedZoneOrder([]);
    const a = rectZone(0, 0, 1, 1, 1); // order 1
    const b = rectZone(2, 0, 1, 1, 5); // order 5
    const out = rebuildZones([a, b], cellSet([[0, 0], [1, 0], [2, 0]]));
    assert.equal(out.length, 1);
    assert.equal(out[0].order, 1);
    assert.deepEqual(runsOf(out[0]), [[0, 0, 2]]);
});

test('rebuildZones splits a component keeping the parent order for every fragment', () => {
    seedZoneOrder([]);
    const parent = rectZone(0, 0, 3, 1, 3); // one row, cols 0-2, order 3
    const out = rebuildZones([parent], cellSet([[0, 0], [2, 0]])); // middle erased
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((z) => z.order), [3, 3]);
    // Sorted canonically by top-left: (0,0) before (2,0)
    assert.deepEqual(runsOf(out[0]), [[0, 0, 0]]);
    assert.deepEqual(runsOf(out[1]), [[0, 2, 2]]);
});

test('rebuildZones gives fresh orders to genuinely new components', () => {
    seedZoneOrder([]); // next order is 1
    const out = rebuildZones([], cellSet([[4, 4]]));
    assert.equal(out.length, 1);
    assert.equal(out[0].order, 1);
});

test('rebuildZones returns an empty list for an empty cell set', () => {
    assert.deepEqual(rebuildZones([rectZone(0, 0, 1, 1, 0)], new Set()), []);
});

test('seedZoneOrder resumes past every order already in use', () => {
    seedZoneOrder([{ order: 2, runs: [] }, { order: 7, runs: [] }]);
    assert.equal(nextZoneOrder(), 8);
});

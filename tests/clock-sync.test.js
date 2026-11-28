// Unit tests for the wall-clock calibration helpers
// (src/js/core/clock-sync.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { midpointOffset, bestOffset } from '../src/js/core/clock-sync.js';

test('midpointOffset assumes the Rust timestamp at the round-trip midpoint', () => {
    // Call started at 1000, answered at 1010: midpoint 1005; Rust says 5000
    assert.equal(midpointOffset(1000, 1010, 5000), 5000 - 1005);
    // A zero round-trip is the exact exchange
    assert.equal(midpointOffset(1000, 1000, 5000), 4000);
});

test('bestOffset keeps the smallest round-trip sample', () => {
    const samples = [
        { rtt: 8, offset: 100 },
        { rtt: 2, offset: 104 },
        { rtt: 5, offset: 99 },
    ];
    assert.equal(bestOffset(samples), 104);
});

test('bestOffset returns null without samples', () => {
    assert.equal(bestOffset([]), null);
    assert.equal(bestOffset(null), null);
});

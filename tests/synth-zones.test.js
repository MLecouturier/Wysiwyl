// Unit tests for the synth zone helpers (src/js/synth/selection.js). Only
// the pure helpers are exercised; the send/edit functions are IPC- and
// DOM-bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { muteCellSet, selectionMode, wandFloodCells, wandGlobalCells } from '../src/js/synth/selection.js';
import { viewer } from '../src/js/core/state.js';

test('muteCellSet enumerates the cells of the mute zones', () => {
    const hi = {
        muteZones: [{
            order: 0,
            runs: [{ y: 0, x0: 0, x1: 1 }, { y: 1, x0: 0, x1: 0 }],
        }],
    };
    assert.deepEqual([...muteCellSet(hi)].sort(), ['0,0', '0,1', '1,0']);
});

test('muteCellSet is empty without mute zones', () => {
    assert.equal(muteCellSet({ muteZones: [] }).size, 0);
});

test('selectionMode resolves the editing mode from the modifiers', () => {
    assert.equal(selectionMode(false, false), 'add');
    assert.equal(selectionMode(true, false), 'remove');
    assert.equal(selectionMode(false, true), 'silence');
    assert.equal(selectionMode(true, true), 'unsilence');
});

// A 4x1 image: black, black, white, black (RGBA per pixel).
function setWandFixture() {
    viewer.processedPixels = {
        width: 4,
        height: 1,
        rgba: new Uint8ClampedArray([
            0, 0, 0, 255,
            0, 0, 0, 255,
            255, 255, 255, 255,
            0, 0, 0, 255,
        ]),
    };
    viewer.gridW = 4;
    viewer.gridH = 1;
}

test('wandFloodCells selects only the pixels connected to the seed', () => {
    setWandFixture();
    // Seed on the first black pixel: the white pixel blocks the flood, so
    // the trailing black pixel (col 3) is NOT reached.
    const cells = wandFloodCells({ col: 0, row: 0 }, 0);
    assert.deepEqual([...cells].sort(), ['0,0', '1,0']);
});

test('wandGlobalCells selects every in-tolerance pixel, touching or not', () => {
    setWandFixture();
    // Same seed: the trailing black pixel matches by color even though it
    // is disconnected from the seed.
    const cells = wandGlobalCells({ col: 0, row: 0 }, 0);
    assert.deepEqual([...cells].sort(), ['0,0', '1,0', '3,0']);
});

// Unit tests for the synth zone helpers (src/js/synth/selection.js). Only
// the pure helpers are exercised; the send/edit functions are IPC- and
// DOM-bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lassoAffectedCells, muteCellSet, hoverModeKind, selectionMode, wandFloodCells, wandGlobalCells } from '../src/js/synth/selection.js';
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

test('hoverModeKind follows the modifiers for the rect/lasso/wand tools', () => {
    for (const tool of ['rect', 'lasso', 'wand']) {
        assert.equal(hoverModeKind(tool, false, false), 'add');
        assert.equal(hoverModeKind(tool, true, false), 'remove');
        assert.equal(hoverModeKind(tool, false, true), 'silence');
        assert.equal(hoverModeKind(tool, true, true), 'unsilence');
    }
});

test('hoverModeKind always reads "silence" for the silence-pattern tool', () => {
    assert.equal(hoverModeKind('pattern', false, false), 'silence');
    assert.equal(hoverModeKind('pattern', true, true), 'silence');
});

// A 2x2 lasso: enclosed cells "0,0" and "1,0"; "0,1" is selected but not
// enclosed, "1,0" is enclosed and muted.
const ENCLOSED = new Set(['0,0', '1,0']);
const SELECTED = new Set(['0,1', '1,0']);
const MUTED = new Set(['1,0']);

test('lassoAffectedCells (add) returns every enclosed cell', () => {
    const { affected, willMute } = lassoAffectedCells('add', ENCLOSED, SELECTED, MUTED);
    assert.deepEqual([...affected].sort(), ['0,0', '1,0']);
    assert.equal(willMute.size, 0);
});

test('lassoAffectedCells (remove) keeps only the enclosed selected cells', () => {
    const { affected, willMute } = lassoAffectedCells('remove', ENCLOSED, SELECTED, MUTED);
    assert.deepEqual([...affected], ['1,0']);
    assert.equal(willMute.size, 0);
});

test('lassoAffectedCells (silence) toggles enclosed selected cells, veiling the played ones', () => {
    const { affected, willMute } = lassoAffectedCells('silence', ENCLOSED, SELECTED, MUTED);
    assert.deepEqual([...affected], ['1,0']);
    // "1,0" is already muted: it will play again, so it is not veiled
    assert.equal(willMute.size, 0);
});

test('lassoAffectedCells (silence) veils a played enclosed selected cell', () => {
    const { affected, willMute } = lassoAffectedCells('silence', ENCLOSED, SELECTED, new Set());
    assert.deepEqual([...affected], ['1,0']);
    assert.deepEqual([...willMute], ['1,0']);
});

test('lassoAffectedCells (unsilence) keeps only the enclosed muted cells', () => {
    const { affected, willMute } = lassoAffectedCells('unsilence', ENCLOSED, SELECTED, MUTED);
    assert.deepEqual([...affected], ['1,0']);
    assert.equal(willMute.size, 0);
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

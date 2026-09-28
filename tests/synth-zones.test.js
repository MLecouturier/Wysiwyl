// Unit tests for the synth zone helpers (src/js/synth-zones.js). Only the
// pure helpers are exercised; the send/edit functions are IPC- and
// DOM-bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { muteCellSet, rectOverlapsMuteZones } from '../src/js/synth/selection.js';
import { synthHighlights } from '../src/js/core/state.js';

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

test('rectOverlapsMuteZones reads the registry', () => {
    synthHighlights.set(99, {
        visible: true,
        zones: [],
        muteZones: [{ order: 0, runs: [{ y: 2, x0: 2, x1: 3 }] }],
    });
    assert.equal(rectOverlapsMuteZones(99, { x: 0, y: 0, w: 3, h: 3 }), true);
    assert.equal(rectOverlapsMuteZones(99, { x: 5, y: 5, w: 1, h: 1 }), false);
    assert.equal(rectOverlapsMuteZones(123, { x: 0, y: 0, w: 1, h: 1 }), false);
    synthHighlights.delete(99);
});

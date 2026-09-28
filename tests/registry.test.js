// Unit tests for the centralized frontend state registries
// (src/js/state/synth-registry.js and src/js/state/viewer-state.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    synthNames, synthDisplayNumbers, synthColors, synthHighlights,
    synthBrightnessBounds, synthCursors, synthCursorGrid, synthCursorMuted,
    clearSynthRegistry, removeSynthFromRegistry,
} from '../src/js/core/state.js';
import { viewer } from '../src/js/core/state.js';

const allMaps = [
    synthNames, synthDisplayNumbers, synthColors, synthHighlights,
    synthBrightnessBounds, synthCursors, synthCursorGrid, synthCursorMuted,
];

test('clearSynthRegistry empties every per-synth map', () => {
    synthNames.set(1, 'Lead');
    synthDisplayNumbers.set(1, 1);
    synthColors.set(1, '#ff0000');
    synthHighlights.set(1, { visible: true, zones: [] });
    synthBrightnessBounds.set(1, { min: 0, max: 127 });
    synthCursors.set(1, 3);
    synthCursorGrid.set(1, { w: 10, h: 10 });
    synthCursorMuted.set(1, true);

    clearSynthRegistry();

    for (const map of allMaps) assert.equal(map.size, 0);
});

test('removeSynthFromRegistry drops only the given synth', () => {
    synthColors.set(1, '#ff0000');
    synthColors.set(2, '#00ff00');
    synthNames.set(1, 'A');
    synthNames.set(2, 'B');

    removeSynthFromRegistry(1);

    assert.equal(synthColors.has(1), false);
    assert.equal(synthNames.has(1), false);
    assert.equal(synthColors.get(2), '#00ff00');
    assert.equal(synthNames.get(2), 'B');

    clearSynthRegistry();
});

test('viewer holds the image/grid defaults', () => {
    assert.equal(viewer.hasImage, false);
    assert.equal(viewer.gridW, 1);
    assert.equal(viewer.gridH, 1);
    assert.equal(viewer.processedPixels, null);
    assert.equal(viewer.transformPreviewPixels, null);
});

test('viewer is a shared mutable object', () => {
    const before = viewer.gridW;
    viewer.gridW = 42;
    assert.equal(viewer.gridW, 42);
    viewer.gridW = before; // restore
});

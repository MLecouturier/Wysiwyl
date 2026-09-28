// Unit tests for the image control slider mappings (src/js/image-scale.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SLIDER_STEPS, MIN_CELLS,
    sliderToCells, cellsToSlider,
    sliderToPosterizeLevels, posterizeLevelsToSlider,
} from '../src/js/core/utils.js';

test('sliderToCells clamps to the grid bounds', () => {
    assert.equal(sliderToCells(0, 100), MIN_CELLS);
    assert.equal(sliderToCells(SLIDER_STEPS, 100), 100);
    // A missing or too-small max falls back to the minimum
    assert.equal(sliderToCells(500, 0), MIN_CELLS);
    assert.equal(sliderToCells(500, 1), MIN_CELLS);
    assert.equal(sliderToCells(500, undefined), MIN_CELLS);
});

test('sliderToCells is monotonically increasing', () => {
    let prev = -1;
    for (let v = 0; v <= SLIDER_STEPS; v += 50) {
        const cells = sliderToCells(v, 500);
        assert.ok(cells >= prev, `not monotonic at v=${v}`);
        prev = cells;
    }
});

test('cellsToSlider is the inverse of sliderToCells on reachable values', () => {
    const maxCells = 800;
    for (const cells of [2, 3, 10, 50, 200, 800]) {
        const v = cellsToSlider(cells, maxCells);
        assert.equal(sliderToCells(v, maxCells), cells, `round-trip for ${cells} cells`);
    }
});

test('posterize slider maps 0 to off and the range to levels', () => {
    assert.equal(sliderToPosterizeLevels(0), null);
    assert.equal(sliderToPosterizeLevels(1), 64); // first notch = most levels
    assert.equal(sliderToPosterizeLevels(SLIDER_STEPS), 2); // far right = fewest levels
});

test('posterizeLevelsToSlider is the inverse of sliderToPosterizeLevels', () => {
    for (const levels of [2, 4, 8, 16, 32, 64]) {
        const v = posterizeLevelsToSlider(levels);
        assert.equal(sliderToPosterizeLevels(v), levels, `round-trip for ${levels} levels`);
    }
});

test('posterizeLevelsToSlider maps off and legacy values', () => {
    assert.equal(posterizeLevelsToSlider(null), 0);
    assert.equal(posterizeLevelsToSlider(0), 0);
    assert.equal(posterizeLevelsToSlider(1), 0);
    // A level above the current maximum clamps to the strongest position
    assert.equal(posterizeLevelsToSlider(255), 1);
});

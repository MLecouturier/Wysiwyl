// Unit tests for the RGB color helpers (src/js/color.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rgbToHsl, rgbToTslStr } from '../src/js/core/utils.js';

test('rgbToHsl maps the primaries', () => {
    assert.deepEqual(rgbToHsl(255, 0, 0), [0, 100, 50]);
    assert.deepEqual(rgbToHsl(0, 255, 0), [120, 100, 50]);
    assert.deepEqual(rgbToHsl(0, 0, 255), [240, 100, 50]);
});

test('rgbToHsl handles achromatic colors (hue undefined → 0)', () => {
    assert.deepEqual(rgbToHsl(128, 128, 128), [0, 0, 50]);
    assert.deepEqual(rgbToHsl(255, 255, 255), [0, 0, 100]);
    assert.deepEqual(rgbToHsl(0, 0, 0), [0, 0, 0]);
});

test('rgbToTslStr formats the TSL values', () => {
    assert.equal(rgbToTslStr(255, 0, 0), '0°, 100%, 50%');
    assert.equal(rgbToTslStr(0, 0, 0), '0°, 0%, 0%');
});

test('rgbToTslStr returns a dash for an unknown channel', () => {
    assert.equal(rgbToTslStr(null, 0, 0), '-');
    assert.equal(rgbToTslStr(0, undefined, 0), '-');
});

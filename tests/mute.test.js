// Unit tests for the mute toggle value helper (src/js/core/utils.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mutedVolume } from '../src/js/core/utils.js';

test('mutedVolume: a positive volume is muted to 0', () => {
    assert.equal(mutedVolume(127, undefined), 0);
    assert.equal(mutedVolume(1, 80), 0);
});

test('mutedVolume: unmuting restores the memorised value', () => {
    assert.equal(mutedVolume(0, 64), 64);
    assert.equal(mutedVolume(0, 127), 127);
});

test('mutedVolume: falls back to 100 with no memorised value', () => {
    assert.equal(mutedVolume(0, undefined), 100);
    assert.equal(mutedVolume(0, 0), 100);
    assert.equal(mutedVolume(0, NaN), 100);
});

test('mutedVolume: a custom fallback is honoured', () => {
    assert.equal(mutedVolume(0, undefined, 42), 42);
});

test('mutedVolume: non-finite current counts as unmuted', () => {
    assert.equal(mutedVolume(NaN, 90), 90);
    assert.equal(mutedVolume(NaN, undefined), 100);
});

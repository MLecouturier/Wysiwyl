// Unit tests for the play-all status helper (src/js/core/utils.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { playAllStatus } from '../src/js/core/utils.js';

test('playAllStatus: idle when nobody plays (or no synth exists)', () => {
    assert.equal(playAllStatus(0, 0), 'idle');
    assert.equal(playAllStatus(1, 0), 'idle');
    assert.equal(playAllStatus(3, 0), 'idle');
});

test('playAllStatus: selective for a strict subset', () => {
    assert.equal(playAllStatus(2, 1), 'selective');
    assert.equal(playAllStatus(3, 1), 'selective');
    assert.equal(playAllStatus(3, 2), 'selective');
});

test('playAllStatus: active when every synth plays', () => {
    assert.equal(playAllStatus(1, 1), 'active');
    assert.equal(playAllStatus(3, 3), 'active');
});

test('playAllStatus: clamps a count above the total', () => {
    assert.equal(playAllStatus(3, 4), 'active');
});

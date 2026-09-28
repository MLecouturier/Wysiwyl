// Unit tests for the note-length timing helpers (src/js/note-timing.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOTE_LENGTH_BEATS, formatDurationClock, zonesTotalBeats } from '../src/js/core/timing.js';

test('NOTE_LENGTH_BEATS mirrors the backend values', () => {
    assert.deepEqual(NOTE_LENGTH_BEATS, {
        sixteenth: 0.25,
        eighth: 0.5,
        quarter: 1,
        half: 2,
        whole: 4,
    });
});

test('formatDurationClock renders m:ss and h:mm:ss', () => {
    assert.equal(formatDurationClock(0), '0:00');
    assert.equal(formatDurationClock(42), '0:42');
    assert.equal(formatDurationClock(83), '1:23');
    assert.equal(formatDurationClock(3723), '1:02:03');
});

test('formatDurationClock rounds to the nearest second', () => {
    assert.equal(formatDurationClock(0.4), '0:00');
    assert.equal(formatDurationClock(0.6), '0:01');
});

// A 2x1 image: pixel 0 black (level 0), pixel 1 white (level 127)
const twoPixels = () => ({
    width: 2,
    rgba: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
});
const oneRowZone = [{ order: 0, runs: [{ y: 0, x0: 0, x1: 1 }] }];

test('zonesTotalBeats picks a length per pixel brightness', () => {
    // Black → band 0 (shortest), white → band 1 (longest): 0.5 + 1 = 1.5
    assert.equal(zonesTotalBeats(oneRowZone, twoPixels(), [0.5, 1], 1), 1.5);
});

test('zonesTotalBeats divides by the tempo ratio', () => {
    assert.equal(zonesTotalBeats(oneRowZone, twoPixels(), [0.5, 1], 2), 0.75);
});

test('zonesTotalBeats handles a single enabled length', () => {
    // One band: every pixel gets the same length (2 pixels × 1 beat)
    assert.equal(zonesTotalBeats(oneRowZone, twoPixels(), [1], 1), 2);
});

test('zonesTotalBeats returns 0 for an empty selection or missing pixels', () => {
    assert.equal(zonesTotalBeats([], twoPixels(), [1], 1), 0);
    assert.equal(zonesTotalBeats(oneRowZone, null, [1], 1), 0);
    assert.equal(zonesTotalBeats(oneRowZone, twoPixels(), [], 1), 0);
});

test('zonesTotalBeats ignores out-of-bounds runs (torn edges)', () => {
    const zone = [{ order: 0, runs: [{ y: 0, x0: 0, x1: 5 }] }]; // runs past the 2px width
    // Only the two real pixels count
    assert.equal(zonesTotalBeats(zone, twoPixels(), [1], 1), 2);
});

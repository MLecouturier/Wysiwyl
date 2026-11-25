// Unit tests for the note-length timing helpers (src/js/note-timing.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    NOTE_LENGTH_BEATS,
    TERNARY_FACTOR,
    noteLengthBeats,
    formatDurationClock,
    zonesTotalBeats,
    freqToTicks,
    ticksToFreq,
} from '../src/js/core/timing.js';

test('NOTE_LENGTH_BEATS mirrors the backend values', () => {
    assert.deepEqual(NOTE_LENGTH_BEATS, {
        sixteenth: 0.25,
        eighth: 0.5,
        quarter: 1,
        half: 2,
        whole: 4,
    });
});

test('noteLengthBeats returns nominal values in binary mode', () => {
    assert.equal(noteLengthBeats('quarter'), 1);
    assert.equal(noteLengthBeats('eighth', false), 0.5);
});

test('noteLengthBeats applies the 2/3 triplet factor in ternary mode', () => {
    assert.equal(TERNARY_FACTOR, 2 / 3);
    assert.equal(noteLengthBeats('quarter', true), 2 / 3);
    assert.equal(noteLengthBeats('eighth', true), 1 / 3);
    assert.equal(noteLengthBeats('sixteenth', true), 1 / 6);
});

test('noteLengthBeats falls back to the quarter note for unknown keys', () => {
    assert.equal(noteLengthBeats('nope'), 1);
    assert.equal(noteLengthBeats('nope', true), 2 / 3);
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

test('freqToTicks converts an LFO frequency to metronome beats', () => {
    // 0.5 Hz → 2 s per cycle → 4 beats at 120 BPM
    assert.equal(freqToTicks(0.5, 120), 4);
    // 1 Hz → 1 s → 1 beat at 60 BPM
    assert.equal(freqToTicks(1, 60), 1);
    // 2 Hz → 0.5 s → 0.5 beat at 60 BPM
    assert.equal(freqToTicks(2, 60), 0.5);
});

test('ticksToFreq is the inverse of freqToTicks', () => {
    for (const [freq, bpm] of [[0.5, 120], [2.5, 90], [0.05, 300]]) {
        assert.ok(Math.abs(ticksToFreq(freqToTicks(freq, bpm), bpm) - freq) < 1e-9);
    }
    assert.equal(ticksToFreq(4, 120), 0.5);
});

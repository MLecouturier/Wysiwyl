// Unit tests for the elapsed-play timer (src/js/chrono.js). Only the pure
// formatter is testable without a DOM; createChrono is exercised through
// a minimal fake display and an injected clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatChronoTime, createChrono } from '../src/js/core/timing.js';

test('formatChronoTime renders mm:ss below an hour', () => {
    assert.equal(formatChronoTime(0), '00:00');
    assert.equal(formatChronoTime(65_000), '01:05');
    assert.equal(formatChronoTime(59 * 60_000 + 59_000), '59:59');
});

test('formatChronoTime switches to h:mm:ss past an hour', () => {
    assert.equal(formatChronoTime(3_600_000), '1:00:00');
    assert.equal(formatChronoTime(3_661_000), '1:01:01');
    assert.equal(formatChronoTime(2 * 3_600_000 + 5 * 60_000), '2:05:00');
});

test('createChrono accumulates only while playing', () => {
    const display = { textContent: '' };
    let playing = false;
    let clock = 1_000;
    const chrono = createChrono({
        display, isPlaying: () => playing, now: () => clock,
        raf: () => 1, caf: () => {},
    });

    assert.equal(display.textContent, '00:00'); // rendered at creation

    // Not playing: sync is a no-op, nothing accumulates
    chrono.sync();
    clock = 6_000;
    assert.equal(chrono.totalMs(), 0);

    // Playing: the elapsed time grows from the stamp
    playing = true;
    chrono.sync(); // stamps runningSince = 6000
    clock = 13_000;
    assert.equal(chrono.totalMs(), 7_000);

    // Stopped: the accumulated time freezes
    playing = false;
    chrono.sync();
    clock = 30_000;
    assert.equal(chrono.totalMs(), 7_000);
    assert.equal(display.textContent, '00:07');
});

test('createChrono reset zeroes the accumulated time', () => {
    const display = { textContent: '' };
    let playing = true;
    let clock = 0;
    const chrono = createChrono({
        display, isPlaying: () => playing, now: () => clock,
        raf: () => 1, caf: () => {},
    });

    chrono.sync();
    clock = 4_000;
    chrono.reset();
    assert.equal(chrono.totalMs(), 0);
    assert.equal(display.textContent, '00:00');
});

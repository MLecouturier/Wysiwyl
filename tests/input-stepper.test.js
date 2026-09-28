// Unit tests for the wheel notch-vs-trackpad classifier
// (src/js/input-stepper.js). The DOM-installed stepper is not exercised
// here; the classifier and the threshold accessors are.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isWheelNotch, setTrackpadThreshold, getTrackpadThreshold, refreshWheelClock,
} from '../src/js/audio/stepper.js';

// Minimal WheelEvent stub: deltaMode 0 = pixel, 1 = line, 2 = page.
globalThis.WheelEvent ??= { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 };
const wheelEvent = (timeStamp, deltaMode = 0) => ({ timeStamp, deltaMode });

test('trackpad threshold ignores invalid values', () => {
    setTrackpadThreshold(250);
    assert.equal(getTrackpadThreshold(), 250);
    setTrackpadThreshold(0); // below 1: ignored
    assert.equal(getTrackpadThreshold(), 250);
    setTrackpadThreshold('abc'); // not a number: ignored
    assert.equal(getTrackpadThreshold(), 250);
});

test('an isolated large pixel delta is a mouse notch', () => {
    refreshWheelClock(wheelEvent(1_000));
    assert.equal(isWheelNotch(wheelEvent(2_000), 100), true);
});

test('a small delta is a trackpad scroll, not a notch', () => {
    refreshWheelClock(wheelEvent(1_000));
    assert.equal(isWheelNotch(wheelEvent(1_010), 3), false);
});

test('line/page delta modes are always notches', () => {
    refreshWheelClock(wheelEvent(1_000));
    assert.equal(isWheelNotch(wheelEvent(1_001, 1), 1), true);
    refreshWheelClock(wheelEvent(1_000));
    assert.equal(isWheelNotch(wheelEvent(1_001, 2), 1), true);
});

test('a run of large deltas keeps classifying as notches', () => {
    refreshWheelClock(wheelEvent(1_000));
    assert.equal(isWheelNotch(wheelEvent(1_001), 50), true); // starts the run
    assert.equal(isWheelNotch(wheelEvent(1_010), 50), true); // continues it
    assert.equal(isWheelNotch(wheelEvent(1_020), 3), false); // small delta ends it
});

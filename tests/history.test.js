// Unit tests for the pure undo/redo stack (src/js/synth/history.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryStack } from '../src/js/synth/history.js';

test('capture/undo/redo walk the states', () => {
    const h = createHistoryStack(10);
    h.reset('a');
    h.capture('b');
    h.capture('c');
    assert.equal(h.current(), 'c');
    assert.equal(h.canUndo(), true);
    assert.equal(h.canRedo(), false);
    assert.equal(h.undo(), 'b');
    assert.equal(h.undo(), 'a');
    assert.equal(h.undo(), null); // nothing before the baseline
    assert.equal(h.canUndo(), false);
    assert.equal(h.redo(), 'b');
    assert.equal(h.redo(), 'c');
    assert.equal(h.redo(), null);
});

test('a new capture after an undo drops the redo branch', () => {
    const h = createHistoryStack(10);
    h.reset('a');
    h.capture('b');
    h.capture('c');
    h.undo(); // back to 'b'
    h.capture('d');
    assert.equal(h.current(), 'd');
    assert.equal(h.canRedo(), false);
    assert.equal(h.undo(), 'b');
});

test('capture with an equality check skips no-op steps', () => {
    const h = createHistoryStack(10);
    const eq = (x, y) => x === y;
    h.reset('a');
    h.capture('a', eq); // identical to the current state: ignored
    assert.equal(h.depth(), 1);
    assert.equal(h.canUndo(), false);
    h.capture('b', eq);
    assert.equal(h.depth(), 2);
});

test('the stack is capped to its limit (oldest steps dropped)', () => {
    const h = createHistoryStack(3);
    h.reset(0);
    for (let i = 1; i <= 5; i++) h.capture(i);
    assert.equal(h.depth(), 3);
    assert.equal(h.current(), 5);
    assert.equal(h.undo(), 4);
    assert.equal(h.undo(), 3);
    assert.equal(h.undo(), null);
});

test('capturing on an empty stack initializes it (no undo available)', () => {
    const h = createHistoryStack(3);
    h.capture('a');
    assert.equal(h.current(), 'a');
    assert.equal(h.canUndo(), false);
});

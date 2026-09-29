// Unit tests for the focus predicates (src/js/core/focus.js). They operate
// on duck-typed elements, so no DOM is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTextEntry, enterConsumed, spaceConsumed, digitConsumed } from '../src/js/core/focus.js';

const mk = (tagName, props = {}) => ({ tagName, ...props });

test('isTextEntry: text-like inputs and selects/textarea consume typing', () => {
    assert.equal(isTextEntry(mk('INPUT', { type: 'text' })), true);
    assert.equal(isTextEntry(mk('INPUT', { type: 'number' })), true);
    assert.equal(isTextEntry(mk('INPUT')), true); // type defaults to text
    assert.equal(isTextEntry(mk('TEXTAREA')), true);
    assert.equal(isTextEntry(mk('SELECT')), true);
    assert.equal(isTextEntry(mk('DIV', { isContentEditable: true })), true);
});

test('isTextEntry: sliders, checkboxes and buttons do not consume typing', () => {
    assert.equal(isTextEntry(mk('INPUT', { type: 'range' })), false);
    assert.equal(isTextEntry(mk('INPUT', { type: 'checkbox' })), false);
    assert.equal(isTextEntry(mk('INPUT', { type: 'radio' })), false);
    assert.equal(isTextEntry(mk('BUTTON')), false);
    assert.equal(isTextEntry(null), false);
});

test('enterConsumed: form widgets keep Enter for themselves', () => {
    assert.equal(enterConsumed(mk('INPUT', { type: 'range' })), true);
    assert.equal(enterConsumed(mk('BUTTON')), true);
    assert.equal(enterConsumed(mk('SELECT')), true);
    assert.equal(enterConsumed(mk('DIV')), false);
    assert.equal(enterConsumed(null), false);
});

test('spaceConsumed: buttons, selects and text inputs keep Space', () => {
    assert.equal(spaceConsumed(mk('BUTTON')), true);
    assert.equal(spaceConsumed(mk('SELECT')), true);
    assert.equal(spaceConsumed(mk('INPUT', { type: 'text' })), true);
    assert.equal(spaceConsumed(mk('TEXTAREA')), true);
});

test('spaceConsumed: range and number inputs let Space through', () => {
    assert.equal(spaceConsumed(mk('INPUT', { type: 'range' })), false);
    assert.equal(spaceConsumed(mk('INPUT', { type: 'number' })), false);
    assert.equal(spaceConsumed(mk('DIV')), false);
    assert.equal(spaceConsumed(null), false);
});

test('digitConsumed: typing digits in fields/selects is preserved', () => {
    assert.equal(digitConsumed(mk('INPUT', { type: 'number' })), true);
    assert.equal(digitConsumed(mk('INPUT', { type: 'text' })), true);
    assert.equal(digitConsumed(mk('SELECT')), true);
    assert.equal(digitConsumed(mk('TEXTAREA')), true);
    // A focused slider still accepts the global digit shortcuts.
    assert.equal(digitConsumed(mk('INPUT', { type: 'range' })), false);
    assert.equal(digitConsumed(mk('BUTTON')), false);
    assert.equal(digitConsumed(null), false);
});

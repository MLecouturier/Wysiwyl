// Unit tests for the keyboard shortcut registry (src/js/core/shortcuts.js).
// The registry is DOM-free by design: events are plain objects and the
// module only installs its listener when `window` exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createShortcutRegistry, comboMatches, digitIndex, SCOPE } from '../src/js/core/shortcuts.js';

function event(overrides = {}) {
    return {
        key: '', code: '', ctrlKey: false, metaKey: false,
        altKey: false, shiftKey: false, repeat: false,
        prevented: false,
        preventDefault() { this.prevented = true; },
        ...overrides,
    };
}

test('comboMatches: primary means Ctrl or Cmd', () => {
    const binding = { key: 's', primary: true };
    assert.equal(comboMatches(binding, event({ key: 's', metaKey: true })), true);
    assert.equal(comboMatches(binding, event({ key: 's', ctrlKey: true })), true);
    assert.equal(comboMatches(binding, event({ key: 's' })), false);
});

test('comboMatches: primary=false rejects both modifiers', () => {
    const binding = { key: ' ', primary: false };
    assert.equal(comboMatches(binding, event({ key: ' ' })), true);
    assert.equal(comboMatches(binding, event({ key: ' ', metaKey: true })), false);
    assert.equal(comboMatches(binding, event({ key: ' ', ctrlKey: true })), false);
});

test('comboMatches: alt/shift are exact when specified', () => {
    const mute = { code: /^Digit[1-8]$/, alt: true, primary: false };
    assert.equal(comboMatches(mute, event({ code: 'Digit2', altKey: true })), true);
    assert.equal(comboMatches(mute, event({ code: 'Digit2' })), false);
    const panic = { key: ' ', shift: true };
    assert.equal(comboMatches(panic, event({ key: ' ', shiftKey: true })), true);
    assert.equal(comboMatches(panic, event({ key: ' ' })), false);
});

test('comboMatches: code regex targets the physical number row', () => {
    const reveal = { code: /^Digit[1-8]$/, primary: false };
    assert.equal(comboMatches(reveal, event({ code: 'Digit1' })), true);
    assert.equal(comboMatches(reveal, event({ code: 'Digit8' })), true);
    assert.equal(comboMatches(reveal, event({ code: 'Digit9' })), false);
    assert.equal(comboMatches(reveal, event({ code: 'KeyD' })), false);
});

test('comboMatches: a binding must pin key or code', () => {
    assert.equal(comboMatches({ alt: true }, event({ altKey: true })), false);
});

test('comboMatches: a match predicate replaces key/code but keeps modifiers', () => {
    const binding = { match: e => digitIndex(e) > 0, primary: false, alt: true };
    assert.equal(comboMatches(binding, event({ code: 'Digit3', altKey: true })), true);
    assert.equal(comboMatches(binding, event({ code: 'Digit3' })), false);        // alt required
    assert.equal(comboMatches(binding, event({ code: 'Digit3', altKey: true, metaKey: true })), false);
    assert.equal(comboMatches(binding, event({ code: 'KeyD', altKey: true })), false);
});

test('digitIndex: prefers code, accepts the numpad', () => {
    assert.equal(digitIndex(event({ code: 'Digit4', key: '4' })), 4);
    assert.equal(digitIndex(event({ code: 'Numpad7', key: '7' })), 7);
    assert.equal(digitIndex(event({ code: 'Digit9', key: '9' })), 0);
});

test('digitIndex: falls back to key (Cmd/plain), even when code is absent', () => {
    assert.equal(digitIndex(event({ key: '2' })), 2);
    assert.equal(digitIndex(event({ code: '', key: '8' })), 8);
});

test('digitIndex: falls back to keyCode for layout/Option-rewritten keys', () => {
    // macOS Option+1 reports key "¡" and (in some webviews) no usable code.
    assert.equal(digitIndex(event({ key: '¡', code: '', keyCode: 49 })), 1);
    // AZERTY bare digit: key is "&", keyCode is still 49.
    assert.equal(digitIndex(event({ key: '&', code: '', keyCode: 49 })), 1);
    assert.equal(digitIndex(event({ key: 'Escape', keyCode: 27 })), 0);
});

test('dispatch: first matching binding consumes the key', () => {
    const reg = createShortcutRegistry();
    const ran = [];
    reg.register({ id: 'a', key: 'x', scope: SCOPE.GLOBAL, run: () => ran.push('a') });
    reg.register({ id: 'b', key: 'x', scope: SCOPE.GLOBAL, run: () => ran.push('b') });

    assert.equal(reg.handleEvent(event({ key: 'x' })), true);
    assert.deepEqual(ran, ['a']);
});

test('dispatch: repeat is ignored unless the binding opts in', () => {
    const reg = createShortcutRegistry();
    let count = 0;
    reg.register({ id: 'once', key: ' ', scope: SCOPE.GLOBAL, run: () => { count += 1; } });
    reg.handleEvent(event({ key: ' ' }));
    reg.handleEvent(event({ key: ' ', repeat: true }));
    assert.equal(count, 1);

    let repeats = 0;
    reg.register({ id: 'hold', key: 'ArrowUp', scope: SCOPE.GLOBAL, repeat: true, run: () => { repeats += 1; } });
    reg.handleEvent(event({ key: 'ArrowUp', repeat: true }));
    assert.equal(repeats, 1);
});

test('dispatch: a modal scope blocks every lower scope', () => {
    const reg = createShortcutRegistry();
    const ran = [];
    reg.register({ id: 'save', key: 's', primary: true, scope: SCOPE.GLOBAL, run: () => ran.push('save') });
    reg.register({ id: 'close', key: 'Escape', scope: SCOPE.MODAL, run: () => ran.push('close') });

    assert.equal(reg.handleEvent(event({ key: 's', metaKey: true })), true);
    assert.deepEqual(ran, ['save']);

    reg.activateScope(SCOPE.MODAL);
    assert.equal(reg.handleEvent(event({ key: 's', metaKey: true })), false); // blocked
    assert.equal(reg.handleEvent(event({ key: 'Escape' })), true);
    assert.deepEqual(ran, ['save', 'close']);

    reg.deactivateScope(SCOPE.MODAL);
    assert.equal(reg.handleEvent(event({ key: 's', metaKey: true })), true);
    assert.deepEqual(ran, ['save', 'close', 'save']);
});

test('dispatch: higher scope falls through to global when its when() is false', () => {
    const reg = createShortcutRegistry();
    const ran = [];
    reg.activateScope(SCOPE.MODE);
    reg.register({ id: 'mode-only', key: 'ArrowUp', scope: SCOPE.MODE, when: () => false, run: () => ran.push('mode') });
    reg.register({ id: 'global-up', key: 'ArrowUp', scope: SCOPE.GLOBAL, run: () => ran.push('global') });

    assert.equal(reg.handleEvent(event({ key: 'ArrowUp' })), true);
    assert.deepEqual(ran, ['global']);
});

test('dispatch: preventDefault can be opted out', () => {
    const reg = createShortcutRegistry();
    reg.register({ id: 'quiet', key: 'q', scope: SCOPE.GLOBAL, preventDefault: false, run: () => {} });
    const e = event({ key: 'q' });
    reg.handleEvent(e);
    assert.equal(e.prevented, false);

    reg.register({ id: 'loud', key: 'w', scope: SCOPE.GLOBAL, run: () => {} });
    const e2 = event({ key: 'w' });
    reg.handleEvent(e2);
    assert.equal(e2.prevented, true);
});

test('escape chain: cancels the highest-priority active target only', () => {
    const reg = createShortcutRegistry();
    const ran = [];
    reg.registerEscape(10, () => true, () => ran.push('help'));
    reg.registerEscape(50, () => false, () => ran.push('picker'));
    reg.registerEscape(30, () => true, () => ran.push('picking'));

    assert.equal(reg.runEscapeChain(), true);
    assert.deepEqual(ran, ['picking']); // 50 inactive, 30 beats 10
});

test('escape chain: reports false when nothing is active', () => {
    const reg = createShortcutRegistry();
    reg.registerEscape(10, () => false, () => {});
    assert.equal(reg.runEscapeChain(), false);
});

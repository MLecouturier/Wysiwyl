// Unit tests for the shortcuts dialog helpers (src/js/core/shortcuts-dialog.js):
// the per-platform modifier labels and the macOS detection. The module only
// touches the DOM when `document` exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modifierLabel, isMacPlatform } from '../src/js/core/shortcuts-dialog.js';

const fakeT = key => ({
    'shortcuts.keyCtrl': 'Ctrl',
    'shortcuts.keyAlt': 'Alt',
    'shortcuts.keyShift': 'Maj',
})[key] ?? key;

test('macOS: modifier symbols, never translated', () => {
    assert.equal(modifierLabel('primary', { mac: true, translate: fakeT }), '⌘');
    assert.equal(modifierLabel('alt', { mac: true, translate: fakeT }), '⌥');
    assert.equal(modifierLabel('shift', { mac: true, translate: fakeT }), '⇧');
});

test('other platforms: translated key names', () => {
    assert.equal(modifierLabel('primary', { mac: false, translate: fakeT }), 'Ctrl');
    assert.equal(modifierLabel('alt', { mac: false, translate: fakeT }), 'Alt');
    assert.equal(modifierLabel('shift', { mac: false, translate: fakeT }), 'Maj');
});

test('unknown modifier: returned as is', () => {
    assert.equal(modifierLabel('meta', { mac: true }), 'meta');
    assert.equal(modifierLabel('meta', { mac: false }), 'meta');
});

test('macOS detection from the user agent', () => {
    assert.equal(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'), true);
    assert.equal(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'), false);
    assert.equal(isMacPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'), false);
});

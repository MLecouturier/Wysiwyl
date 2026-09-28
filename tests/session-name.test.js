// Unit tests for the session file naming (src/js/session-name.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionNameFromPath } from '../src/js/session/session.js';

test('sessionNameFromPath strips the .wysiwyl extension', () => {
    assert.equal(sessionNameFromPath('/Users/me/My Song.wysiwyl'), 'My Song');
});

test('sessionNameFromPath strips the legacy .soundmap extension', () => {
    assert.equal(sessionNameFromPath('/Users/me/Old.soundmap'), 'Old');
});

test('sessionNameFromPath handles Windows separators', () => {
    assert.equal(sessionNameFromPath('C:\\Music\\Set 01.wysiwyl'), 'Set 01');
});

test('sessionNameFromPath keeps a name without a known extension', () => {
    assert.equal(sessionNameFromPath('/tmp/plain'), 'plain');
});

test('sessionNameFromPath is case-insensitive on the extension', () => {
    assert.equal(sessionNameFromPath('/tmp/Show.WYSIWYL'), 'Show');
});

test('sessionNameFromPath falls back to the base when the extension is the whole name', () => {
    // ".wysiwyl" alone: stripping would leave an empty string, so the base wins
    assert.equal(sessionNameFromPath('/tmp/.wysiwyl'), '.wysiwyl');
});

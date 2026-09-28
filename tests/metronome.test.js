// Unit tests for the metronome domain (src/js/metronome.js). Only the
// pure BPM clamp is testable without the DOM/Tauri; createMetronome is
// DOM- and IPC-bound and covered by manual testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampBpm } from '../src/js/audio/metronome.js';

test('clampBpm bounds the tempo to 20–300', () => {
    assert.equal(clampBpm(0), 20);
    assert.equal(clampBpm(19), 20);
    assert.equal(clampBpm(120), 120);
    assert.equal(clampBpm(300), 300);
    assert.equal(clampBpm(999), 300);
});

test('clampBpm passes through fractional values', () => {
    assert.equal(clampBpm(120.5), 120.5);
});

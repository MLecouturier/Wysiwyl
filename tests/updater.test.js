// Unit tests for the auto-update helpers (src/js/core/updater.js): the
// download percentage and the byte-size formatting. The module only reaches
// `window.__TAURI__` and the DOM inside initUpdater(), so the pure helpers
// import cleanly under Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { downloadPercent, formatBytes } from '../src/js/core/updater.js';

test('downloadPercent: proportion of the total, clamped to 0-100', () => {
    assert.equal(downloadPercent(0, 200), 0);
    assert.equal(downloadPercent(50, 200), 25);
    assert.equal(downloadPercent(199, 200), 99);
    assert.equal(downloadPercent(200, 200), 100);
});

test('downloadPercent: over-download never exceeds 100', () => {
    assert.equal(downloadPercent(500, 200), 100);
});

test('downloadPercent: null while the total is unknown or zero', () => {
    assert.equal(downloadPercent(0, 0), null);
    assert.equal(downloadPercent(10, 0), null);
    assert.equal(downloadPercent(10, undefined), null);
    assert.equal(downloadPercent(10, null), null);
});

test('formatBytes: binary units, one decimal under 10', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(10 * 1024), '10 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
});

test('formatBytes: invalid input yields an empty string', () => {
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes(NaN), '');
    assert.equal(formatBytes(Infinity), '');
});

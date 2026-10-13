// Unit tests for the metronome domain (src/js/audio/metronome.js). Only
// the pure helpers are testable without the DOM/Tauri; createMetronome is
// DOM- and IPC-bound and covered by manual testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampBpm } from '../src/js/audio/metronome.js';
import { parseTempoRatio, tempoRatioOption, TEMPO_RATIOS } from '../src/js/core/utils.js';

test('clampBpm bounds the tempo to 20–300', () => {
    assert.equal(clampBpm(0), 20);
    assert.equal(clampBpm(19), 20);
    assert.equal(clampBpm(120), 120);
    assert.equal(clampBpm(300), 300);
    assert.equal(clampBpm(999), 300);
});

test('clampBpm rounds to a whole BPM (the backend takes an integer)', () => {
    // A fractional BPM would fail the u32 deserialization of
    // set_metronome_bpm / save_session
    assert.equal(clampBpm(120.5), 121);
    assert.equal(clampBpm(120.4), 120);
    assert.ok(Number.isInteger(clampBpm(87.25)));
});

test('clampBpm falls back on non-numeric input', () => {
    assert.equal(clampBpm('abc'), 120);
    assert.equal(clampBpm(undefined, 90), 90);
    assert.equal(clampBpm('140'), 140);
});

test('tempo ratio options parse to their exact fraction', () => {
    assert.equal(parseTempoRatio('2/3'), 2 / 3);
    assert.equal(parseTempoRatio('4/3'), 4 / 3);
    assert.equal(parseTempoRatio('1'), 1);
    // Legacy decimal values still parse
    assert.equal(parseTempoRatio('0.66'), 0.66);
    // Garbage falls back to the metronome tempo
    assert.equal(parseTempoRatio(''), 1);
    assert.equal(parseTempoRatio('0'), 1);
});

test('the backend ratio selects the nearest option, legacy decimals included', () => {
    assert.equal(tempoRatioOption(2 / 3), '2/3');
    assert.equal(tempoRatioOption(0.66), '2/3');
    assert.equal(tempoRatioOption(1.33), '4/3');
    assert.equal(tempoRatioOption(1), '1');
    assert.equal(tempoRatioOption(0.5), '1/2');
    // Every offered option round-trips
    for (const [label, value] of TEMPO_RATIOS) {
        assert.equal(tempoRatioOption(parseTempoRatio(label)), label);
        assert.equal(parseTempoRatio(label), value);
    }
});

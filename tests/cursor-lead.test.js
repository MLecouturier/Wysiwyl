// Unit tests for the cursor-lead bound (src/js/synth/cursor-lead.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boundedLead } from '../src/js/synth/cursor-lead.js';

test('boundedLead keeps the configured lead below 90% of the step', () => {
    // A 40 ms lead on a 500 ms step is well inside the bound
    assert.equal(boundedLead(40, 500), 40);
});

test('boundedLead caps the lead at 90% of the step', () => {
    // A 40 ms lead on a 20 ms step would reach into the next pixel: capped
    assert.equal(boundedLead(40, 20), 18);
});

test('boundedLead falls back to zero without a usable step', () => {
    assert.equal(boundedLead(40, 0), 0);
    assert.equal(boundedLead(40, -5), 0);
    assert.equal(boundedLead(40, NaN), 0);
});

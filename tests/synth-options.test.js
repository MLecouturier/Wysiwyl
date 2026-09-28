// Unit tests for the configurable synth options (src/js/synth-options.js).
// The DOM-writing helpers (refreshScaleSelects, applyNoteRangeTitles) are
// out of scope; the stores and the option markup are tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SCALE_OPTIONS, getSynthColors, setSynthColors,
    getNoteRangeBounds, setNoteRangeBounds,
    setEnabledScales, getEnabledScales, scaleOptionsHtml,
} from '../src/js/synth/model.js';

test('the default palette has twelve colors', () => {
    assert.equal(getSynthColors().length, 12);
});

test('setSynthColors replaces the palette', () => {
    const original = getSynthColors();
    setSynthColors(['#123456']);
    assert.deepEqual(getSynthColors(), ['#123456']);
    setSynthColors(original); // restore for the other tests
});

test('the default note-range bounds are the three filters', () => {
    assert.deepEqual(getNoteRangeBounds(), [[21, 47], [48, 71], [72, 108]]);
});

test('setNoteRangeBounds replaces the bounds', () => {
    const original = getNoteRangeBounds();
    setNoteRangeBounds([[0, 10], [11, 20], [21, 127]]);
    assert.deepEqual(getNoteRangeBounds(), [[0, 10], [11, 20], [21, 127]]);
    setNoteRangeBounds(original);
});

test('setEnabledScales drops unknown values and always keeps chromatic', () => {
    setEnabledScales(['major', 'major', 'bogus']);
    const enabled = getEnabledScales();
    assert.equal(enabled.has('chromatic'), true);
    assert.equal(enabled.has('major'), true);
    assert.equal(enabled.has('bogus'), false);
    assert.equal(enabled.size, 2);
});

test('scaleOptionsHtml only lists the enabled scales', () => {
    setEnabledScales(['major']);
    const html = scaleOptionsHtml(null);
    assert.match(html, /value="chromatic"/);
    assert.match(html, /value="major"/);
    assert.doesNotMatch(html, /value="dorian"/);
});

test('scaleOptionsHtml adds a ghost option for a disabled active scale', () => {
    setEnabledScales(['major']);
    const html = scaleOptionsHtml('dorian');
    assert.match(html, /value="dorian"/);
});

test('SCALE_OPTIONS covers every backend scale', () => {
    assert.equal(SCALE_OPTIONS[0].value, 'chromatic');
    assert.equal(SCALE_OPTIONS.length, 14);
});

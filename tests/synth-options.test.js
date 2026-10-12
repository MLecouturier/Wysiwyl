// Unit tests for the configurable synth options (src/js/synth-options.js).
// The DOM-writing helpers (refreshScaleSelects, applyNoteRangeTitles) are
// out of scope; the stores and the option markup are tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SCALE_OPTIONS, SCALE_INTERVALS, getSynthColors, setSynthColors,
    getNoteRangeBounds, setNoteRangeBounds,
    setEnabledScales, getEnabledScales, scaleOptionsHtml,
    mergedNoteRanges, countScaleNotes,
    pixelHue, rescaleIntoRange, allowedPitches, snapToAllowed, effectiveNoteForPixel,
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

test('SCALE_INTERVALS mirrors every scale of SCALE_OPTIONS', () => {
    for (const { value } of SCALE_OPTIONS) {
        assert.ok(Array.isArray(SCALE_INTERVALS[value]), `missing intervals for ${value}`);
        assert.equal(SCALE_INTERVALS[value][0], 0); // every scale contains its tonic
    }
    assert.equal(SCALE_INTERVALS.chromatic.length, 12);
    assert.deepEqual(SCALE_INTERVALS.major, [0, 2, 4, 5, 7, 9, 11]);
});

test('mergedNoteRanges returns nothing when no filter is enabled', () => {
    assert.deepEqual(mergedNoteRanges([[21, 47], [48, 71], [72, 108]], [false, false, false]), []);
});

test('mergedNoteRanges keeps a single enabled filter', () => {
    assert.deepEqual(mergedNoteRanges([[21, 47], [48, 71], [72, 108]], [true, false, false]), [[21, 47]]);
});

test('mergedNoteRanges fuses adjacent filters', () => {
    assert.deepEqual(mergedNoteRanges([[21, 47], [48, 71], [72, 108]], [true, true, false]), [[21, 71]]);
});

test('mergedNoteRanges keeps disjoint filters apart, in ascending order', () => {
    assert.deepEqual(
        mergedNoteRanges([[21, 47], [48, 71], [72, 108]], [true, false, true]),
        [[21, 47], [72, 108]],
    );
});

test('mergedNoteRanges merges every filter into one range', () => {
    assert.deepEqual(mergedNoteRanges([[21, 47], [48, 71], [72, 108]], [true, true, true]), [[21, 108]]);
});

test('mergedNoteRanges never mutates the bounds it is given', () => {
    const bounds = [[21, 47], [48, 71], [72, 108]];
    mergedNoteRanges(bounds, [true, true, true]);
    assert.deepEqual(bounds, [[21, 47], [48, 71], [72, 108]]);
});

test('countScaleNotes counts every pitch on the chromatic scale', () => {
    assert.equal(countScaleNotes([[60, 71]], 'chromatic', 0), 12);
    assert.equal(countScaleNotes([[21, 47]], 'chromatic', 0), 27);
});

test('countScaleNotes follows the chosen scale', () => {
    assert.equal(countScaleNotes([[60, 71]], 'major', 0), 7);
    assert.equal(countScaleNotes([[60, 71]], 'majorPentatonic', 0), 5);
});

test('countScaleNotes sums across disjoint ranges', () => {
    assert.equal(
        countScaleNotes([[60, 71], [72, 83]], 'major', 0),
        countScaleNotes([[60, 83]], 'major', 0),
    );
});

test('countScaleNotes follows the tonic', () => {
    assert.equal(countScaleNotes([[60, 60]], 'major', 0), 1); // C in C major
    assert.equal(countScaleNotes([[61, 61]], 'major', 0), 0); // C# not in C major
    assert.equal(countScaleNotes([[61, 61]], 'major', 1), 1); // C# is the tonic of C# major
});

const BOUNDS = [[21, 47], [48, 71], [72, 108]];

test('pixelHue returns the HSL hue of primary colors', () => {
    assert.equal(pixelHue(255, 0, 0), 0);     // red
    assert.equal(pixelHue(0, 255, 0), 120);   // green
    assert.equal(pixelHue(0, 0, 255), 240);   // blue
});

test('pixelHue returns 0 for achromatic pixels', () => {
    assert.equal(pixelHue(128, 128, 128), 0);
    assert.equal(pixelHue(0, 0, 0), 0);
});

test('rescaleIntoRange uses the full 0-127 range when nothing is enabled', () => {
    assert.equal(rescaleIntoRange(0, BOUNDS, [false, false, false]), 0);
    assert.equal(rescaleIntoRange(0.5, BOUNDS, [false, false, false]), 64);
    assert.equal(rescaleIntoRange(1, BOUNDS, [false, false, false]), 127);
});

test('rescaleIntoRange sweeps across a single enabled range', () => {
    assert.equal(rescaleIntoRange(0, BOUNDS, [true, false, false]), 21);
    assert.equal(rescaleIntoRange(0.5, BOUNDS, [true, false, false]), 34);
    assert.equal(rescaleIntoRange(1, BOUNDS, [true, false, false]), 47);
});

test('rescaleIntoRange skips the gaps between disjoint ranges', () => {
    // bass + treble: 27 + 37 = 64 notes, the medium gap is skipped
    assert.equal(rescaleIntoRange(0, BOUNDS, [true, false, true]), 21);
    assert.equal(rescaleIntoRange(0.5, BOUNDS, [true, false, true]), 77);
    assert.equal(rescaleIntoRange(1, BOUNDS, [true, false, true]), 108);
});

test('allowedPitches keeps only the scale degrees within the ranges', () => {
    const allowed = allowedPitches('major', 0, BOUNDS, [true, false, false]);
    assert.equal(allowed[0], 21);          // A (21) is the 6th degree of C major
    assert.equal(allowed[allowed.length - 1], 47);
    assert.equal(allowed.length, 16);
});

test('snapToAllowed rounds to the nearest allowed pitch, ties to the lower', () => {
    assert.deepEqual(snapToAllowed(60, [60, 62, 64]), 60);
    assert.equal(snapToAllowed(61, [60, 62, 64]), 60); // tie -> lower
    assert.equal(snapToAllowed(63, [60, 62, 64]), 62); // tie -> lower
    assert.equal(snapToAllowed(65, [60, 62, 64]), 64); // above the top
    assert.equal(snapToAllowed(59, [60, 62, 64]), 60); // below the bottom
});

test('snapToAllowed returns the note unchanged when nothing is allowed', () => {
    assert.equal(snapToAllowed(61, []), 61);
});

test('effectiveNoteForPixel rescales then snaps for a scale', () => {
    // chromatic: pure rescale
    assert.equal(effectiveNoteForPixel(0, 'chromatic', 0, BOUNDS, [true, false, false]), 21);
    assert.equal(effectiveNoteForPixel(1, 'chromatic', 0, BOUNDS, [true, false, false]), 47);
    // major from C: 21 (A) is a degree, kept as-is; 47 (B) is one too
    assert.equal(effectiveNoteForPixel(0, 'major', 0, BOUNDS, [true, false, false]), 21);
    assert.equal(effectiveNoteForPixel(1, 'major', 0, BOUNDS, [true, false, false]), 47);
    // major from C#, 21 (A) is not a degree: snaps up to the nearest (22, A#)
    assert.equal(effectiveNoteForPixel(0, 'major', 1, BOUNDS, [true, false, false]), 22);
});

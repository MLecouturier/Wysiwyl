// Unit tests for the MIDI note naming helpers (src/js/midi-note.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOTE_NAMES, midiNoteName, midiNoteToName, midiNoteNameHtml, midiNoteToNameHtml } from '../src/js/core/utils.js';

test('NOTE_NAMES lists the twelve pitch classes', () => {
    assert.equal(NOTE_NAMES.length, 12);
    assert.equal(NOTE_NAMES[0], 'C');
});

test('midiNoteName uses scientific pitch notation', () => {
    assert.equal(midiNoteName(60), 'C4'); // middle C
    assert.equal(midiNoteName(69), 'A4'); // A440
    assert.equal(midiNoteName(0), 'C-1'); // lowest MIDI note
    assert.equal(midiNoteName(127), 'G9'); // highest MIDI note
});

test('midiNoteToName appends the raw value', () => {
    assert.equal(midiNoteToName(60), 'C4 (60)');
    assert.equal(midiNoteToName(0), 'C-1 (0)');
});

test('midiNoteToName returns a dash for an unknown note', () => {
    assert.equal(midiNoteToName(null), '-');
    assert.equal(midiNoteToName(undefined), '-');
});

test('midiNoteNameHtml wraps the octave in a half-size span', () => {
    assert.equal(midiNoteNameHtml(60), 'C<span class="note-index">4</span>');
    assert.equal(midiNoteNameHtml(0), 'C<span class="note-index">-1</span>');
    assert.equal(midiNoteNameHtml(61), 'C#<span class="note-index">4</span>');
});

test('midiNoteNameHtml returns a dash for an unknown note', () => {
    assert.equal(midiNoteNameHtml(null), '-');
    assert.equal(midiNoteNameHtml(undefined), '-');
});

test('midiNoteToNameHtml appends the raw value to the HTML name', () => {
    assert.equal(midiNoteToNameHtml(60), 'C<span class="note-index">4</span> (60)');
    assert.equal(midiNoteToNameHtml(null), '-');
});

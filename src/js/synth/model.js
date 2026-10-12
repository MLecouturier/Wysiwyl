// Synth model/UI: the configurable options, the card DOM lookups, the
// display helpers, the MIDI program UI and the selection labels.

import { clampBpm, currentBpm } from '../audio/metronome.js';
import { zonesPixelCount } from '../core/geometry.js';
import { applyTranslations, getLocale, t } from '../core/i18n.js';
import { createStore, synthDisplayNumbers, synthHighlights, synthNames, viewer } from '../core/state.js';
import { noteLengthBeats, formatDurationClock, zonesTotalBeats } from '../core/timing.js';
import { midiNoteName, midiNoteNameHtml } from '../core/utils.js';

// Configurable synth options: the color palette, the note-range bounds
// and the enabled scales, all replaceable at startup from config.json
// (hand-edited via the gear button). Owned here as stores so the rest of
// the app reads them through getters instead of mutable globals.

// Scales offered for note quantization: values match the backend's Scale
// enum (serde camelCase). Chromatic = no quantization (default).
export const SCALE_OPTIONS = [
    { value: 'chromatic',        key: 'synth.scaleChromatic' },
    { value: 'major',            key: 'synth.scaleMajor' },
    { value: 'naturalMinor',     key: 'synth.scaleNaturalMinor' },
    { value: 'harmonicMinor',    key: 'synth.scaleHarmonicMinor' },
    { value: 'melodicMinor',     key: 'synth.scaleMelodicMinor' },
    { value: 'majorPentatonic',  key: 'synth.scaleMajorPentatonic' },
    { value: 'minorPentatonic',  key: 'synth.scaleMinorPentatonic' },
    { value: 'blues',            key: 'synth.scaleBlues' },
    { value: 'dorian',           key: 'synth.scaleDorian' },
    { value: 'phrygian',         key: 'synth.scalePhrygian' },
    { value: 'lydian',           key: 'synth.scaleLydian' },
    { value: 'mixolydian',       key: 'synth.scaleMixolydian' },
    { value: 'locrian',          key: 'synth.scaleLocrian' },
    { value: 'wholeTone',        key: 'synth.scaleWholeTone' },
];

// Semitone offsets from the tonic, within one octave, of each scale.
// Mirrors the backend's scale_intervals (src-tauri/src/metronome.rs) and
// is keyed by the same values as SCALE_OPTIONS — the two must stay in
// sync or the note-range summary would count pitches the backend never
// plays.
export const SCALE_INTERVALS = {
    chromatic:       [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major:           [0, 2, 4, 5, 7, 9, 11],
    naturalMinor:    [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor:   [0, 2, 3, 5, 7, 8, 11],
    melodicMinor:    [0, 2, 3, 5, 7, 9, 11],
    majorPentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10],
    blues:           [0, 3, 5, 6, 7, 10],
    dorian:          [0, 2, 3, 5, 7, 9, 10],
    phrygian:        [0, 1, 3, 5, 7, 8, 10],
    lydian:          [0, 2, 4, 6, 7, 9, 11],
    mixolydian:      [0, 2, 4, 5, 7, 9, 10],
    locrian:         [0, 1, 3, 5, 6, 8, 10],
    wholeTone:       [0, 2, 4, 6, 8, 10],
};

const DEFAULT_SYNTH_COLORS = [
    '#ff2f2f', '#ff8c00', '#ffc300', '#b6f000',
    '#00e884', '#00d5b8', '#432fff', '#7d2fd4',
    '#b42fd4', '#ea2bd9', '#ff2f92', '#ff2f5d',
];

// Bounds (low, high) of the bass / medium / treble note-range filters,
// in MIDI note numbers.
const DEFAULT_NOTE_RANGE_BOUNDS = [[21, 47], [48, 71], [72, 108]];

const synthColors = createStore(DEFAULT_SYNTH_COLORS);
const noteRangeBounds = createStore(DEFAULT_NOTE_RANGE_BOUNDS);
const enabledScales = createStore(new Set(SCALE_OPTIONS.map(o => o.value)));

export const getSynthColors = () => synthColors.get();
export const setSynthColors = (colors) => synthColors.set(colors);
export const getNoteRangeBounds = () => noteRangeBounds.get();
export const setNoteRangeBounds = (bounds) => noteRangeBounds.set(bounds);
export const getEnabledScales = () => enabledScales.get();

// Replaces the enabled scales from the config: unknown values are dropped
// and Chromatic is always kept (it is the "no quantization" default).
export function setEnabledScales(values) {
    const set = new Set(values.filter(v => SCALE_OPTIONS.some(o => o.value === v)));
    set.add('chromatic');
    enabledScales.set(set);
}

// Options markup for a scale select: the enabled scales, plus a ghost
// option for `activeScale` when it is globally disabled — a synth using
// it keeps its value, the config never corrupts a synth's state.
export function scaleOptionsHtml(activeScale) {
    const enabled = enabledScales.get();
    const shown = SCALE_OPTIONS.filter(o => enabled.has(o.value));
    if (activeScale && !enabled.has(activeScale)) {
        const ghost = SCALE_OPTIONS.find(o => o.value === activeScale);
        if (ghost) shown.push(ghost);
    }
    return shown.map(o => `<option value="${o.value}">${t(o.key)}</option>`).join('');
}

// Rebuilds a synth card's scale selects from the enabled-scales config,
// keeping each select's current value (ghost option included)
export function refreshScaleSelects(el) {
    el.querySelectorAll('.synth-scale').forEach(sel => {
        const current = sel.value || 'chromatic';
        sel.innerHTML = scaleOptionsHtml(current);
        sel.value = current;
    });
}

// Tooltip of the bass / medium / treble buttons, built from the
// configured bounds (the values are user-configurable, they cannot be
// hardcoded in the i18n files)
export function applyNoteRangeTitles(el) {
    const bounds = noteRangeBounds.get();
    [
        ['bass',    'synth.noteRangeBass'],
        ['medium',  'synth.noteRangeMedium'],
        ['treble',  'synth.noteRangeTreble'],
    ].forEach(([kind, key], i) => {
        const [lo, hi] = bounds[i];
        const params = { lowName: midiNoteName(lo), highName: midiNoteName(hi), low: lo, high: hi };
        el.querySelectorAll(`.synth-${kind}`).forEach(btn => { btn.title = t(key, params); });
    });
}

// Note-range summary of a synth card: the pitch bounds its bass/medium/
// treble filters allow, and how many pitches the active scale leaves
// playable within them (see updateNoteRangeInfo). The merge mirrors the
// backend (metronome.rs: active_note_ranges / merged_note_ranges), so the
// summary always matches what will actually play.

// Merges the enabled sub-ranges: keeps the (low, high) bounds whose toggle
// is on, sorts them and fuses the overlapping/adjacent ones. Returns
// clones, so the caller never mutates the config's bounds. An empty result
// means no filter is enabled (the full 0–127 range is used).
export function mergedNoteRanges(bounds, toggles) {
    const allowed = [];
    bounds.forEach(([lo, hi], i) => {
        if (toggles[i]) allowed.push([lo, hi]);
    });
    allowed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const merged = [];
    for (const [lo, hi] of allowed) {
        const last = merged[merged.length - 1];
        if (last && lo <= last[1] + 1) {
            if (hi > last[1]) last[1] = hi;
        } else {
            merged.push([lo, hi]);
        }
    }
    return merged;
}

// Number of pitches playable within the given merged ranges for a scale
// and its tonic: pitches whose pitch class belongs to the scale (mirrors
// the backend's allowed_pitches). Every scale is counted, chromatic
// included (it counts them all).
export function countScaleNotes(ranges, scale, root) {
    const intervals = SCALE_INTERVALS[scale] || SCALE_INTERVALS.chromatic;
    let count = 0;
    for (const [lo, hi] of ranges) {
        for (let note = lo; note <= hi; note++) {
            const rel = (((note - Number(root)) % 12) + 12) % 12;
            if (intervals.includes(rel)) count++;
        }
    }
    return count;
}

// Pixel → note derivation, mirroring the backend (metronome.rs) so the
// front-end can preview the note of any pixel without an IPC round-trip
// (used by the hover note mode). The order of operations is the backend's:
// normalize the color, rescale into the merged note ranges, then snap to
// the nearest allowed pitch of the scale (chromatic skips the snap).

// Perceived hue of an RGB pixel in degrees (0–360), HSL model. Achromatic
// pixels (r = g = b) have no defined hue: 0, like the backend. The gray
// threshold mirrors the backend's f32::EPSILON.
const F32_EPSILON = 1.1920929e-7;
export function pixelHue(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    if (Math.abs(delta) < F32_EPSILON) return 0;

    let hue;
    if (max === rn)      hue = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) hue = 60 * (((bn - rn) / delta) + 2);
    else                 hue = 60 * (((rn - gn) / delta) + 4);
    return hue < 0 ? hue + 360 : hue;
}

// Maps a normalized value (0–1) proportionally across the merged enabled
// note ranges: 0 lands on the low bound of the first range, 1 on the high
// bound of the last, the sweep skipping the gaps between them. With no
// range enabled, the full 0–127 range is used (mirrors rescale_into_range).
export function rescaleIntoRange(normalized, bounds, toggles) {
    const merged = mergedNoteRanges(bounds, toggles);
    const n = Math.min(1, Math.max(0, normalized));
    if (merged.length === 0) return Math.round(n * 127);

    const total = merged.reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);
    let index = Math.round(n * (total - 1));
    for (const [lo, hi] of merged) {
        const span = hi - lo + 1;
        if (index < span) return lo + index;
        index -= span;
    }
    return merged[merged.length - 1][1];
}

// Every pitch (0–127) playable within the merged enabled ranges that also
// belongs to the scale, relative to its tonic. Sorted ascending; empty when
// a range is too narrow to contain any degree (mirrors allowed_pitches).
export function allowedPitches(scale, root, bounds, toggles) {
    const intervals = SCALE_INTERVALS[scale] || SCALE_INTERVALS.chromatic;
    let ranges = mergedNoteRanges(bounds, toggles);
    if (ranges.length === 0) ranges = [[0, 127]];

    const out = [];
    for (const [lo, hi] of ranges) {
        for (let note = lo; note <= hi; note++) {
            const rel = (((note - Number(root)) % 12) + 12) % 12;
            if (intervals.includes(rel)) out.push(note);
        }
    }
    return out;
}

// Snaps a note to the nearest pitch of the allowed set (ties go to the
// lower pitch); a note already in the set is returned unchanged, and an
// empty set returns the note as-is (mirrors snap_to_allowed).
export function snapToAllowed(note, allowed) {
    if (allowed.length === 0) return note;
    let lo = 0, hi = allowed.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (allowed[mid] === note) return note;
        if (allowed[mid] < note) lo = mid + 1;
        else hi = mid - 1;
    }
    // Not found: lo is the insertion point, hi the pitch just below
    const lower = hi >= 0 ? allowed[hi] : null;
    const upper = lo < allowed.length ? allowed[lo] : null;
    if (lower != null && upper != null) return (note - lower <= upper - note) ? lower : upper;
    return lower != null ? lower : upper;
}

// Effective MIDI note of a normalized value (0–1) for a scale and its tonic
// within the enabled ranges: rescale first, then quantize unless chromatic
// (mirrors effective_note_for).
export function effectiveNoteForPixel(normalized, scale, root, bounds, toggles) {
    const note = rescaleIntoRange(normalized, bounds, toggles);
    if (scale === 'chromatic') return note;
    return snapToAllowed(note, allowedPitches(scale, root, bounds, toggles));
}

// Note(s) a synth would play for an arbitrary pixel, read from the live
// card controls (mode, scale/tonic, hue shift, range toggles, channel
// enables). Monophonic returns { mode, note }; polyphonic returns
// { mode, voices: [{ channel, enabled, note }] } — disabled voices are
// reported with `enabled: false` and their note is still computed.
export function synthNoteForPixel(el, r, g, b) {
    const bounds = noteRangeBounds.get();
    const scale = el.querySelector('.synth-scale')?.value || 'chromatic';
    const root = Number(el.querySelector('.synth-scale-root')?.value) || 0;
    const readToggles = group => ['bass', 'medium', 'treble'].map(kind =>
        group.querySelector(`.synth-${kind}`).classList.contains('active')
    );

    const poly = !el.querySelector('.synth-mode-panel-poly').classList.contains('hidden');
    if (!poly) {
        const shift = Number(el.querySelector('.synth-hue-shift')?.value) || 0;
        const shifted = (pixelHue(r, g, b) + shift) % 360;
        const toggles = readToggles(el.querySelector('.synth-mode-panel-mono .synth-note-range'));
        return { mode: 'monophonic', note: effectiveNoteForPixel(shifted / 360, scale, root, bounds, toggles) };
    }

    const groups = el.querySelectorAll('.synth-mode-panel-poly .synth-note-range');
    const channelToggles = el.querySelectorAll('.synth-mode-panel-poly .synth-channel-toggle');
    const values = [r, g, b];
    const channels = ['R', 'G', 'B'];
    const voices = Array.from(groups).map((group, i) => ({
        channel: channels[i],
        enabled: channelToggles[i]?.classList.contains('active') ?? true,
        note: effectiveNoteForPixel(values[i] / 255, scale, root, bounds, readToggles(group)),
    }));
    return { mode: 'polyphonic', voices };
}

// "C₃–B₄" for one (low, high) range, in scientific pitch notation with the
// octaves as half-size indices (see midiNoteNameHtml).
function formatNoteRange(lo, hi) {
    return `${midiNoteNameHtml(lo)}–${midiNoteNameHtml(hi)}`;
}

// Refreshes the note-range summary line of a synth card: the pitch bounds
// its filters allow and the number of pitches the active scale leaves
// playable within them. Monophonic mode shows one range; each R/G/B voice
// of the polyphonic mode shows its own (a disabled voice reports as off).
// The count follows the scale/tonic selects, so the line always reflects
// the settings currently shown on the card.
// Accepts either a synth id or the card element itself: during creation the
// element is not attached yet, so an id lookup would find nothing.
export function updateNoteRangeInfo(idOrEl) {
    const el = idOrEl && typeof idOrEl === 'object' ? idOrEl : synthElementById(idOrEl);
    if (!el) return;
    const infoEl = el.querySelector('.synth-note-range-info');
    if (!infoEl) return;

    const bounds = noteRangeBounds.get();
    const scale = el.querySelector('.synth-scale')?.value || 'chromatic';
    const root = Number(el.querySelector('.synth-scale-root')?.value) || 0;

    const readToggles = group => ['bass', 'medium', 'treble'].map(kind =>
        group.querySelector(`.synth-${kind}`).classList.contains('active')
    );

    // "A0–B2 · 27 notes" for one set of toggles (the full 0–127 range when
    // none is enabled, like the backend). Built as HTML because the octave
    // carries a sized-down <span>; nothing here comes from user input.
    const rangeItem = toggles => {
        let ranges = mergedNoteRanges(bounds, toggles);
        if (ranges.length === 0) ranges = [[0, 127]];
        const rangeStr = ranges.map(([lo, hi]) => formatNoteRange(lo, hi)).join(' / ');
        const count = countScaleNotes(ranges, scale, root);
        return t('synth.noteRangeItem', { range: rangeStr, count });
    };

    const poly = !el.querySelector('.synth-mode-panel-poly').classList.contains('hidden');
    if (!poly) {
        const toggles = readToggles(el.querySelector('.synth-mode-panel-mono .synth-note-range'));
        infoEl.innerHTML = t('synth.noteRangeMono', { item: rangeItem(toggles) });
        return;
    }

    const labels = ['R', 'G', 'B'];
    const groups = el.querySelectorAll('.synth-mode-panel-poly .synth-note-range');
    const toggles = el.querySelectorAll('.synth-mode-panel-poly .synth-channel-toggle');
    const items = Array.from(groups).map((group, i) => {
        const label = labels[i];
        if (!toggles[i]?.classList.contains('active')) {
            return t('synth.noteRangeOff', { channel: label });
        }
        return `${label} ${rangeItem(readToggles(group))}`;
    });
    infoEl.innerHTML = t('synth.noteRangePoly', { items: items.join(' · ') });
}

// Collapse state of the info section at the bottom of each card (the live
// pixel readout + note-range summary). A global display preference kept in
// localStorage like the zones display mode: every card folds together.
const storedInfoCollapsed =
    typeof localStorage !== 'undefined' ? localStorage.getItem('wysiwyl.synthInfoCollapsed') : null;
let synthInfoCollapsed = storedInfoCollapsed === '1';

// Reflects the collapse preference on one card: the body is hidden and the
// caret points down (reveal) when collapsed, up (fold) when expanded.
export function applySynthInfoCollapsed(el) {
    const section = el.querySelector('.synth-info-section');
    if (!section) return;
    section.classList.toggle('collapsed', synthInfoCollapsed);
    const btn = section.querySelector('.synth-info-toggle');
    if (btn) {
        btn.querySelector('.material-symbols-outlined').textContent =
            synthInfoCollapsed ? 'arrow_drop_down' : 'arrow_drop_up';
        btn.setAttribute('aria-expanded', String(!synthInfoCollapsed));
    }
}

export function applyAllSynthInfoCollapsed() {
    document.querySelectorAll('.synth-block').forEach(applySynthInfoCollapsed);
}

// Flips the global preference, persists it and applies it to every card.
export function toggleSynthInfoCollapsed() {
    synthInfoCollapsed = !synthInfoCollapsed;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('wysiwyl.synthInfoCollapsed', synthInfoCollapsed ? '1' : '0');
    }
    applyAllSynthInfoCollapsed();
}

// DOM lookups for synth cards and tabs, shared by the synth modules so
// they do not depend on main.js's cached containers.

export function synthElementById(id) {
    return document.querySelector(`.synth-block[data-synth-id="${id}"]`);
}

export function synthTabById(id) {
    return document.querySelector(`.synth-tab[data-synth-id="${id}"]`);
}

// Synth card display helpers: the title, the play/pause buttons and the
// retranslation of an existing card on locale change.

// Display name of a synth: its custom name, or the translated default
// (built from the stable display number, not the functional id)
export function synthDisplayName(id) {
    return synthNames.get(id) || t('synth.title', { id: synthDisplayNumbers.get(id) ?? id });
}

// Updates a synth's play/stop button: icon, label, and active state stay
// in sync, whatever the trigger (click, locale change, remote event, ...).
export function setPlayButtonState(btn, playing) {
    btn.classList.toggle('active', playing);
    btn.querySelector('.synth-play-icon').textContent = playing ? 'pause' : 'play_arrow';
    btn.querySelector('.synth-play-label').textContent = playing ? t('synth.stop') : t('synth.play');
}

// Updates BOTH play/pause buttons of a synth — the device card's and the
// tab's — so the two columns always show the same state.
export function setSynthPlaying(id, playing) {
    const el = synthElementById(id);
    if (el) setPlayButtonState(el.querySelector('.synth-play'), playing);
    const tab = synthTabById(id);
    if (tab) setPlayButtonState(tab.querySelector('.synth-tab-play'), playing);
}

// Reflects the highlight visibility on a card's eye button.
export function syncEyeButton(el, visible) {
    const btn = el?.querySelector('.synth-eye-btn');
    if (btn) btn.classList.toggle('active', visible);
}

// Re-translates an existing synth card: static parts via data-i18n*, plus
// the few labels whose text depends on dynamic state (play/stop, mode)
// that data-i18n alone can't express.
export function retranslateSynthElement(el) {
    applyTranslations(el);
    applyNoteRangeTitles(el);

    const id = Number(el.dataset.synthId);
    el.querySelector('.synth-title-label').textContent = synthDisplayName(id);

    const playBtn = el.querySelector('.synth-play');
    setPlayButtonState(playBtn, playBtn.classList.contains('active'));

    el.querySelector('.synth-mode-btn[data-mode="monophonic"]').textContent = t('synth.modeMonophonic');
    el.querySelector('.synth-mode-btn[data-mode="polyphonic"]').textContent = t('synth.modePolyphonic');

    // Pixel info: only reset to the empty placeholder if no tick has been
    // received yet (i.e. it still shows the untranslated empty state).
    const pixelInfo = el.querySelector('.synth-pixel-info');
    if (!pixelInfo.dataset.hasTick) {
        pixelInfo.textContent = t('synth.pixelInfoEmpty');
    }

    updateZonesLabel(Number(el.dataset.synthId));

    // The paired tab follows: its tooltip and hidden play label are
    // locale-dependent too
    const tab = el._tab;
    if (tab) {
        applyTranslations(tab);
        tab.title = synthDisplayName(id);
        const tabPlayBtn = tab.querySelector('.synth-tab-play');
        setPlayButtonState(tabPlayBtn, tabPlayBtn.classList.contains('active'));
    }
}

// Synth program (Bank Select + Program Change) UI: the per-channel
// learned-program map, its rendering on the cards, and the command that
// sends a selection to the instrument. Programs are channel state, not
// synth state: every synth on a given (port, channel) displays the same.

// Deferred so importing this module does not touch the Tauri globals.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

// Map "port:channel" → last known program of that MIDI channel, learned
// from the MIDI input (Program Change / Bank Select sent by the
// instruments) or set by the app itself.
export const programMap = new Map();
export const programKey = (port, channel) => `${port}:${channel}`;

// Refreshes the program display of every synth currently on the given
// (port, channel)
export function refreshProgramDisplays(port, channel) {
    const key = programKey(port, channel);
    document.querySelectorAll('.synth-block').forEach(block => {
        const portSelect = block.querySelector('.synth-midi-port');
        const channelSelect = block.querySelector('.synth-channel');
        if (!portSelect || !channelSelect) return;
        if (programKey(Number(portSelect.value), Number(channelSelect.value)) !== key) return;
        updateProgramDisplay(block);
    });
}

// Renders a synth's program controls (bank + program inputs) from
// programMap, based on the port and channel currently selected in its UI.
// The bank letters A–P map to Bank Select MSB 0–15 with LSB 0; values
// learned from the MIDI input that don't fit that scheme show as empty.
export function updateProgramDisplay(el) {
    const port = Number(el.querySelector('.synth-midi-port').value);
    const channel = Number(el.querySelector('.synth-channel').value);
    const st = programMap.get(programKey(port, channel));

    // Hydrate the inputs without clobbering a field the user is typing in
    const bankManual = el.querySelector('.program-bank-manual');
    const numberManual = el.querySelector('.program-number-manual');
    if (document.activeElement !== bankManual) {
        const msb = st?.bank_msb;
        const lsb = st?.bank_lsb;
        bankManual.value = (Number.isInteger(msb) && msb >= 0 && msb <= 15 && lsb === 0)
            ? String.fromCharCode(65 + msb)
            : '';
    }
    if (document.activeElement !== numberManual) {
        numberManual.value = Number.isInteger(st?.program) ? st.program + 1 : '';
    }
}

// Sends the synth's current bank + program selection to its output port
// and channel, and reflects the returned state. Called on every change of
// either control — an empty program sends the bank alone, and an empty
// bank sends no Bank Select at all. Bank as a single letter A–P, program
// as 1–128.
export function sendProgramSelection(id, el) {
    const port = Number(el.querySelector('.synth-midi-port').value);
    const channel = Number(el.querySelector('.synth-channel').value);

    let bankMsb = null;
    let bankLsb = null;
    let program = null;
    const letter = el.querySelector('.program-bank-manual').value;
    if (letter >= 'A' && letter <= 'P') {
        bankMsb = letter.charCodeAt(0) - 65;
        bankLsb = 0;
    }
    const num = Number(el.querySelector('.program-number-manual').value);
    if (Number.isInteger(num) && num >= 1 && num <= 128) program = num - 1;

    invoke('set_synth_program', { id, program, bankMsb, bankLsb })
        .then(st => {
            programMap.set(programKey(port, channel), st);
            refreshProgramDisplays(port, channel);
        })
        .catch(err => console.error('Error in set_synth_program:', err));
}

// Synth selection labels: the "zones-val" summary shown on each card
// (total duration in beats or seconds, or the raw pixel count) and the
// global display-mode preference it follows.

// Display mode of the zones value: 'beats' (total duration in metronome
// beats), 'seconds' (the same duration at the metronome's BPM, compact
// clock form) or 'pixels' (raw count of selected pixels). Clicking the
// value cycles through the three modes — a global display preference,
// persisted like the locale.
const ZONES_DISPLAY_MODES = ['beats', 'seconds', 'pixels'];
const storedZonesDisplayMode =
    typeof localStorage !== 'undefined' ? localStorage.getItem('wysiwyl.zonesDisplayMode') : null;
let zonesDisplayMode = ZONES_DISPLAY_MODES.includes(storedZonesDisplayMode)
    ? storedZonesDisplayMode
    : 'beats';

// Total duration, in metronome beats, of the pixels a synth will travel
// over (see note-timing.js for the computation). The enabled lengths are
// ordered like the backend: darkest band gets the shortest (the longest
// when reversed).
function synthZonesTotalBeats(id, el) {
    const hi = synthHighlights.get(id);
    if (!hi || !viewer.processedPixels || hi.zones.length === 0) return 0;

    const ternary = el.querySelector('.synth-note-length-ternary').classList.contains('active');
    let lengths = Array.from(el.querySelectorAll('.note-length-btn.active'))
        .map(btn => noteLengthBeats(btn.dataset.length, ternary));
    if (lengths.length === 0) lengths = [noteLengthBeats('quarter', ternary)];
    lengths.sort((a, b) => a - b);
    if (el.querySelector('.synth-reverse-note-length').classList.contains('active')) {
        lengths.reverse();
    }

    const ratio = Number(el.querySelector('.synth-tempo').value) || 1;
    return zonesTotalBeats(hi.zones, viewer.processedPixels, lengths, ratio);
}

// "zones-val" shows the synth's selection summary, in the global display
// mode: total duration in metronome beats (each pixel's note length ÷
// tempo ratio), the same duration in seconds at the metronome's BPM, or
// the number of selected pixels.
export function updateZonesLabel(id) {
    const el = synthElementById(id);
    if (!el) return;
    const zonesVal = el.querySelector('.zones-val');

    if (!viewer.hasImage || !viewer.processedPixels) {
        zonesVal.textContent = '-';
        return;
    }

    if (zonesDisplayMode === 'pixels') {
        const hi = synthHighlights.get(id);
        const count = hi ? zonesPixelCount(hi.zones) : 0;
        zonesVal.textContent = `${count.toLocaleString(getLocale())} px`;
        return;
    }

    const beats = synthZonesTotalBeats(id, el);
    if (zonesDisplayMode === 'seconds') {
        const bpm = clampBpm(currentBpm());
        zonesVal.textContent = formatDurationClock(beats * 60 / bpm);
        return;
    }
    const formatted = beats.toLocaleString(getLocale(), { maximumFractionDigits: 2 });
    zonesVal.textContent = `${formatted} ${t('synth.zonesBeatsUnit')}`;
}

export function updateAllSynthZonesLabels() {
    document.querySelectorAll('.synth-block').forEach(el => {
    updateZonesLabel(Number(el.dataset.synthId));
    updateNoteRangeInfo(el);
    });
}

// Cycles the global display mode (beats → seconds → pixels), persists the
// choice, and refreshes every card.
export function cycleZonesDisplayMode() {
    const next = ZONES_DISPLAY_MODES[
        (ZONES_DISPLAY_MODES.indexOf(zonesDisplayMode) + 1) % ZONES_DISPLAY_MODES.length
    ];
    zonesDisplayMode = next;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('wysiwyl.zonesDisplayMode', next);
    }
    updateAllSynthZonesLabels();
}

// Synth model/UI: the configurable options, the card DOM lookups, the
// display helpers, the MIDI program UI and the selection labels.

import { clampBpm, currentBpm } from '../audio/metronome.js';
import { zonesPixelCount } from '../core/geometry.js';
import { applyTranslations, getLocale, t } from '../core/i18n.js';
import { createStore, synthDisplayNumbers, synthHighlights, synthNames, viewer } from '../core/state.js';
import { NOTE_LENGTH_BEATS, formatDurationClock, zonesTotalBeats } from '../core/timing.js';
import { midiNoteName } from '../core/utils.js';

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

    let lengths = Array.from(el.querySelectorAll('.note-length-btn.active'))
        .map(btn => NOTE_LENGTH_BEATS[btn.dataset.length] ?? NOTE_LENGTH_BEATS.quarter);
    if (lengths.length === 0) lengths = [NOTE_LENGTH_BEATS.quarter];
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

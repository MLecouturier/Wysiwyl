// Synth cards, playback and tabs: creation and configuration of a synth
// card, the brightness/velocity range controls, the play/stop handling,
// the tab drag & drop and the removal confirmation. The metronome and the
// image-controls lock are reached through hooks injected by main.js.

import { t, applyTranslations } from '../core/i18n.js';
import { getTemplate } from '../core/templates.js';
import { NOTE_NAMES, playAllStatus } from '../core/utils.js';
import { rectZone, zoneCellSet, rebuildZones } from '../core/geometry.js';
import { viewer } from '../core/state.js';
import {
    synthNames, synthDisplayNumbers, synthColors, synthHighlights,
    synthBrightnessBounds, synthCursors, removeSynthFromRegistry,
} from '../core/state.js';
import { appEvents } from '../core/state.js';
import { synthElementById } from './model.js';
import { scaleOptionsHtml, applyNoteRangeTitles, getSynthColors } from './model.js';
import { updateZonesLabel, cycleZonesDisplayMode } from './model.js';
import { synthDisplayName, setPlayButtonState, setSynthPlaying } from './model.js';
import { isWheelNotch, getTrackpadThreshold } from '../audio/stepper.js';
import { sendProgramSelection, updateProgramDisplay } from './model.js';
import {
    eraseSynthCursor, drawRangeHighlight, clearRangeHighlight, redrawAllHighlights,
    drawChannelOverlay, hideChannelOverlay, updateBrightnessBounds,
} from './selection.js';
import {
    sendSynthZones, sendSynthMuteZones, sendSynthNoteRanges, sendSynthNoteLengths,
    clipMuteZonesToSelection,
} from './selection.js';
import { startZonePicking, cancelZonePicking, isZoneMode, isZonePickingId, remapZonePickIds } from './selection.js';

// Deferred so importing this module does not touch the Tauri globals.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

// Cross-domain hooks injected by main.js at startup.
let hooks = {
    ensureMetronomeStarted: async () => {},
    stopMetronomeIfIdle: async () => {},
    updateImageControlsLockState: () => {},
};
export function configureSynthCards(injected) {
    hooks = { ...hooks, ...injected };
}

const synthDevices = document.querySelector('.synth-devices-wrapper');
const synthListBody = document.querySelector('.synth-list-body');
const synthTabs = document.querySelector('.synth-tabs');
const placeholder = document.querySelector('.synth-list-body .placeholder-text');
const playAllBtn = document.querySelector('#play-all-btn');

// Options of the reading-direction select of a synth: an arrow glyph per
// direction (locale-independent), the localized names live in the option
// titles.
const READING_DIRECTIONS = [
    { value: 'leftToRight', glyph: '→' },
    { value: 'rightToLeft', glyph: '←' },
    { value: 'topToBottom', glyph: '↓' },
    { value: 'bottomToTop', glyph: '↑' },
    { value: 'spiral', glyph: '↻' },
    { value: 'spiralReverse', glyph: '↺' },
];
const readingDirectionOptions = READING_DIRECTIONS.map(d =>
    `<option value="${d.value}" data-i18n-title="synth.readingDirection.${d.value}">${d.glyph}</option>`
).join('');

// Reflects the synth's channel volume on its tab: the bottom bar's
// width follows the volume, expressed as a percentage of the MIDI
// range 0–127 (see .synth-tab-volume-bar).
export function setTabVolumeBar(tab, volume) {
    const v = Math.max(0, Math.min(127, volume));
    tab?.style.setProperty('--synth-volume', `${(v / 127 * 100).toFixed(2)}%`);
}

// Reflects a newly created synth's backend state (built from the
// default-synth template) into its UI. No backend calls needed: the state
// is already applied server-side.
export function applySynthConfig(el, cfg) {
    // Tempo
    el.querySelector('.synth-tempo').value = String(cfg.tempo_ratio);
    // MIDI channel
    el.querySelector('.synth-channel').value = String(cfg.channel);
    // Mode (monophonic / polyphonic)
    const mode = cfg.mode === 'polyphonic' ? 'polyphonic' : 'monophonic';
    el.querySelectorAll('.synth-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });
    el.querySelector('.synth-mode-panel-mono').classList.toggle('hidden', mode !== 'monophonic');
    el.querySelector('.synth-mode-panel-poly').classList.toggle('hidden', mode !== 'polyphonic');
    // Loop / back-and-forth (mutually exclusive)
    el.querySelector('.synth-loop-btn').classList.toggle('active', !!cfg.loop_enabled && !cfg.back_and_forth);
    el.querySelector('.synth-back-n-forth-btn').classList.toggle('active', !!cfg.back_and_forth);
    // Reading direction
    el.querySelector('.synth-reading-direction').value = cfg.reading_direction || 'leftToRight';
    // Sorted reading
    el.querySelector('.synth-sort-btn').classList.toggle('active', !!cfg.sorted_reading);
    // Brightness threshold
    el.querySelector('.brightness-start').value = cfg.brightness_min;
    el.querySelector('.brightness-end').value = cfg.brightness_max;
    el.querySelector('.brightness-start-val').textContent = cfg.brightness_min;
    el.querySelector('.brightness-end-val').textContent = cfg.brightness_max;
    synthBrightnessBounds.set(Number(el.dataset.synthId), {
        min: Number(cfg.brightness_min),
        max: Number(cfg.brightness_max),
    });
    // Velocity range
    el.querySelector('.velocity-min').value = cfg.velocity_min;
    el.querySelector('.velocity-max').value = cfg.velocity_max;
    el.querySelector('.velocity-min-val').textContent = cfg.velocity_min;
    el.querySelector('.velocity-max-val').textContent = cfg.velocity_max;
    el.querySelector('.synth-relative-velocity-range')
        .classList.toggle('active', !!cfg.velocity_relative);
    // Channel volume (raw MIDI value 0–127), sent as MIDI CC 7. Default
    // for sessions saved before the setting existed.
    const volume = Number.isFinite(cfg.volume) ? cfg.volume : 127;
    el.querySelector('.synth-volume').value = volume;
    setTabVolumeBar(el._tab, volume);
    // Hue shift (monophonic panel)
    const hueInput = el.querySelector('.synth-hue-shift');
    hueInput.value = cfg.hue_shift;
    el.querySelector('.hue-shift-val').textContent = `${cfg.hue_shift}°`;
    anchorHueGradient(hueInput, cfg.hue_shift);
    // R/G/B channel toggles (polyphonic panel)
    el.querySelectorAll('.synth-channel-toggle').forEach(btn => {
        const i = Number(btn.dataset.channel);
        btn.classList.toggle('active', !cfg.channel_enabled || !!cfg.channel_enabled[i]);
    });
    // Note lengths (guarantee at least one active)
    const lengths = Array.isArray(cfg.note_lengths) && cfg.note_lengths.length > 0
        ? cfg.note_lengths
        : ['quarter'];
    el.querySelectorAll('.note-length-btn').forEach(btn => {
        btn.classList.toggle('active', lengths.includes(btn.dataset.length));
    });
    el.querySelector('.synth-reverse-note-length').classList.toggle('active', !!cfg.note_length_reversed);
    el.querySelector('.synth-note-length-section').classList.toggle('reversed', !!cfg.note_length_reversed);
    // Sustain: false by default (pizzicato) — also the backend's default
    // for sessions saved before the option existed
    el.querySelector('.synth-note-sustain').classList.toggle('active', !!cfg.note_sustain);
    // Note ranges (mono + one per voice)
    const setRange = (group, toggles) => ['bass', 'medium', 'treble'].forEach((kind, i) => {
        group.querySelector(`.synth-${kind}`).classList.toggle('active', !!(toggles && toggles[i]));
    });
    setRange(el.querySelector('.synth-mode-panel-mono .synth-note-range'), cfg.mono_note_range);
    el.querySelectorAll('.synth-mode-panel-poly .synth-note-range').forEach((group, i) => {
        setRange(group, cfg.voice_note_ranges && cfg.voice_note_ranges[i]);
    });
    // Scale quantization (shared by both panels; defaults for sessions
    // saved before the option existed). The select is rebuilt with the
    // restored scale as the active one: if it is globally disabled the
    // ghost option keeps it selectable instead of corrupting the value.
    const scale = cfg.scale || 'chromatic';
    const scaleRoot = Number.isInteger(cfg.scale_root) ? cfg.scale_root : 0;
    el.querySelectorAll('.synth-scale').forEach(sel => {
        sel.innerHTML = scaleOptionsHtml(scale);
        sel.value = scale;
    });
    el.querySelectorAll('.synth-scale-root').forEach(sel => { sel.value = String(scaleRoot); });
}

// One bass/medium/treble filter group: used four times per card
// (monophonic note + each of the three polyphonic voices)
export function noteRangeGroup() {
    return getTemplate('synth-note-range');
}

export function createSynthElement(id, cfg = null) {
    const el = getTemplate('synth-card');
    el.dataset.synthId = id;

    // Updates the `id` binding this function's closures capture, so every
    // listener below keeps targeting the right synth after the ids are
    // renumbered to match the display order (see renumberSynthIds).
    el._setSynthId = newId => { id = newId; };

    // Seed the display number first: the tab's tooltip below derives
    // from it via synthDisplayName. Backend-driven creation provides it;
    // older contexts (none today) fall back to the id.
    synthDisplayNumbers.set(id, cfg?.display_number ?? id);

    // Compact tab in the first column: drag handle + play/pause. The
    // synth's title appears in the tooltip only. Shares the `id` binding
    // with the card's own listeners, so it follows the renumbering too.
    const tab = getTemplate('synth-tab');
    tab.dataset.synthId = id;
    tab.title = synthDisplayName(id);
    const tabPlayBtn = tab.querySelector('.synth-tab-play');
    setPlayButtonState(tabPlayBtn, false);
    tabPlayBtn.addEventListener('click', () => onSynthPlayClick(id, el));
    initTabDrag(tab, el);
    synthTabs.appendChild(tab);
    el._tab = tab;

    // Color: reuse a pre-seeded entry (session load), or take the first
    // palette color not already used by another synth — falling back to
    // rotation when the palette is exhausted
    const palette = getSynthColors();
    const seededColor = synthColors.get(id);
    const usedColors = new Set(synthColors.values());
    const defaultColor = seededColor
        || palette.find(c => !usedColors.has(c))
        || palette[(synthColors.size) % palette.length];
    synthColors.set(id, defaultColor);

    // The tab carries its synth's identification color (handle icon +
    // left/top/bottom borders) via a CSS variable, kept in sync with the
    // color picker below. The card does the same for its own borders.
    tab.style.setProperty('--synth-tab-color', defaultColor);
    el.style.setProperty('--synth-color', defaultColor);

    const channelOptions = Array.from({ length: 16 }, (_, i) =>
        `<option value="${i}">${t('synth.channelOption', { number: i + 1 })}</option>`
    ).join('');

    // Bank select options: "–" (no Bank Select) + the 16 letters A–P
    const bankOptions = ['–', ...Array.from({ length: 16 }, (_, i) =>
        String.fromCharCode(65 + i))]
        .map(letter => `<option value="${letter === '–' ? '' : letter}">${letter}</option>`)
        .join('');

    const colorSwatches = palette.map(c =>
        `<button class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('');

    // Hydrate what the static template can't express: the dynamic
    // option lists (i18n- and config-driven), the palette swatches, the
    // four note-range groups and the identification color
    el.querySelector('.synth-color-band').style.background = defaultColor;
    el.querySelector('.color-swatches').innerHTML = colorSwatches;
    el.querySelector('.synth-channel').innerHTML = channelOptions;
    el.querySelector('.program-bank-manual').innerHTML = bankOptions;
    el.querySelector('.synth-reading-direction').innerHTML = readingDirectionOptions;
    el.querySelectorAll('[data-include="note-range-group"]').forEach(slot => slot.replaceWith(noteRangeGroup()));

    // Translate everything marked with data-i18n* above, plus the elements
    // whose text depends on dynamic state (title, play button, pixel info).
    applyTranslations(el);
    applyNoteRangeTitles(el);
    el.querySelector('.synth-title-label').textContent = synthDisplayName(id);
    setPlayButtonState(el.querySelector('.synth-play'), false);
    el.querySelector('.synth-mode-btn[data-mode="monophonic"]').textContent = t('synth.modeMonophonic');
    el.querySelector('.synth-mode-btn[data-mode="polyphonic"]').textContent = t('synth.modePolyphonic');

    el.querySelector('.synth-pixel-info').textContent = t('synth.pixelInfoEmpty');

    // Reflect the backend-driven initial state (default-synth template)
    if (cfg) applySynthConfig(el, cfg);

    el.querySelector('.synth-play').addEventListener('click', () => onSynthPlayClick(id, el));

    // ---- Save this synth's settings as the default template ----
    const saveTemplateBtn = el.querySelector('.synth-save-template');
    saveTemplateBtn.addEventListener('click', () => {
        invoke('set_default_synth_from', { id })
            .then(() => {
                saveTemplateBtn.classList.add('active');
                setTimeout(() => saveTemplateBtn.classList.remove('active'), 800);
            })
            .catch(err => console.error('Error in set_default_synth_from:', err));
    });

    // ---- Custom name: double-click the title to rename it ----
    const titleLabel = el.querySelector('.synth-title-label');
    titleLabel.addEventListener('dblclick', () => {
        if (el.querySelector('.synth-title-input')) return; // already editing

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'synth-title-input';
        input.maxLength = 32;
        input.value = synthNames.get(id) ?? '';

        titleLabel.classList.add('hidden');
        titleLabel.after(input);
        input.focus();
        input.select();

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            input.remove();
            titleLabel.classList.remove('hidden');
        };
        const commit = () => {
            if (closed) return;
            const name = input.value.trim();
            if (name) synthNames.set(id, name);
            else synthNames.delete(id);
            appEvents.emit('session-dirty');
            invoke('set_synth_name', { id, name: input.value })
                .catch(err => console.error('Error in set_synth_name:', err));
            titleLabel.textContent = synthDisplayName(id);
            if (tab) tab.title = synthDisplayName(id);
            close();
        };
        const cancel = () => {
            close();
        };

        input.addEventListener('keydown', (e) => {
            // Enter commits, Escape cancels; stopPropagation prevents the
            // global Escape handler (zone picking) from firing as well
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
        });
        input.addEventListener('blur', commit);
    });
    el.querySelector('.synth-step-forward').addEventListener('click', () => {
        invoke('step_synth', { id })
            .catch(err => console.error('Error in step_synth:', err));
    });

    // ---- Channel volume (raw MIDI value 0–127), sent as MIDI CC 7 ----
    // Editable live while playing. Scrolling over the input adjusts the
    // value by ±1; the wheel's page scroll is suppressed while over it.
    const volumeInput = el.querySelector('.synth-volume');
    const sendSynthVolume = () => {
        let volume = Math.round(Number(volumeInput.value));
        if (!Number.isFinite(volume)) volume = 127;
        volume = Math.max(0, Math.min(127, volume));
        volumeInput.value = String(volume);
        setTabVolumeBar(tab, volume);
        invoke('set_synth_volume', { id, volume })
            .catch(err => console.error('Error in set_synth_volume:', err));
    };
    // Nudges the volume by the given delta and sends it. Shared by the
    // input's own wheel and the tab's: the tab carries the volume bar,
    // so scrolling over it adjusts the value the same way.
    const adjustSynthVolume = (delta) => {
        let current = Math.round(Number(volumeInput.value));
        if (!Number.isFinite(current)) current = 127;
        const next = Math.max(0, Math.min(127, current + delta));
        volumeInput.value = String(next);
        sendSynthVolume();
    };
    // Wheel/trackpad sensitivity: trackpads emit a continuous stream of
    // small deltas (two-finger scroll), which made the adjustment far
    // too fast — each event moved the value by ±1. The deltas are
    // accumulated instead, and one step is applied per configured
    // trackpad threshold of accumulated units, so a trackpad swipe
    // adjusts smoothly and slowly. Mouse-wheel notches (isWheelNotch)
    // bypass the accumulator and apply ±1 per notch directly. The input
    // itself is covered by the delegated document-level input stepper
    // (same thresholds); this listener covers the tab, whose volume bar
    // adjusts the value the same way.
    let volumeWheelAccum = 0;
    const onVolumeWheel = (e) => {
        e.preventDefault();
        // Same effective delta as the delegated stepper: on macOS,
        // Shift+scroll can arrive as horizontal deltas only
        const delta = e.deltaY !== 0 ? e.deltaY : (e.shiftKey ? e.deltaX : 0);
        if (isWheelNotch(e, delta)) {
            volumeWheelAccum = 0; // discrete notch: no accumulation
            adjustSynthVolume(delta < 0 ? 1 : -1);
            return;
        }
        volumeWheelAccum += delta;
        const threshold = getTrackpadThreshold();
        const steps = Math.trunc(volumeWheelAccum / threshold);
        if (steps === 0) return;
        volumeWheelAccum -= steps * threshold;
        adjustSynthVolume(-steps);
    };
    volumeInput.addEventListener('change', sendSynthVolume);
    tab.addEventListener('wheel', onVolumeWheel, { passive: false });

    // ---- Program: bank (A–P) + program (1–128) sent to the instrument ----
    // Both inputs are always visible; each change sends the current
    // selection (see sendProgramSelection). The display also reflects
    // programs learned from the MIDI input.
    el.querySelector('.program-bank-manual')
        .addEventListener('change', () => sendProgramSelection(id, el));
    el.querySelector('.program-number-manual')
        .addEventListener('change', () => sendProgramSelection(id, el));
    updateProgramDisplay(el);
    el.querySelector('.synth-rewind').addEventListener('click', () => {
        invoke('reset_synth_cursor', { id })
            .catch(err => console.error('Error in reset_synth_cursor:', err));
    });
    el.querySelector('.synth-remove').addEventListener('click', () => onSynthRemoveClick(id, el));

    // Color band → toggle the picker
    const colorBand   = el.querySelector('.synth-color-band');
    const colorPicker = el.querySelector('.synth-color-picker');
    colorBand.addEventListener('click', () => {
        // Close any other open pickers
        document.querySelectorAll('.synth-color-picker').forEach(p => {
            if (p !== colorPicker) p.classList.add('hidden');
        });
        const opened = !colorPicker.classList.toggle('hidden');
        // The picker is anchored to the card's top-left corner: when the
        // band is clicked on a card partially scrolled out of the list,
        // scroll the picker fully into view instead of leaving it clipped
        // by the .synth-devices scroll container.
        if (opened) colorPicker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    // Click on a color
    colorPicker.querySelectorAll('.color-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            const color = btn.dataset.color;
            appEvents.emit('session-dirty');
            synthColors.set(id, color);
            colorBand.style.background = color;
            tab.style.setProperty('--synth-tab-color', color);
            el.style.setProperty('--synth-color', color);
            colorPicker.classList.add('hidden');
            // Redraw the highlight with the new color
            redrawAllHighlights();
        });
    });

    // Close the picker when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!el.contains(e.target)) colorPicker.classList.add('hidden');
    });
    el.querySelector('.synth-channel').addEventListener('change', (e) => {
        invoke('set_synth_channel', { id, channel: Number(e.target.value) })
            .catch(err => console.error('Error in set_synth_channel:', err));
        updateProgramDisplay(el);
        updateVolumeSharedChannelWarnings();
    });

    // MIDI output port: one connection per port is opened lazily by the
    // backend, so several synths can drive different MIDI interfaces. The
    // app's own virtual port (shown first, for routing into a DAW) is
    // labeled through i18n; physical ports keep their system name.
    const midiPortSelect = el.querySelector('.synth-midi-port');
    invoke('list_midi_ports').then(ports => {
        if (ports.length === 0) {
            midiPortSelect.innerHTML = `<option value="0">${t('synth.noMidiPort')}</option>`;
        } else {
            midiPortSelect.innerHTML = ports.map(p =>
                `<option value="${p.index}">${p.isVirtual ? t('synth.virtualPort') : p.name}</option>`
            ).join('');
            // Reflect the template's port; if it no longer exists
            // (interface unplugged), fall back to the virtual port when
            // available, otherwise to the first physical port — on both
            // sides of the UI/backend boundary.
            if (cfg && !ports.some(p => p.index === cfg.midi_port)) {
                const fallback = ports.find(p => p.isVirtual) || ports[0];
                midiPortSelect.value = String(fallback.index);
                invoke('set_synth_midi_port', { id, port: fallback.index })
                    .catch(err => console.error('Error in set_synth_midi_port:', err));
            } else if (cfg) {
                midiPortSelect.value = String(cfg.midi_port);
            }
        }
        // The program display depends on the port: refresh it now that
        // the select has its final value.
        updateProgramDisplay(el);
        updateVolumeSharedChannelWarnings();
    }).catch(err => console.error('Error in list_midi_ports:', err));
    midiPortSelect.addEventListener('change', (e) => {
        invoke('set_synth_midi_port', { id, port: Number(e.target.value) })
            .catch(err => console.error('Error in set_synth_midi_port:', err));
        updateProgramDisplay(el);
        updateVolumeSharedChannelWarnings();
    });

    // Tempo relative to the main metronome (e.g. 0.5 = one pixel every two ticks)
    el.querySelector('.synth-tempo').addEventListener('change', (e) => {
        invoke('set_synth_tempo', { id, tempo: Number(e.target.value) })
            .catch(err => console.error('Error in set_synth_tempo:', err));
        updateZonesLabel(id);
    });

    // ---- Loop / back-and-forth (mutually exclusive) ----
    const loopBtn = el.querySelector('.synth-loop-btn');
    const backNForthBtn = el.querySelector('.synth-back-n-forth-btn');
    loopBtn.addEventListener('click', () => {
        const loopEnabled = !loopBtn.classList.contains('active');
        loopBtn.classList.toggle('active', loopEnabled);
        if (loopEnabled) backNForthBtn.classList.remove('active');
        invoke('set_synth_loop', { id, loopEnabled })
            .catch(err => console.error('Error in set_synth_loop:', err));
    });
    backNForthBtn.addEventListener('click', () => {
        const enabled = !backNForthBtn.classList.contains('active');
        backNForthBtn.classList.toggle('active', enabled);
        if (enabled) loopBtn.classList.remove('active');
        invoke('set_synth_back_n_forth', { id, enabled })
            .catch(err => console.error('Error in set_synth_back_n_forth:', err));
    });

    // ---- Reading direction: left→right / right→left / top→bottom /
    // bottom→top ----
    const directionSelect = el.querySelector('.synth-reading-direction');
    directionSelect.addEventListener('change', () => {
        invoke('set_synth_reading_direction', { id, direction: directionSelect.value })
            .catch(err => console.error('Error in set_synth_reading_direction:', err));
    });

    // ---- Sorted reading: the pixels follow their absolute position in
    // the image instead of being read zone by zone ----
    const sortBtn = el.querySelector('.synth-sort-btn');
    sortBtn.addEventListener('click', () => {
        const enabled = !sortBtn.classList.contains('active');
        sortBtn.classList.toggle('active', enabled);
        invoke('set_synth_sorted_reading', { id, enabled })
            .catch(err => console.error('Error in set_synth_sorted_reading:', err));
    });

    // ---- Compact mode: reduce the card to the playback controls ----
    // Everything is driven by the .compact class on the synth block (see
    // the SCSS); the JS only toggles the class and the button icon.
    const toggleFullOptionsBtn = el.querySelector('.synth-toggle-full-options');
    toggleFullOptionsBtn.addEventListener('click', () => {
        const compact = el.classList.toggle('compact');
        toggleFullOptionsBtn.querySelector('.material-symbols-outlined').textContent =
            compact ? 'expand_all' : 'collapse_all';
    });

    // ---- Monophonic / polyphonic mode ----
    const modeBtns  = el.querySelectorAll('.synth-mode-btn');
    const monoPanel = el.querySelector('.synth-mode-panel-mono');
    const polyPanel = el.querySelector('.synth-mode-panel-poly');

    modeBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const newMode = btn.dataset.mode;
            if (btn.classList.contains('active')) return; // already the active mode
            try {
                await invoke('set_synth_mode', { id, mode: newMode });
                modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === newMode));
                monoPanel.classList.toggle('hidden', newMode !== 'monophonic');
                polyPanel.classList.toggle('hidden', newMode !== 'polyphonic');
            } catch (err) {
                console.error('Error in set_synth_mode:', err);
            }
        });
    });

    // ---- Hue shift (monophonic mode) ----
    const hueShiftInput = el.querySelector('.synth-hue-shift');
    const hueShiftVal    = el.querySelector('.hue-shift-val');
    hueShiftInput.addEventListener('input', () => {
        const hueShift = Number(hueShiftInput.value);
        hueShiftVal.textContent = `${hueShift}°`;
        anchorHueGradient(hueShiftInput, hueShift);
        invoke('set_synth_hue_shift', { id, hueShift })
            .catch(err => console.error('Error in set_synth_hue_shift:', err));
    });

    // ---- Note range filters (bass / medium / treble) ----
    // Mono panel has one filter for the single note; each polyphonic voice
    // has its own. Toggles are cumulative and all-off means full 0–127.
    el.querySelectorAll('.synth-note-range button').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            sendSynthNoteRanges(id, el);
        });
    });

    // ---- Scale quantization: gamme + tonique ----
    // One setting for the whole synth, mirrored in the mono and poly
    // panels: changing either select syncs the other. Every derived
    // note is snapped to the nearest degree of the chosen scale that
    // stays within the enabled note ranges.
    const scaleSelects = el.querySelectorAll('.synth-scale');
    const scaleRootSelects = el.querySelectorAll('.synth-scale-root');
    scaleSelects.forEach(sel => {
        sel.innerHTML = scaleOptionsHtml(null);
    });
    scaleRootSelects.forEach(sel => {
        sel.innerHTML = NOTE_NAMES
            .map((name, i) => `<option value="${i}">${name}</option>`)
            .join('');
    });
    const sendSynthScale = () => {
        const scale = scaleSelects[0].value;
        const root = Number(scaleRootSelects[0].value);
        invoke('set_synth_scale', { id, scale, root })
            .catch(err => console.error('Error in set_synth_scale:', err));
    };
    scaleSelects.forEach(sel => sel.addEventListener('change', () => {
        scaleSelects.forEach(other => { other.value = sel.value; });
        sendSynthScale();
    }));
    scaleRootSelects.forEach(sel => sel.addEventListener('change', () => {
        scaleRootSelects.forEach(other => { other.value = sel.value; });
        sendSynthScale();
    }));

    // ---- Note lengths: brightness → duration mapping ----
    // At least one length must stay enabled: clicking the last remaining
    // active button does nothing.
    el.querySelectorAll('.note-length-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const wasActive = btn.classList.contains('active');
            if (wasActive && el.querySelectorAll('.note-length-btn.active').length === 1) {
                return;
            }
            btn.classList.toggle('active');
            sendSynthNoteLengths(id, el);
            updateZonesLabel(id);
        });
    });
    // Sync the default state (quarter checked) with the backend
    sendSynthNoteLengths(id, el);
    el.querySelector('.synth-reverse-note-length').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const reversed = !btn.classList.contains('active');
        btn.classList.toggle('active', reversed);
        el.querySelector('.synth-note-length-section').classList.toggle('reversed', reversed);
        invoke('set_synth_note_length_reversed', { id, reversed })
            .catch(err => console.error('Error in set_synth_note_length_reversed:', err));
        updateZonesLabel(id);
    });

    // ---- Note articulation: sustained vs pizzicato ----
    // Active = each note holds its full length (the Note Off arrives with
    // the next note). Inactive = pizzicato: the Note Off is sent right
    // after the Note On and the instrument's natural decay shapes the
    // tail. The reading rhythm (note lengths) is unchanged.
    el.querySelector('.synth-note-sustain').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const sustain = !btn.classList.contains('active');
        btn.classList.toggle('active', sustain);
        invoke('set_synth_note_sustain', { id, sustain })
            .catch(err => console.error('Error in set_synth_note_sustain:', err));
    });

    // ---- R/G/B channel toggles (polyphonic mode) ----
    el.querySelectorAll('.synth-channel-toggle').forEach(toggleBtn => {
        toggleBtn.addEventListener('click', () => {
            const channelIndex = Number(toggleBtn.dataset.channel);
            const enabled = !toggleBtn.classList.contains('active');
            toggleBtn.classList.toggle('active', enabled);
            invoke('set_synth_channel_enabled', { id, channelIndex, enabled })
                .catch(err => console.error('Error in set_synth_channel_enabled:', err));
        });

        // Visual preview of the hovered channel, overlaid on the image
        toggleBtn.addEventListener('mouseenter', () => {
            const channelIndex = Number(toggleBtn.dataset.channel);
            drawChannelOverlay(channelIndex);
        });
        toggleBtn.addEventListener('mouseleave', () => {
            hideChannelOverlay();
        });
    });

    // Initialize the highlight state (visible by default, nothing
    // selected, nothing silenced)
    synthHighlights.set(id, { visible: true, zones: [], muteZones: [] });
    synthBrightnessBounds.set(id, {
        min: Number(cfg?.brightness_min ?? 0),
        max: Number(cfg?.brightness_max ?? 127),
    });
    updateZonesLabel(id);

    // Zones value: click to cycle the display mode (beats → seconds →
    // pixels). Global preference: every card switches together.
    el.querySelector('.zones-val').addEventListener('click', () => {
        cycleZonesDisplayMode();
    });

    // Eye button
    el.querySelector('.synth-eye-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const hi = synthHighlights.get(id);
        hi.visible = !hi.visible;
        btn.classList.toggle('active', hi.visible);
        // During playback this becomes the state kept after stop: the
        // user's last choice wins over the pre-playback snapshot
        hi._wasVisible = hi.visible;
        if (hi.visible) drawRangeHighlight(id);
        else            clearRangeHighlight(id);
        // The mirror's 'active' mode follows the eye buttons
        appEvents.emit('highlights-changed');
    });

    // Zone drawing: arm/cancel the rectangle-drawing mode on the image.
    // Clicking while the lasso is armed switches to the rectangle mode
    // right away instead of merely disarming the lasso.
    el.querySelector('.synth-add-zone-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (isZoneMode(id, 'rect')) {
            cancelZonePicking();
        } else {
            startZonePicking(id, btn);
        }
    });

    // Lasso: arm/cancel the free-hand selection mode on the image
    el.querySelector('.synth-lasso-add-zone-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (isZoneMode(id, 'lasso')) {
            cancelZonePicking();
        } else {
            startZonePicking(id, btn, 'lasso');
        }
    });

    // Magic wand: arm/cancel the similar-color selection mode on the
    // image. The tolerance input shows up in the zones header while the
    // mode is armed on this card.
    el.querySelector('.synth-magic-wand-add-zone-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (isZoneMode(id, 'wand')) {
            cancelZonePicking();
        } else {
            startZonePicking(id, btn, 'wand');
        }
    });

    // Select all: the whole image as a single zone (one run per row,
    // no cell enumeration — a large grid must not materialize every
    // cell as a key)
    el.querySelector('.synth-select-all-btn').addEventListener('click', () => {
        if (!viewer.hasImage) return;
        const hi = synthHighlights.get(id);
        if (!hi) return;
        if (isZonePickingId(id)) cancelZonePicking();
        hi.zones = [rectZone(0, 0, viewer.gridW, viewer.gridH)];
        sendSynthZones(id);
        updateZonesLabel(id);
        redrawAllHighlights();
    });

    // Clear all zones: back to nothing selected (and nothing silenced —
    // the silences live within the selection)
    el.querySelector('.synth-clear-zones-btn').addEventListener('click', () => {
        const hi = synthHighlights.get(id);
        if (!hi) return;
        hi.zones = [];
        hi.muteZones = [];
        sendSynthZones(id);
        sendSynthMuteZones(id);
        updateZonesLabel(id);
        redrawAllHighlights();
    });

    initBrightnessRange(el);
    initVelocityRange(el);

    // ---- Velocity mapping mode: relative (rescaled) vs clamp ----
    // Active = the saturation is rescaled onto [min, max] (the whole
    // range is used whatever the image). Inactive = the velocity is
    // computed on the native 1–127 range, then brought to the nearest
    // bound when outside [min, max] (a floor/ceiling filter).
    el.querySelector('.synth-relative-velocity-range').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const enabled = !btn.classList.contains('active');
        btn.classList.toggle('active', enabled);
        invoke('set_synth_velocity_relative', { id, enabled })
            .catch(err => console.error('Error in set_synth_velocity_relative:', err));
    });

    return el;
}

// Clip-then-push with a change guard: an unconditional set_synth_zones
// remaps the playhead and resets the deferred one-shot stop
// (end_pending), which would re-trigger the final note of a finishing
// synth on every value-slider refresh. The clip only removes cells, so
// equal sizes mean nothing changed.

export function updateAllSynthZones() {
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        const synthId = Number(el.dataset.synthId);
        const hi = synthHighlights.get(synthId);
        if (!hi) return;

        // Clip the zones to the new grid: cells outside disappear,
        // then the components are recomposed (a clip can split one)
        const cells = zoneCellSet(hi.zones);
        const kept = new Set([...cells].filter(k => {
            const [col, row] = k.split(',').map(Number);
            return col < viewer.gridW && row < viewer.gridH;
        }));

        // Only push when the clip actually changed something: a value
        // refresh (same grid) sends nothing at all
        if (kept.size !== cells.size) {
            hi.zones = rebuildZones(hi.zones, kept);
            sendSynthZones(synthId);
        }
        // Silences outside the new selection (or the new grid) disappear
        clipMuteZonesToSelection(synthId);
        updateZonesLabel(synthId);
    });
    redrawAllHighlights();
}

// Anchors the hue-shift slider's gradient on its thumb: the gradient is
// rotated by (360 - shift) so the red (0°) always sits at the handle's
// position and the other hues follow in circle order.
export function anchorHueGradient(input, hueShift) {
    input.style.setProperty('--hue-rot', `${(360 - Number(hueShift) % 360) % 360}deg`);
}

// The id is read from the DOM at event time (not captured at creation),
// so the listeners survive the id renumbering that follows the display
// order (see renumberSynthIds).
export function initBrightnessRange(el) {
    const startInput = el.querySelector('.brightness-start');
    const endInput   = el.querySelector('.brightness-end');
    const startVal   = el.querySelector('.brightness-start-val');
    const endVal     = el.querySelector('.brightness-end-val');
    const fill       = startInput.closest('.synth-range-track').querySelector('.synth-range-fill');

    function updateFill() {
        const max = 127;
        const s = Number(startInput.value) / max * 100;
        const e = Number(endInput.value)   / max * 100;
        // The gradient spans the whole track; --s/--e clip it to the
        // selection, keeping colors anchored to absolute luminosity values.
        fill.style.setProperty('--s', `${s}%`);
        fill.style.setProperty('--e', `${e}%`);

        const atEnd = Number(startInput.value) >= Number(endInput.value);
        startInput.style.zIndex = atEnd ? '3' : '2';
        endInput.style.zIndex   = atEnd ? '1' : '2';
    }

    function sendRange() {
        invoke('set_synth_brightness_range', {
            id: Number(el.dataset.synthId),
            brightnessMin: Number(startInput.value),
            brightnessMax: Number(endInput.value),
        }).catch(err => console.error('Error in set_synth_brightness_range:', err));
    }

    startInput.addEventListener('input', () => {
        if (Number(startInput.value) > Number(endInput.value)) startInput.value = endInput.value;
        startVal.textContent = startInput.value;
        updateFill();
        sendRange();
        updateBrightnessBounds(Number(el.dataset.synthId));
    });

    endInput.addEventListener('input', () => {
        if (Number(endInput.value) < Number(startInput.value)) endInput.value = startInput.value;
        endVal.textContent = endInput.value;
        updateFill();
        sendRange();
        updateBrightnessBounds(Number(el.dataset.synthId));
    });

    updateFill();
}

export function initVelocityRange(el) {
    const minInput = el.querySelector('.velocity-min');
    const maxInput = el.querySelector('.velocity-max');
    const minVal   = el.querySelector('.velocity-min-val');
    const maxVal   = el.querySelector('.velocity-max-val');
    const fill     = minInput.closest('.synth-range-track').querySelector('.synth-range-fill');

    function updateFill() {
        const max = 127;
        const s = Number(minInput.value) / max * 100;
        const e = Number(maxInput.value) / max * 100;
        fill.style.left  = `${s}%`;
        fill.style.width = `${e - s}%`;

        const atEnd = Number(minInput.value) >= Number(maxInput.value);
        minInput.style.zIndex = atEnd ? '3' : '2';
        maxInput.style.zIndex = atEnd ? '1' : '2';
    }

    function sendRange() {
        invoke('set_synth_velocity_range', {
            id: Number(el.dataset.synthId),
            velocityMin: Number(minInput.value),
            velocityMax: Number(maxInput.value),
        }).catch(err => console.error('Error in set_synth_velocity_range:', err));
    }

    minInput.addEventListener('input', () => {
        if (Number(minInput.value) > Number(maxInput.value)) minInput.value = maxInput.value;
        minVal.textContent = minInput.value;
        updateFill();
        sendRange();
    });

    maxInput.addEventListener('input', () => {
        if (Number(maxInput.value) < Number(minInput.value)) maxInput.value = minInput.value;
        maxVal.textContent = maxInput.value;
        updateFill();
        sendRange();
    });

    updateFill();
}

export async function onSynthPlayClick(id, el) {
    const isPlaying = await invoke('is_synth_playing', { id });
    if (!isPlaying) {
        await startSynthPlayback(id, el);
    } else {
        await stopSynthPlayback(id, el);
    }
    syncPlayAllButton();
}

// Updates the "play all" button's colour, icon and label from the synths'
// current state: green = none playing, orange = some, red = all. The click
// behaviour follows (see the play-all handler in main.js): green/orange
// start (or finish) the playback, red stops everything.
export function syncPlayAllButton() {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    const playing = blocks
        .filter(el => el.querySelector('.synth-play').classList.contains('active')).length;
    const state = playAllStatus(blocks.length, playing);
    const allPlaying = state === 'active';

    playAllBtn.classList.toggle('active', allPlaying);
    playAllBtn.classList.toggle('selective', state === 'selective');
    playAllBtn.querySelector('.material-symbols-outlined').textContent = allPlaying ? 'pause' : 'play_arrow';
    playAllBtn.querySelector('.play-all-label').textContent = allPlaying
        ? t('synthList.stopAllLabel')
        : t('synthList.playAllLabel');
    playAllBtn.title = allPlaying
        ? t('synthList.playAllStop')
        : t('synthList.playAllStart');
    reservePlayAllWidth();
}

// Pins the button's width to its widest possible label so the pill no longer
// resizes when the state (and therefore the label) flips. Measured on the
// live button — same font, padding and icon — by swapping the two candidate
// strings synchronously, so nothing is painted in between. Re-run on every
// sync, which also picks up a locale change.
function reservePlayAllWidth() {
    const label = playAllBtn.querySelector('.play-all-label');
    const current = label.textContent;
    let widest = 0;
    for (const text of [t('synthList.playAllLabel'), t('synthList.stopAllLabel')]) {
        label.textContent = text;
        widest = Math.max(widest, playAllBtn.getBoundingClientRect().width);
    }
    label.textContent = current;
    if (widest > 0) playAllBtn.style.minWidth = `${Math.ceil(widest)}px`;
}

// CC 7 addresses the MIDI channel, not the synth: several synths sharing
// the same (port, channel) override each other's volume — the last
// setting sent wins. Flags the volume inputs and the channel selects of
// every synth in that case with the shared-channel warning style and
// tooltip.
export function updateVolumeSharedChannelWarnings() {
    const blocks = Array.from(synthDevices.querySelectorAll('.synth-block'));
    const counts = new Map();
    const keyOf = block => {
        const port = block.querySelector('.synth-midi-port')?.value;
        const channel = block.querySelector('.synth-channel')?.value;
        return `${port}:${channel}`;
    };
    blocks.forEach(block => {
        const key = keyOf(block);
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    blocks.forEach(block => {
        const shared = counts.get(keyOf(block)) > 1;
        const input = block.querySelector('.synth-volume');
        if (input) {
            input.classList.toggle('shared-channel', shared);
            const key = shared ? 'synth.volumeSharedChannel' : 'synth.volume';
            input.dataset.i18nTitle = key;
            input.title = t(key);
        }
        const channelSelect = block.querySelector('.synth-channel');
        if (channelSelect) {
            channelSelect.classList.toggle('shared-channel', shared);
            const key = shared ? 'synth.channelSharedChannel' : 'synth.channel';
            channelSelect.dataset.i18nTitle = key;
            channelSelect.title = t(key);
        }
    });
}

// Channel volume learned from the MIDI input (CC 7 turned on the
// instrument): the backend has already updated the matching synths'
// state; refresh the volume field of every synth on that (port,
// channel), unless the user is currently editing it.
window.__TAURI__.event.listen('midi-volume', (event) => {
    const { port, channel, volume } = event.payload;
    synthDevices.querySelectorAll('.synth-block').forEach(block => {
        const blockPort = Number(block.querySelector('.synth-midi-port')?.value);
        const blockChannel = Number(block.querySelector('.synth-channel')?.value);
        if (blockPort !== port || blockChannel !== channel) return;
        const input = block.querySelector('.synth-volume');
        if (input && document.activeElement !== input) {
            input.value = String(volume);
        }
        // The tab's volume bar reflects the learned volume even while
        // the field is being edited: it mirrors the backend state
        setTabVolumeBar(block._tab, volume);
    });
});

// Locks/unlocks the controls specific to a synth while it is playing
// (MIDI channel, mono/poly mode, and the step forward). Everything else
// (hue shift, R/G/B toggles, velocity, loop, highlight, zone selection...)
// remains editable on the fly while the synth is playing.
export function setSynthControlsLocked(el, locked) {
    el.querySelector('.synth-channel').disabled = locked;
    el.querySelector('.synth-midi-port').disabled = locked;
    el.querySelectorAll('.synth-mode-btn').forEach(btn => { btn.disabled = locked; });
    el.querySelector('.synth-step-forward').disabled = locked;
}

// Volume restored when unmuting a synth that was already at 0 (nothing was
// memorised): the usual value for a freshly created synth.
const DEFAULT_UNMUTE_VOLUME = 100;

// Toggles a synth's channel volume between zero and its previous value.
// Backs the Alt+1-8 shortcut: muting instantly sets the volume to 0, and
// unmuting returns to the memorised value (or DEFAULT_UNMUTE_VOLUME when
// the synth was already at 0). Reuses the card's own volume path by
// dispatching a `change` event, so the field, the tab's volume bar and the
// backend (set_synth_volume → MIDI CC 7) all stay in sync.
export function toggleSynthMute(id) {
    const el = synthElementById(id);
    const input = el?.querySelector('.synth-volume');
    if (!input) return;
    const current = Math.round(Number(input.value));
    if (Number.isFinite(current) && current > 0) {
        el._preMuteVolume = current; // remember before muting
        input.value = '0';
    } else {
        const restored = (Number.isFinite(el._preMuteVolume) && el._preMuteVolume > 0)
            ? el._preMuteVolume
            : DEFAULT_UNMUTE_VOLUME;
        input.value = String(restored);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function startSynthPlayback(id, el) {
    cancelTransientTools(); // a running transport must not keep a tool armed
    await hooks.ensureMetronomeStarted();
    await invoke('start_synth', { id });
    setSynthPlaying(id, true);
    // Lock this synth's controls while it is playing
    setSynthControlsLocked(el, true);
    hooks.updateImageControlsLockState();
}

export async function stopSynthPlayback(id, el) {
    await invoke('stop_synth', { id });
    setSynthPlaying(id, false);
    await hooks.stopMetronomeIfIdle();
    // Unlock this synth's controls
    setSynthControlsLocked(el, false);
    hooks.updateImageControlsLockState();
}

// Keeps the eye button's active state in sync with the actual highlight
// visibility, wherever that state is changed programmatically
// ---------- Tab drag & drop (stack reordering) ----------
// Reorders the synths by dragging a tab's handle. The tabs move live
// during the drag; on release the devices column is mirrored to the same
// order and the ids are renumbered to match it (1..N, top to bottom).
// Brings a synth's device card fully into the devices column's view.
// When the card isn't entirely visible, it is aligned with the top of
// the view (smooth scroll) — the clicked tab's synth then reads as the
// current head of the stack. No-op when the card is already fully
// visible.
export function scrollSynthCardIntoView(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const view = synthDevices.getBoundingClientRect();
    const topInView = rect.top - view.top; // < 0: cut above, > 0: below or cut
    const fullyVisible = topInView >= 0 && rect.bottom <= view.bottom;
    if (fullyVisible) return;
    synthDevices.scrollBy({ top: topInView, behavior: 'smooth' });
}

export function initTabDrag(tab, el) {
    const handle = tab.querySelector('.synth-tab-drag-handle');

    let drag = null; // { pointerId, grabOffset } while dragging

    // Releasing a press on the tab's body — a simple click, not a drag —
    // brings the paired card into view. The play button keeps its own
    // role; the handle is covered by finish() (which scrolls on drop),
    // so excluding it here avoids a double scroll.
    tab.addEventListener('pointerup', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.synth-tab-play')) return;
        if (e.target.closest('.synth-tab-drag-handle')) return;
        scrollSynthCardIntoView(el);
    });

    handle.addEventListener('pointerdown', (e) => {
        // Nothing to reorder with less than two tabs
        if (e.button !== 0) return;
        if (synthTabs.querySelectorAll('.synth-tab').length < 2) return;

        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const rect = tab.getBoundingClientRect();
        drag = {
            pointerId: e.pointerId,
            grabOffset: e.clientY - rect.top, // pointer's position inside the tab
            dy: 0,                           // current vertical translation
        };
        tab.classList.add('dragging');
    });

    handle.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;

        // Live reorder: when the dragged tab's visual center crosses a
        // neighbor's center, swap their DOM positions
        const center = tab.getBoundingClientRect().top + tab.offsetHeight / 2;
        const prev = tab.previousElementSibling;
        const next = tab.nextElementSibling;
        if (prev) {
            const prevCenter = prev.getBoundingClientRect().top + prev.offsetHeight / 2;
            if (center < prevCenter) synthTabs.insertBefore(tab, prev);
        }
        if (next) {
            const nextCenter = next.getBoundingClientRect().top + next.offsetHeight / 2;
            if (center > nextCenter) synthTabs.insertBefore(tab, next.nextSibling);
        }

        // The tab follows the pointer: the translation is recomputed
        // against the (possibly swapped) layout position on every move
        const layoutTop = tab.getBoundingClientRect().top - drag.dy;
        drag.dy = e.clientY - drag.grabOffset - layoutTop;
        tab.style.transform = `translateY(${drag.dy}px)`;
    });

    const finish = (e) => {
        if (!drag || (e && e.pointerId !== drag.pointerId)) return;
        drag = null;
        tab.classList.remove('dragging');
        tab.style.transform = '';

        // Mirror the final tab order into the devices column, then
        // renumber the ids to match the display order. The order is read
        // before the renumbering changes the datasets.
        const order = Array.from(synthTabs.querySelectorAll('.synth-tab'))
            .map(t => Number(t.dataset.synthId));
        for (const id of order) {
            const block = synthElementById(id);
            if (block) synthDevices.appendChild(block);
        }

        // The reorder may have left the dragged synth's card off-view:
        // bring it back to the top of the view. The DOM positions are
        // already final here; the renumbering below doesn't move
        // anything visually.
        scrollSynthCardIntoView(el);

        appEvents.emit('session-dirty');
        renumberSynthIds().catch(err => console.error('Error in set_synth_order:', err));
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

// ---------- Id renumbering ----------
// Keeps the synth ids coherent with the stack's display order (the DOM
// order): after every change in the stack's composition, the ids are
// reassigned 1..N from top to bottom. A synth's id is thus always its
// position in the stack — the stable number an external MIDI controller
// will address it by. No-op when the ids already match the display order.
export async function renumberSynthIds() {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    const order = blocks.map(el => Number(el.dataset.synthId));
    if (order.length === 0) return;
    if (order.every((id, i) => id === i + 1)) return;

    await invoke('set_synth_order', { order });

    // Re-key every id-keyed state following the same renumbering
    const rekey = (map) => {
        const snapshot = new Map(map);
        map.clear();
        order.forEach((oldId, i) => {
            const value = snapshot.get(oldId);
            if (value !== undefined) map.set(i + 1, value);
        });
    };
    rekey(synthColors);
    rekey(synthCursors);
    rekey(synthHighlights);
    rekey(synthBrightnessBounds);
    rekey(synthNames);
    rekey(synthDisplayNumbers);

    blocks.forEach((el, i) => {
        const oldId = order[i];
        const newId = i + 1;
        el._setSynthId(newId); // update the id captured by the listeners
        el.dataset.synthId = newId;
        // Default titles follow the new id; custom names are unchanged
        el.querySelector('.synth-title-label').textContent = synthDisplayName(newId);
        // The paired tab follows the same renumbering
        const tab = el._tab;
        if (tab) {
            tab.dataset.synthId = newId;
            tab.title = synthDisplayName(newId);
        }
        // Re-target an armed zone-picking mode, if any
        remapZonePickIds(oldId, newId);
    });
}

// Double-click confirmation for synth removal: only one remove button can
const SYNTH_REMOVE_CONFIRM_DELAY_MS = 3000;
let armedSynthRemoveBtn = null;
let armedSynthRemoveTimer = null;

export function resetSynthRemoveConfirm() {
    if (armedSynthRemoveTimer) {
        clearTimeout(armedSynthRemoveTimer);
        armedSynthRemoveTimer = null;
    }
    if (armedSynthRemoveBtn) {
        armedSynthRemoveBtn.classList.remove('confirm-pending');
        armedSynthRemoveBtn.title = t('synth.remove');
        armedSynthRemoveBtn.querySelector('.material-symbols-outlined').textContent = 'close';
        armedSynthRemoveBtn = null;
    }
}

// Cancels every transient tool: an armed zone-picking mode and a pending
// synth-removal confirmation. Called whenever the context changes (new
// synth, modal, Escape, window blur, playback start, session load) so a
// tool left armed on one element can never act on another by accident.
export function cancelTransientTools() {
    cancelZonePicking();
    resetSynthRemoveConfirm();
}

export async function onSynthRemoveClick(id, el) {
    const btn = el.querySelector('.synth-remove');

    // First click: arm the confirmation (red state) and wait up to 3 s.
    // A second click within the window performs the removal; without it,
    // the button silently reverts to its initial state.
    if (btn !== armedSynthRemoveBtn) {
        resetSynthRemoveConfirm();
        armedSynthRemoveBtn = btn;
        btn.classList.add('confirm-pending');
        btn.title = t('synth.removeConfirm');
        btn.querySelector('.material-symbols-outlined').textContent = 'delete';
        armedSynthRemoveTimer = setTimeout(resetSynthRemoveConfirm, SYNTH_REMOVE_CONFIRM_DELAY_MS);
        return;
    }

    // Confirmation click: disarm, then actually remove
    resetSynthRemoveConfirm();
    appEvents.emit('session-dirty');
    await invoke('stop_synth', { id }).catch(() => {});
    await invoke('remove_synth', { id });

    if (isZonePickingId(id)) cancelZonePicking();

    eraseSynthCursor(id);
    // The dropped display number only cleans the map: the number itself
    // stays retired (the backend counter never reuses it)
    removeSynthFromRegistry(id);
    el._tab?.remove();
    el.remove();
    await renumberSynthIds();
    redrawAllHighlights();
    updateVolumeSharedChannelWarnings();

    if (synthListBody.querySelectorAll('.synth-block').length === 0) {
        placeholder.classList.remove('hidden');
    }
    syncPlayAllButton();
    await hooks.stopMetronomeIfIdle();
    hooks.updateImageControlsLockState();
}
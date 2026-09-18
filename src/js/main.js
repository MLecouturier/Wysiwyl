import { initI18n, t, translateError, getLocale, setLocale, AVAILABLE_LOCALES, applyTranslations } from './i18n.js';
import { computeLayout, cellSetFromZones, drawZones, drawCursorCell, MUTE_GLYPH } from './viewer-render.js';
import {
    seedZoneOrder, rectZone, zoneCellSet, zoneContains,
    zoneIntersectsRect, zonesPixelCount, rebuildZones,
} from './zones.js';

const { invoke } = window.__TAURI__.core;
const { emit, listen } = window.__TAURI__.event;
const { WebviewWindow } = window.__TAURI__.webviewWindow;
const { getCurrentWindow, currentMonitor, availableMonitors } = window.__TAURI__.window;

await initI18n();

// Map id → custom name
const synthNames = new Map();

// Map id → display number of the default title. Attributed once at
// creation, never changed nor reused: unlike the id (renumbered with the
// stack's display order), it keeps a synth's default name ("Synth #n")
// stable across reorders and removals, so the user is never confused by
// a renaming.
const synthDisplayNumbers = new Map();

// Map "port:channel" → last known program of that MIDI channel, learned
// from the MIDI input (Program Change / Bank Select sent by the
// instruments) or set by the app itself. Programs are channel state, not
// synth state: every synth on a given (port, channel) displays the same.
const programMap = new Map();
const programKey = (port, channel) => `${port}:${channel}`;

// Refreshes the program display of every synth currently on the given
// (port, channel)
function refreshProgramDisplays(port, channel) {
    const key = programKey(port, channel);
    synthListBody.querySelectorAll('.synth-block').forEach(block => {
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
function updateProgramDisplay(el) {
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
function sendProgramSelection(id, el) {
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

// Display name of a synth: its custom name, or the translated default
// (built from the stable display number, not the functional id)
function synthDisplayName(id) {
    return synthNames.get(id) || t('synth.title', { id: synthDisplayNumbers.get(id) ?? id });
}

// ---------- Language switcher ----------
function renderLanguageSwitcher() {
    const container = document.querySelector('#language-switcher');
    if (!container) return;
    const current = getLocale();
    container.innerHTML = `
        <select id="language-select" aria-label="Language">
            ${AVAILABLE_LOCALES.map(l => {
                // We read each locale's own display name via a tiny lookup,
                // falling back to the code if unavailable.
                return `<option value="${l.code}" ${l.code === current ? 'selected' : ''}>${localeDisplayName(l.code)}</option>`;
            }).join('')}
        </select>
    `;
    container.querySelector('#language-select').addEventListener('change', (e) => {
        setLocale(e.target.value);
    });
}

// Display names are hardcoded here (not translated) so a language always
// shows its own name (e.g. "Français" stays "Français" no matter the
// active locale). Add an entry here when adding a new language.
const LOCALE_DISPLAY_NAMES = { en: 'English', fr: 'Français' };
function localeDisplayName(code) {
    return LOCALE_DISPLAY_NAMES[code] || code.toUpperCase();
}

renderLanguageSwitcher();

// Updates a synth's play/stop button: icon, label, and active state stay
// in sync, whatever the trigger (click, locale change, remote event, ...).
function setPlayButtonState(btn, playing) {
    btn.classList.toggle('active', playing);
    btn.querySelector('.synth-play-icon').textContent = playing ? 'pause' : 'play_arrow';
    btn.querySelector('.synth-play-label').textContent = playing ? t('synth.stop') : t('synth.play');
}

// Updates BOTH play/pause buttons of a synth — the device card's and the
// tab's — so the two columns always show the same state.
function setSynthPlaying(id, playing) {
    const el = synthElementById(id);
    if (el) setPlayButtonState(el.querySelector('.synth-play'), playing);
    const tab = synthTabById(id);
    if (tab) setPlayButtonState(tab.querySelector('.synth-tab-play'), playing);
}

// Re-translates an existing synth card: static parts via data-i18n*, plus
// the few labels whose text depends on dynamic state (play/stop, mode)
// that data-i18n alone can't express.
function retranslateSynthElement(el) {
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

// ---------- Global configuration ----------
// The BPM input is initialized with the persisted default; the config
// file itself is hand-edited via the gear button in the footer (edits
// apply on the next application start).
invoke('get_config').then(config => {
    bpmInput.value = config.default_bpm;
    // Trackpad scroll feel of the wheel-driven steppers (BPM, sliders,
    // synth volume): accumulated deltas per increment. The backend
    // already clamps the persisted value; validate defensively anyway.
    const trackpadThreshold = Number(config.wheel_trackpad_threshold);
    if (Number.isFinite(trackpadThreshold) && trackpadThreshold >= 1) {
        WHEEL_TRACKPAD_THRESHOLD = trackpadThreshold;
    }
    if (localStorage.getItem('wheelDebug') === '1') {
        console.debug(`wheel: effective WHEEL_TRACKPAD_THRESHOLD=${WHEEL_TRACKPAD_THRESHOLD}`);
    }
    if (Array.isArray(config.synth_colors) && config.synth_colors.length > 0) {
        SYNTH_COLORS = config.synth_colors;
    }
    if (Array.isArray(config.note_range_bounds) && config.note_range_bounds.length === 3) {
        NOTE_RANGE_BOUNDS = config.note_range_bounds.map(([lo, hi]) => {
            const l = Math.min(Number(lo), Number(hi));
            const h = Math.max(Number(lo), Number(hi));
            return [Math.max(0, Math.min(127, l)), Math.max(0, Math.min(127, h))];
        });
    }
    // Enabled scales: unknown values are dropped, chromatic is always
    // kept. Synth cards created before the config arrived are refreshed.
    if (Array.isArray(config.enabled_scales)) {
        ENABLED_SCALES = new Set(
            config.enabled_scales.filter(s => SCALE_OPTIONS.some(o => o.value === s))
        );
    }
    ENABLED_SCALES.add('chromatic');
    document.querySelectorAll('.synth-block').forEach(el => refreshScaleSelects(el));
    // Clock source of the metronome (master / slave), persisted by the
    // backend and applied live on its side; the selects just reflect it.
    hydrateClockMode(config.clock_mode, config.clock_source);
}).catch(err => console.error('Error in get_config:', err));

document.querySelector('#open-config-btn').addEventListener('click', () => {
    invoke('open_config_file')
        .catch(err => console.error('Error in open_config_file:', err));
});

// Re-apply translations everywhere (static markup + dynamically created
// synth cards) whenever the locale changes.
window.addEventListener('locale-changed', () => {
    renderLanguageSwitcher();
    document.querySelectorAll('.synth-block').forEach(el => retranslateSynthElement(el));
    if (typeof syncLabels === 'function') syncLabels();
    if (lastDimensionsInfo) dimensionsInfo.textContent = t('controls.dimensionsInfo', lastDimensionsInfo);
    if (typeof syncPlayAllButton === 'function') syncPlayAllButton();
    // The clock badge's label is locale-dependent too
    if (typeof refreshClockBadge === 'function') refreshClockBadge();
});

// ---------- Contextual help mode (live-help button) ----------
// When active, hovering any element carrying a data-i18n-title opens a
// detailed help window instead of the native tooltip. Detailed texts live
// under the "help.*" i18n keys; elements without one fall back to their
// short tooltip text as the heading.
const liveHelpBtn = document.querySelector('#live-help-btn');

const helpPopup = document.createElement('div');
helpPopup.id = 'help-popup';
helpPopup.classList.add('hidden');
helpPopup.innerHTML = '<h3 class="help-heading"></h3><p class="help-body"></p>';
document.body.appendChild(helpPopup);

let helpModeEnabled = false;
let helpTarget = null;
let helpTargetTitle = '';

// The native tooltip of the element we cover is saved and restored, so the
// two never overlap while help mode is on.
function restoreHelpTargetTitle() {
    if (helpTarget) {
        helpTarget.title = helpTargetTitle;
        helpTarget = null;
        helpTargetTitle = '';
    }
}

function hideHelpPopup() {
    restoreHelpTargetTitle();
helpPopup.classList.add('help-popup', 'hidden');
}

function setHelpMode(enabled) {
    helpModeEnabled = enabled;
    liveHelpBtn.classList.toggle('active', enabled);
    if (!enabled) hideHelpPopup();
}

function showHelpPopup(target) {
    restoreHelpTargetTitle();
    helpTarget = target;
    helpTargetTitle = target.title;
    target.title = '';

    const detailed = t(`help.${target.dataset.i18nTitle}`);
    const hasDetailed = detailed !== `help.${target.dataset.i18nTitle}`;
    helpPopup.querySelector('.help-heading').textContent = helpTargetTitle;
    const body = helpPopup.querySelector('.help-body');
    body.textContent = hasDetailed ? detailed : '';
    body.classList.toggle('hidden', !hasDetailed);

    helpPopup.classList.remove('hidden');

    // Below the target (above if it overflows), clamped to the viewport
    const rect = target.getBoundingClientRect();
    const x = Math.min(Math.max(8, rect.left), window.innerWidth - helpPopup.offsetWidth - 8);
    let y = rect.bottom + 6;
    if (y + helpPopup.offsetHeight > window.innerHeight) {
        y = rect.top - helpPopup.offsetHeight - 6;
    }
    helpPopup.style.left = `${x}px`;
    helpPopup.style.top = `${Math.max(8, y)}px`;
}

liveHelpBtn.addEventListener('click', () => setHelpMode(!helpModeEnabled));

document.addEventListener('mouseover', (e) => {
    if (!helpModeEnabled) return;
    const target = e.target.closest('[data-i18n-title]');
    if (target === helpTarget) return;
    if (target) showHelpPopup(target);
    else hideHelpPopup();
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && helpModeEnabled) setHelpMode(false);
});

// Options of the reading-direction select of a synth: an arrow glyph
// per direction (locale-independent), the localized names live in the
// option titles.
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

// ---------- Elements ----------
const loadBtn         = document.querySelector('#load-btn');
const resetBtn        = document.querySelector('#reset-btn');
const rotateBtn       = document.querySelector('#rotate-img-btn');
const cropBtn         = document.querySelector('#crop-img-btn');
const transformBtn    = document.querySelector('#transform-img-btn');
const showOriginalBtn = document.querySelector('#show-original-btn');
const preview         = document.querySelector('#preview');
const previewCanvas   = document.querySelector('#processed-preview');
const viewerEmpty     = document.querySelector('#viewer-empty');
const pixelOverlay    = document.querySelector('#pixel-overlay');
const cursorOverlay   = document.querySelector('#cursor-overlay');

const gridSlider      = document.querySelector('#grid-width');
const gridValue       = document.querySelector('#grid-width-value');

const vibrance        = document.querySelector('#vibrance');
const vibranceValue   = document.querySelector('#vibrance-value');
const contrast        = document.querySelector('#contrast');
const contrastValue   = document.querySelector('#contrast-value');
const brightness      = document.querySelector('#brightness');
const brightnessValue = document.querySelector('#brightness-value');
const posterize       = document.querySelector('#posterize');
const posterizeValue  = document.querySelector('#posterize-value');
const texture         = document.querySelector('#texture');
const textureValue    = document.querySelector('#texture-value');
const clarity         = document.querySelector('#clarity');
const clarityValue    = document.querySelector('#clarity-value');
const simplify        = document.querySelector('#simplify');
const simplifyValue   = document.querySelector('#simplify-value');
const autoLevelsBtn   = document.querySelector('#auto-levels-btn');

const dimensionsInfo  = document.querySelector('#dimensions-info');

// Image controls to lock while a synthesizer is playing
// (the "Show original" button is intentionally excluded, and the value
// sliders contrast/brightness/vibrance/posterize/texture/clarity/simplify —
// plus the auto-levels toggle — stay editable: they only change pixel
// values, which the playback step re-reads fresh. The grid width is
// locked: resizing the grid while synths play would move their zones
// and playheads mid-flight; at rest the zones simply stay where they
// are — clipped to the new grid, erased when fully outside)
const imageLockControls = [loadBtn, resetBtn, rotateBtn, cropBtn, transformBtn, gridSlider];

// True while at least one synthesizer is playing
function anySynthPlaying() {
    return synthListBody.querySelectorAll('.synth-play.active').length > 0;
}

// Locks/unlocks image controls depending on whether a synth is playing
function updateImageControlsLockState() {
    const anyPlaying = anySynthPlaying();
    if (anyPlaying) {
        exitCropMode();
        closeTransformPanel();
    }
    imageLockControls.forEach(el => { el.disabled = anyPlaying; });
    document.querySelector('#controls').classList.toggle('locked', anyPlaying);
}

// ---------- Canvas overlay ----------
let gridW = 1; // current grid width in pixels
let gridH = 1; // current grid height in pixels

// Tracks the current cursor per synth for drawing: Map<id, cursor>
const synthCursors = new Map();

// Grid dimensions each cursor was recorded on: Map<id, {w, h}>. The
// column count can change while synths are playing, so a recorded
// cursor can only be decoded (and erased) against the grid it was
// computed on.
const synthCursorGrid = new Map();

// Last tick's muted flag per synth: a muted pixel keeps its recorded
// position and stays drawn, at half opacity (main viewer and mirror
// alike)
const synthCursorMuted = new Map();

function resizeOverlay() {
    pixelOverlay.width  = pixelOverlay.offsetWidth;
    pixelOverlay.height = pixelOverlay.offsetHeight;
    cursorOverlay.width  = cursorOverlay.offsetWidth;
    cursorOverlay.height = cursorOverlay.offsetHeight;
}

// Draws the playhead of a synth. `w`/`h` are the grid dimensions the
// cursor's absolute pixel index was computed on (from the tick payload);
// they match the globals except during a live grid change, where ticks
// emitted after the backend swap can precede the change's response.
function drawSynthPixel(synthId, cursor, muted, w = gridW, h = gridH) {
    if (!hasImage) return;
    const color = synthColors.get(synthId);
    if (!color) return;

    const ctx = cursorOverlay.getContext('2d');

    // Rendered dimensions of the image in the viewer (object-fit: contain)
    const vw = cursorOverlay.width;
    const vh = cursorOverlay.height;
    const imgRatio = w / h;
    const viewRatio = vw / vh;

    let renderW, renderH, offsetX, offsetY;
    if (imgRatio > viewRatio) {
        renderW = vw;
        renderH = vw / imgRatio;
    } else {
        renderH = vh;
        renderW = vh * imgRatio;
    }
    offsetX = (vw - renderW) / 2;
    offsetY = (vh - renderH) / 2;

    const cellW = renderW / w;
    const cellH = renderH / h;

    // Only clear the previous pixel of this synth — decoded against the
    // grid it was recorded on. When that grid is the one that just
    // changed (dims differ), the precise erase is skipped: the change's
    // response wipes the whole cursor layer anyway
    const prev = synthCursors.get(synthId);
    const pg = synthCursorGrid.get(synthId);
    if (prev !== undefined && pg && pg.w === w && pg.h === h) {
        const pc = prev % w;
        const pr = Math.floor(prev / w);
        ctx.clearRect(
            offsetX + pc * cellW - 1,
            offsetY + pr * cellH - 1,
            cellW + 2, cellH + 2
        );
        // Redraw other synths that occupy this pixel
        synthCursors.forEach((c, sid) => {
            if (sid !== synthId && c === prev) drawPixelAt(ctx, sid, c, offsetX, offsetY, cellW, cellH, synthCursorMuted.get(sid), w);
        });
    }

    synthCursors.set(synthId, cursor);
    synthCursorMuted.set(synthId, !!muted);
    synthCursorGrid.set(synthId, { w, h });
    drawPixelAt(ctx, synthId, cursor, offsetX, offsetY, cellW, cellH, muted, w);
    pushMirrorCursors();
}

function drawPixelAt(ctx, synthId, cursor, offsetX, offsetY, cellW, cellH, muted, w = gridW) {
    const color = synthColors.get(synthId);
    if (!color) return;
    drawCursorCell(ctx, { offsetX, offsetY, cellW, cellH, gridW: w }, { color, cursor, muted });
}

// Removes one synth's cursor from the cursor layer: erases its cell and
// repaints the cursors of any other synth sitting on that same cell
function eraseSynthCursor(synthId) {
    const prev = synthCursors.get(synthId);
    const pg = synthCursorGrid.get(synthId);
    synthCursors.delete(synthId);
    synthCursorMuted.delete(synthId);
    synthCursorGrid.delete(synthId);
    pushMirrorCursors();
    if (prev === undefined || !hasImage || !pg || !pg.w || !pg.h) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const ctx = cursorOverlay.getContext('2d');
    const pc = prev % pg.w;
    const pr = Math.floor(prev / pg.w);
    ctx.clearRect(
        offsetX + pc * cellW - 1,
        offsetY + pr * cellH - 1,
        cellW + 2, cellH + 2
    );
    synthCursors.forEach((c, sid) => {
        if (c === prev) drawPixelAt(ctx, sid, c, offsetX, offsetY, cellW, cellH, synthCursorMuted.get(sid));
    });
}

function clearOverlay() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    const cursorCtx = cursorOverlay.getContext('2d');
    cursorCtx.clearRect(0, 0, cursorOverlay.width, cursorOverlay.height);
    synthCursors.clear();
    synthCursorMuted.clear();
    synthCursorGrid.clear();
    pushMirrorCursors();
}

// ---------- Mouse-based zone selection ----------
// Only one synth can be in zone-drawing mode at a time. Three modes:
// - rect:  each rectangle dragged on the image either adds a zone (when
//          it overlaps no existing zone) or removes pixels from the
//          existing zones (when it overlaps one, even partially).
// - lasso: free-hand closed shape. Every pixel inside the traced polygon
//          (boundary included) toggles: unselected becomes selected,
//          selected becomes deselected — except the pixels of the zone
//          under the playhead, which never lose their selection while
//          the synth is playing. Releasing the button closes the shape
//          with a straight line back to the start point.
// - wand:  magic-wand click. Every pixel 4-connected to the clicked one
//          whose color stays within the tolerance (largest per-channel
//          difference, 1–255 on the per-channel 0–255 scale) is flooded,
//          with the same positional semantics as the rectangle: a click
//          on a free pixel adds the flooded region (fusing with any
//          zone it touches), a click on a selected pixel removes the
//          flooded pixels instead. Committed on the click itself: no
//          drag.
// Holding Alt (Option) while using any of the three tools edits the
// manual silences instead of the selection: the same positional (rect,
// wand) / XOR (lasso) semantics apply to the silent pixels among the
// selected ones. A silent pixel is still travelled by the playhead, it
// just sounds nothing — a rest. Silences always live within the
// selection: deselecting a pixel removes its silence.
let zonePickState = null; // { id, btn, mode } while the drawing mode is armed
let zoneDrag = null;      // { id, start, cur, alt } while dragging a rectangle
let lassoDrag = null;    // { id, points: [{x, y} image coords], start: {col, row}, alt } while drawing a lasso
let altHeld = false;      // Alt (Option) key held: silence-editing mode

// Reflects the Alt key state on the overlay (distinct cursor while a
// drawing mode is armed) and refreshes the in-progress preview so it
// switches style the moment Alt is pressed or released mid-drag.
function syncAltPickingUi() {
    pixelOverlay.classList.toggle('picking-silence', altHeld && !!zonePickState);
    if (zoneDrag || lassoDrag) {
        redrawAllHighlights();
        if (zoneDrag) drawZonePreview();
        if (lassoDrag) drawLassoPreview();
    }
}

// Alt can be pressed or released at any time — before starting a drag
// (the mousedown captures it) or in the middle of one (the listeners
// below update the drag live, so the same gesture can switch mode).
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Alt' || altHeld) return;
    altHeld = true;
    if (zoneDrag) zoneDrag.alt = true;
    if (lassoDrag) lassoDrag.alt = true;
    syncAltPickingUi();
});
window.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altHeld) return;
    altHeld = false;
    if (zoneDrag) zoneDrag.alt = false;
    if (lassoDrag) lassoDrag.alt = false;
    syncAltPickingUi();
});
window.addEventListener('blur', () => {
    // The OS may swallow the keyup when the window loses focus
    if (!altHeld) return;
    altHeld = false;
    if (zoneDrag) zoneDrag.alt = false;
    if (lassoDrag) lassoDrag.alt = false;
    syncAltPickingUi();
});

// Does the rectangle overlap (even partially) one of the synth's zones?
// Such a drag removes pixels instead of creating an overlapping zone.
function rectOverlapsZones(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;
    return hi.zones.some(z => zoneIntersectsRect(z, rect));
}

// Normalized grid rect of the zone drag in progress, or null
function zoneDragRect() {
    if (!zoneDrag) return null;
    const { start, cur } = zoneDrag;
    return {
        x: Math.min(start.col, cur.col),
        y: Math.min(start.row, cur.row),
        w: Math.abs(cur.col - start.col) + 1,
        h: Math.abs(cur.row - start.row) + 1,
    };
}

// The zone of this synth containing the played pixel, if any. `w` is
// the grid width the pixel index was computed on (the tick payload).
function zoneAtPixel(id, pixel, w = gridW) {
    if (pixel == null) return null;
    const hi = synthHighlights.get(id);
    if (!hi) return null;
    const col = pixel % w;
    const row = Math.floor(pixel / w);
    return hi.zones.find(z => zoneContains(z, col, row)) || null;
}

// While a synth is playing, the zone under its playhead is locked against
// erasure: an erasing drag that touches it is cancelled, so the pixels
// being played are never removed under the cursor. Returns true when the
// drag has just been cancelled.
function cancelEraseDragOnLockedZone(id, playheadPixel, gridWidth = gridW) {
    if (!zoneDrag || zoneDrag.id !== id) return false;
    // A silence drag never removes pixels from the sequence: the locked
    // zone is safe, the playhead keeps travelling over the silent pixels
    if (zoneDrag.alt) return false;
    const rect = zoneDragRect();
    if (!rect || !rectOverlapsZones(id, rect)) return false;
    const locked = zoneAtPixel(id, playheadPixel, gridWidth);
    if (locked && zoneIntersectsRect(locked, rect)) {
        zoneDrag = null;
        redrawAllHighlights();
        return true;
    }
    return false;
}

function cellFromClientPoint(clientX, clientY) {
    const layout = getImageLayout();
    if (!layout) return null;
    const rect = pixelOverlay.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left - layout.offsetX) / layout.cellW);
    const row = Math.floor((clientY - rect.top - layout.offsetY) / layout.cellH);
    if (col < 0 || row < 0 || col >= gridW || row >= gridH) return null;
    return { col, row };
}

function startZonePicking(id, btn, mode = 'rect') {
    // Cancel any drawing mode already active on another synth (or in
    // another mode on the same one)
    if (zonePickState && (zonePickState.id !== id || zonePickState.mode !== mode)) {
        cancelZonePicking();
    }
    zonePickState = { id, btn, mode };
    btn.classList.add('active');
    // The tolerance input only shows while the magic-wand mode is armed
    // on this card
    if (mode === 'wand') btn.closest('.synth-block')?.classList.add('wand-armed');
    pixelOverlay.classList.add('picking');
    syncAltPickingUi(); // reflect the Alt key if it is already held
    // Editing blind is confusing: arming the picking mode reveals this
    // synth's zones (they may be hidden during playback). The eye button
    // reflects it; the user can hide them again at any time.
    const hi = synthHighlights.get(id);
    if (hi && !hi.visible) {
        hi.visible = true;
        hi._wasVisible = true; // keep the zones visible after a stop too
        syncEyeButton(btn.closest('.synth-block'), true);
        redrawAllHighlights();
    }
}

function cancelZonePicking() {
    if (!zonePickState) return;
    zonePickState.btn.classList.remove('active');
    zonePickState.btn.closest('.synth-block')?.classList.remove('wand-armed');
    pixelOverlay.classList.remove('picking');
    pixelOverlay.classList.remove('picking-silence');
    zonePickState = null;
    const hadDrag = !!zoneDrag || !!lassoDrag;
    zoneDrag = null;
    lassoDrag = null;
    if (hadDrag) redrawAllHighlights();
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        exitCropMode();
        closeTransformPanel();
        cancelZonePicking();
    }
});

pixelOverlay.addEventListener('mousedown', (e) => {
    if (cropMode) {
        if (!hasImage) return;
        e.preventDefault(); // prevents image dragging during selection
        const rect = pixelOverlay.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const target = cropDragTargetAt(px, py);
        if (target.kind === 'new') {
            cropDrag = { kind: 'new', handle: null, startX: px, startY: py, orig: null };
            cropRect = { x: px, y: py, w: 0, h: 0 };
        } else {
            // Moving or resizing keeps the frame grabbed at press
            cropDrag = {
                kind: target.kind,
                handle: target.handle,
                startX: px,
                startY: py,
                orig: { ...cropRect },
            };
        }
        drawCropOverlay();
        return;
    }
    if (!zonePickState || !hasImage) return;
    const cell = cellFromClientPoint(e.clientX, e.clientY);
    if (!cell) return;
    e.preventDefault(); // prevents image dragging during selection
    if (zonePickState.mode === 'lasso') {
        const pt = imagePointFromClient(e.clientX, e.clientY);
        lassoDrag = { id: zonePickState.id, points: [pt], start: cell, alt: e.altKey || altHeld };
    } else if (zonePickState.mode === 'wand') {
        // The wand commits on the click itself — no drag state, so the
        // mousemove/mouseup listeners stay no-ops. The tolerance is read
        // from the armed card's input at click time.
        const card = zonePickState.btn.closest('.synth-block');
        const raw = parseInt(card?.querySelector('.magic-wand-tolerance')?.value, 10);
        const tolerance = Math.max(1, Math.min(255, Number.isFinite(raw) ? raw : 32));
        const toggled = (e.altKey || altHeld)
            ? wandToggleMutePixels(zonePickState.id, cell, tolerance)
            : wandTogglePixels(zonePickState.id, cell, tolerance);
        if (toggled) redrawAllHighlights();
        return;
    } else {
        zoneDrag = { id: zonePickState.id, start: cell, cur: cell, alt: e.altKey || altHeld };
    }
});

pixelOverlay.addEventListener('mousemove', (e) => {
    if (cropMode && !cropDrag) {
        // Hover feedback: the cursor hints at what a press would grab
        const rect = pixelOverlay.getBoundingClientRect();
        const target = cropDragTargetAt(e.clientX - rect.left, e.clientY - rect.top);
        pixelOverlay.style.cursor = target.kind === 'move' ? 'move'
            : target.kind === 'resize' ? CROP_HANDLE_CURSORS[target.handle]
            : 'crosshair';
    }
    if (cropDrag) {
        const rect = pixelOverlay.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        cropRect = updateCropDrag(cx, cy);
        drawCropOverlay();
        return;
    }
    if (!zoneDrag && !lassoDrag) return;
    if (lassoDrag) {
        const pt = imagePointFromClient(e.clientX, e.clientY);
        // Ignore duplicate consecutive points (same mousemove batch)
        const last = lassoDrag.points[lassoDrag.points.length - 1];
        if (!last || pt.x !== last.x || pt.y !== last.y) {
            lassoDrag.points.push(pt);
            redrawAllHighlights();
            drawLassoPreview();
        }
        return;
    }
    const cell = cellFromClientPoint(e.clientX, e.clientY);
    if (!cell) return;
    zoneDrag.cur = cell;
    // Cancel an erasing drag as soon as it grows over the zone under the
    // playhead (checked again on every playback tick)
    if (cancelEraseDragOnLockedZone(zoneDrag.id, synthCursors.get(zoneDrag.id), synthCursorGrid.get(zoneDrag.id)?.w)) return;
    redrawAllHighlights();
    drawZonePreview();
});

window.addEventListener('mouseup', (e) => {
    if (cropDrag) {
        const wasNewFrame = cropDrag.kind === 'new';
        cropDrag = null;
        // A degenerate rect (simple click, no real drag) is discarded
        if (wasNewFrame && cropRect && cropRect.w < 3 && cropRect.h < 3) cropRect = null;
        cropApplyBtn.disabled = !cropRect;
        drawCropOverlay();
        return;
    }
    if (!zoneDrag && !lassoDrag) return;
    if (lassoDrag) {
        const { id, points, start, alt } = lassoDrag;
        lassoDrag = null;
        // Close the shape with a straight line back to the start, then
        // toggle every enclosed pixel (boundary included): the selection,
        // or the silences when Alt is held
        if (points.length > 0) {
            const toggled = alt
                ? lassoToggleMutePixels(id, points, start)
                : lassoTogglePixels(id, points, start);
            if (toggled) redrawAllHighlights();
        }
        return;
    }
    const { id, alt } = zoneDrag;
    const rect = zoneDragRect();
    // Cancel an erasing drag touching the locked zone (the one under the
    // playhead) instead of committing it — a no-op in silence mode
    const cancelled = cancelEraseDragOnLockedZone(id, synthCursors.get(id), synthCursorGrid.get(id)?.w);
    zoneDrag = null;
    if (!cancelled && rect) {
        // A rectangle overlapping an existing zone (even partially) only
        // removes pixels; it never creates an overlapping zone. A single
        // pixel works too: a click on a free pixel selects it, a click on
        // a selected pixel deselects it. Alt mirrors this on the manual
        // silences: overlap removes silences, free space adds them (the
        // silences are clipped to the selection).
        if (alt) {
            if (rectOverlapsMuteZones(id, rect)) removeSynthMuteRect(id, rect);
            else                                 addSynthMuteRect(id, rect);
        } else if (rectOverlapsZones(id, rect)) removeSynthZoneRect(id, rect);
        else                                    addSynthZone(id, rect);
    }
    redrawAllHighlights();
});

// Live preview of the rectangle being dragged: filled with the synth's
// color while it overlaps no zone, "erasing" the highlights beneath it
// as soon as it touches one — the drag then removes pixels instead. In
// silence mode (Alt) the preview is a black veil with a dashed outline:
// same positional semantics as the selection, but it never reads as a
// zone edit.
function drawZonePreview() {
    if (!zoneDrag) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const { start, cur } = zoneDrag;
    const x = Math.min(start.col, cur.col);
    const y = Math.min(start.row, cur.row);
    const w = Math.abs(cur.col - start.col) + 1;
    const h = Math.abs(cur.row - start.row) + 1;
    const rect = { x, y, w, h };

    const ctx = pixelOverlay.getContext('2d');
    ctx.save();
    if (zoneDrag.alt) {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = 'black';
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    } else if (rectOverlapsZones(zoneDrag.id, rect)) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    } else {
        ctx.fillStyle = synthColors.get(zoneDrag.id) || '#ffffff';
        ctx.globalAlpha = 0.4;
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    }
    ctx.restore();
}

// ---------- Lasso (free-hand zone selection) ----------

// Continuous image coordinates (in grid cells, fractional) of a mouse
// event, so the traced shape isn't quantized to cell corners.
function imagePointFromClient(clientX, clientY) {
    const layout = getImageLayout();
    const rect = pixelOverlay.getBoundingClientRect();
    return {
        x: (clientX - rect.left - layout.offsetX) / layout.cellW,
        y: (clientY - rect.top - layout.offsetY) / layout.cellH,
    };
}

// Even-odd point-in-polygon test on the closed shape.
function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if ((yi > py) !== (yj > py) &&
            px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

// Cells whose center the segment (x0,y0)→(x1,y1) passes through, added
// to `out` as "col,row" keys (Bresenham over cell centers' grid, so the
// traced boundary counts as enclosed).
function addSegmentCells(x0, y0, x1, y1, out) {
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    x1 = Math.floor(x1); y1 = Math.floor(y1);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
        out.add(`${x0},${y0}`);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 <  dx) { err += dx; y0 += sy; }
    }
}

// Live preview of the lasso shape: the traced polygon, closed back to
// its start point, filled with the synth's color — black with a dashed
// white outline in silence mode (Alt).
function drawLassoPreview() {
    if (!lassoDrag || lassoDrag.points.length < 1) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const ctx = pixelOverlay.getContext('2d');
    ctx.save();
    ctx.beginPath();
    lassoDrag.points.forEach((pt, i) => {
        const px = offsetX + pt.x * cellW;
        const py = offsetY + pt.y * cellH;
        if (i === 0) ctx.moveTo(px, py);
        else          ctx.lineTo(px, py);
    });
    ctx.closePath(); // straight line back to the start point
    if (lassoDrag.alt) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = 'black';
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
    } else {
        ctx.fillStyle = synthColors.get(lassoDrag.id) || '#ffffff';
        ctx.globalAlpha = 0.35;
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    ctx.restore();
}

// Computes every pixel enclosed by the lasso polygon: polygon interior
// (cell centers) ∪ boundary cells (Bresenham), including the closing line
// from the release point back to the start. Returned as "col,row" keys.
function lassoEnclosedCells(points, start) {
    // Closed polygon in continuous coordinates; the closing segment is
    // the straight line back to the start cell's center.
    const poly = points.slice();
    poly.push({ x: start.col + 0.5, y: start.row + 0.5 });
    // Single point (simple click): degenerate polygon, nothing enclosed —
    // handled below by the boundary-only path.
    if (points.length === 1) {
        poly.push({ x: points[0].x, y: points[0].y + 0.01 });
    }

    // Bounding box (clamped to the grid): only cells inside can toggle
    const xs = poly.map(p => p.x);
    const ys = poly.map(p => p.y);
    const minCol = Math.max(0, Math.floor(Math.min(...xs)));
    const maxCol = Math.min(gridW - 1, Math.ceil(Math.max(...xs)));
    const minRow = Math.max(0, Math.floor(Math.min(...ys)));
    const maxRow = Math.min(gridH - 1, Math.ceil(Math.max(...ys)));

    // Enclosed cells = polygon interior (cell centers) ∪ boundary cells
    const enclosed = new Set();
    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            if (pointInPolygon(col + 0.5, row + 0.5, poly)) {
                enclosed.add(`${col},${row}`);
            }
        }
    }
    for (let i = 1; i < poly.length; i++) {
        addSegmentCells(poly[i - 1].x, poly[i - 1].y, poly[i].x, poly[i].y, enclosed);
    }
    return enclosed;
}

// Flood fill for the magic wand: every cell 4-connected to the clicked
// one whose color stays within `tolerance` of the clicked cell's color
// (edge adjacency like everywhere else — a corner touch is NOT
// contiguous). The color distance is the largest per-channel difference
// (Chebyshev) on the 0–255 scale, the tolerance input (1–255) being that
// difference directly. Returned as "col,row" keys.
function wandFloodCells(startCell, tolerance) {
    const { rgba } = processedPixels;
    const seedIdx = (startCell.row * gridW + startCell.col) * 4;
    const sr = rgba[seedIdx], sg = rgba[seedIdx + 1], sb = rgba[seedIdx + 2];
    const limit = tolerance;
    const flooded = new Set([`${startCell.col},${startCell.row}`]);
    const queue = [startCell];
    while (queue.length > 0) {
        const { col, row } = queue.pop();
        for (const [nx, ny] of [[col + 1, row], [col - 1, row], [col, row + 1], [col, row - 1]]) {
            if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
            const key = `${nx},${ny}`;
            if (flooded.has(key)) continue;
            const i = (ny * gridW + nx) * 4;
            if (Math.max(
                Math.abs(rgba[i] - sr),
                Math.abs(rgba[i + 1] - sg),
                Math.abs(rgba[i + 2] - sb),
            ) > limit) continue;
            flooded.add(key);
            queue.push({ col: nx, row: ny });
        }
    }
    return flooded;
}

// Lasso on the selection: every pixel enclosed by the traced polygon
// (boundary included, closure line from the release point back to the
// start) toggles — unselected becomes selected, selected becomes
// deselected. Pixels of the zone under the playhead (while the synth
// plays) are exempt from deselection. Returns true when the selection
// changed.
function lassoTogglePixels(id, points, start) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const enclosed = lassoEnclosedCells(points, start);
    if (enclosed.size === 0) return false;

    // Zone under the playhead: its pixels never lose their selection
    const locked = zoneAtPixel(id, synthCursors.get(id));

    // Current selection as a cell set
    const selected = cellSetFromZones(hi.zones);

    // Toggle each enclosed pixel (XOR), skipping locked pixels that would
    // be deselected
    let changed = false;
    for (const key of enclosed) {
        const isSelected = selected.has(key);
        if (isSelected) {
            const [col, row] = key.split(',').map(Number);
            if (locked && zoneContains(locked, col, row)) {
                continue; // exempt from deselection
            }
            selected.delete(key);
            changed = true;
        } else {
            selected.add(key);
            changed = true;
        }
    }
    if (!changed) return false;

    // Rebuild the selection as connected components with inherited
    // creation orders
    hi.zones = rebuildZones(hi.zones, selected);
    sendSynthZones(id);
    // Deselected pixels lose their silence
    clipMuteZonesToSelection(id);
    updateZonesLabel(id);
    return true;
}

// Lasso on the manual silences (Alt held): every enclosed selected pixel
// toggles — played becomes silent, silent becomes played. Pixels that
// are not selected are ignored (a silence always lives inside the
// selection). Returns true when the silences changed.
function lassoToggleMutePixels(id, points, start) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const enclosed = lassoEnclosedCells(points, start);
    if (enclosed.size === 0) return false;

    const selected = cellSetFromZones(hi.zones);
    const muted = muteCellSet(hi);

    let changed = false;
    for (const key of enclosed) {
        if (!selected.has(key)) continue; // silences live in the selection
        if (muted.has(key)) {
            muted.delete(key);
            changed = true;
        } else {
            muted.add(key);
            changed = true;
        }
    }
    if (!changed) return false;

    hi.muteZones = rebuildZones(hi.muteZones, muted);
    sendSynthMuteZones(id);
    return true;
}

// Magic wand on the selection: positional semantics, like the rectangle.
// A click on an unselected pixel adds the whole flooded region (every
// pixel 4-connected to the clicked one whose color stays within the
// tolerance) — already-selected pixels are left untouched, and a flooded
// region touching an existing zone fuses with it. A click on a selected
// pixel removes the flooded pixels instead — except the pixels of the
// zone under the playhead, which never lose their selection while the
// synth plays. Returns true when the selection changed.
function wandTogglePixels(id, startCell, tolerance) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const flooded = wandFloodCells(startCell, tolerance);
    const seedKey = `${startCell.col},${startCell.row}`;

    // Current selection as a cell set
    const selected = cellSetFromZones(hi.zones);

    if (!selected.has(seedKey)) {
        // Free seed: pure addition — the union is rebuilt as connected
        // components, so a flooded region touching an existing zone
        // fuses with it (contiguity is one zone)
        for (const key of flooded) selected.add(key);
        hi.zones = rebuildZones(hi.zones, selected);
        sendSynthZones(id);
        updateZonesLabel(id);
        return true;
    }

    // Zone under the playhead: its pixels never lose their selection
    const locked = zoneAtPixel(id, synthCursors.get(id));

    // Selected seed: remove every flooded pixel, skipping the locked
    // ones
    let changed = false;
    for (const key of flooded) {
        const [col, row] = key.split(',').map(Number);
        if (locked && zoneContains(locked, col, row)) {
            continue; // exempt from deselection
        }
        if (selected.delete(key)) changed = true;
    }
    if (!changed) return false;

    // Rebuild the selection as connected components with inherited
    // creation orders
    hi.zones = rebuildZones(hi.zones, selected);
    sendSynthZones(id);
    // Deselected pixels lose their silence
    clipMuteZonesToSelection(id);
    updateZonesLabel(id);
    return true;
}

// Magic wand on the manual silences (Alt held): positional semantics,
// like the Alt rectangle. A click on a played pixel silences every
// flooded pixel that belongs to the selection; a click on a silent
// pixel unsilences the flooded silent ones instead. Pixels that are
// not selected are ignored either way (a silence always lives inside
// the selection). Returns true when the silences changed.
function wandToggleMutePixels(id, startCell, tolerance) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const flooded = wandFloodCells(startCell, tolerance);
    const seedKey = `${startCell.col},${startCell.row}`;

    const selected = cellSetFromZones(hi.zones);
    const muted = muteCellSet(hi);

    let changed = false;
    if (!muted.has(seedKey)) {
        // Played seed: silence every flooded pixel of the selection
        for (const key of flooded) {
            if (!selected.has(key)) continue; // silences live in the selection
            if (muted.add(key)) changed = true;
        }
    } else {
        // Silent seed: unsilence every flooded silent pixel
        for (const key of flooded) {
            if (muted.delete(key)) changed = true;
        }
    }
    if (!changed) return false;

    hi.muteZones = rebuildZones(hi.muteZones, muted);
    sendSynthMuteZones(id);
    return true;
}

// Adds a rectangle (or single cell) to a synth's selection: the exact
// cell union is rebuilt as connected components — a rectangle touching
// an existing zone fuses with it (contiguity is one zone), a disjoint
// one becomes a fresh zone with a new creation order.
function addSynthZone(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const cells = zoneCellSet(hi.zones);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            cells.add(`${col},${row}`);
        }
    }
    hi.zones = rebuildZones(hi.zones, cells);
    sendSynthZones(id);
    updateZonesLabel(id);
}

// Subtracts a rectangle from the synth's zones: the exact difference is
// rebuilt as connected components, so a zone cut in the middle splits
// into two fragments that both keep its creation order. Deselected
// pixels lose their silence.
function removeSynthZoneRect(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const cells = zoneCellSet(hi.zones);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            cells.delete(`${col},${row}`);
        }
    }
    hi.zones = rebuildZones(hi.zones, cells);
    sendSynthZones(id);
    // Deselected pixels lose their silence
    clipMuteZonesToSelection(id);
    updateZonesLabel(id);
}

function sendSynthZones(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    invoke('set_synth_zones', { id, zones: hi.zones })
        .catch(err => console.error('Error in set_synth_zones:', err));
}

// ---------- Manual silences (Alt + square/lasso) ----------
// Silent pixels chosen by hand among the selected ones: the playhead
// still travels over them, but no note is sounded (a rest). They are
// stored as connected components, like the selection, and always
// clipped to it: deselecting a pixel removes its silence.

// Builds the set of manually silenced cells of a synth from its mute
// zones.
function muteCellSet(hi) {
    return cellSetFromZones(hi.muteZones);
}

// Does the rectangle overlap (even partially) one of the synth's mute
// zones? Such an Alt-drag removes silences instead of adding them.
function rectOverlapsMuteZones(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;
    return hi.muteZones.some(z => zoneIntersectsRect(z, rect));
}

// Adds a silence rectangle (Alt + square over free space): the dragged
// rectangle silences the selected pixels it covers; touching silence
// components fuse, like the selection.
function addSynthMuteRect(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const selected = cellSetFromZones(hi.zones);
    const cells = muteCellSet(hi);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            const key = `${col},${row}`;
            if (selected.has(key)) cells.add(key);
        }
    }
    hi.muteZones = rebuildZones(hi.muteZones, cells);
    sendSynthMuteZones(id);
}

// Subtracts a silence rectangle (Alt + square over an existing silence):
// exact difference, components recomposed.
function removeSynthMuteRect(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const cells = muteCellSet(hi);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            cells.delete(`${col},${row}`);
        }
    }
    hi.muteZones = rebuildZones(hi.muteZones, cells);
    sendSynthMuteZones(id);
}

// Re-clips the mute zones to the current selection — the silences only
// ever live inside it — and pushes the result to the backend when it
// actually changed.
function clipMuteZonesToSelection(id) {
    const hi = synthHighlights.get(id);
    if (!hi || hi.muteZones.length === 0) return;
    const selected = cellSetFromZones(hi.zones);
    const muted = muteCellSet(hi);
    const kept = new Set([...muted].filter(k => selected.has(k)));
    if (kept.size === muted.size) return; // nothing deselected
    hi.muteZones = rebuildZones(hi.muteZones, kept);
    sendSynthMuteZones(id);
}

function sendSynthMuteZones(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    invoke('set_synth_mute_zones', { id, zones: hi.muteZones })
        .catch(err => console.error('Error in set_synth_mute_zones:', err));
}

// Sends the note-range filter states: one triplet (bass, medium, treble)
// for the monophonic note, and one per R/G/B voice in polyphonic mode.
function sendSynthNoteRanges(id, el) {
    const read = group => ['bass', 'medium', 'treble'].map(kind =>
        group.querySelector(`.synth-${kind}`).classList.contains('active')
    );
    const mono = read(el.querySelector('.synth-mode-panel-mono .synth-note-range'));
    const voices = Array.from(el.querySelectorAll('.synth-mode-panel-poly .synth-note-range'))
        .map(read);
    invoke('set_synth_note_ranges', { id, mono, voices })
        .catch(err => console.error('Error in set_synth_note_ranges:', err));
}
// Sends the enabled note lengths ("whole", "half", "quarter", "eighth",
// "sixteenth"). The UI always keeps at least one button active.
function sendSynthNoteLengths(id, el) {
    const lengths = Array.from(el.querySelectorAll('.note-length-btn.active'))
        .map(btn => btn.dataset.length);
    invoke('set_synth_note_lengths', { id, lengths })
        .catch(err => console.error('Error in set_synth_note_lengths:', err));
}

// Number of pixels a synth will play: the exact count of its zones'
// cells, 0 when no zone is selected. With the exact component model the
// count matches the backend's sequence length (the historical rectangle
// model double-counted overlaps).
function synthSequenceLength(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return 0;
    return zonesPixelCount(hi.zones);
}

// "zones-val" shows the number of selected pixels for the synth.
function updateZonesLabel(id) {
    const el = synthElementById(id);
    if (!el) return;
    const zonesVal = el.querySelector('.zones-val');

    if (!hasImage) {
        zonesVal.textContent = '-';
        return;
    }

    const pixelCount = synthSequenceLength(id);
    zonesVal.textContent = pixelCount > 0 ? `${pixelCount} px` : '0 px';
}

function updateAllSynthZonesLabels() {
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        updateZonesLabel(Number(el.dataset.synthId));
    });
}

// Computes the render dimensions of the image in the viewer (object-fit:
// contain). Thin binding of the shared renderer on the main window's
// overlay canvas, so every call site keeps the same signature.
function getImageLayout() {
    return computeLayout(pixelOverlay.width, pixelOverlay.height, gridW, gridH);
}

// Refreshes the stored brightness bounds of a synth from its sliders and
// redraws the highlights: muted-pixel marks depend on the bounds.
function updateBrightnessBounds(id) {
    const el = synthElementById(id);
    if (!el) return;
    const bounds = synthBrightnessBounds.get(id);
    if (!bounds) return;
    bounds.min = Number(el.querySelector('.brightness-start').value);
    bounds.max = Number(el.querySelector('.brightness-end').value);
    redrawAllHighlights();
}

// Mute cells of a synth: pixels outside its brightness window plus the
// manually silenced ones, precomputed so the mirror window can render
// the marks without needing the processed pixel buffer.
function computeMuteCells(synthId, hi) {
    const muteCells = new Set();
    const bounds = synthBrightnessBounds.get(synthId);
    if (bounds && processedPixels && (bounds.min > 0 || bounds.max < 127)) {
        const { width: pw, rgba } = processedPixels;
        for (const z of hi.zones) {
            for (const r of z.runs) {
                for (let col = r.x0; col <= r.x1; col++) {
                    const i = (r.y * pw + col) * 4;
                    if (i + 2 >= rgba.length) continue; // torn zone edge
                    const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
                    const level = Math.round(luma / 255 * 127);
                    if (level >= bounds.min && level <= bounds.max) continue;
                    muteCells.add(`${col},${r.y}`);
                }
            }
        }
    }
    // Manually silenced pixels: they always live within the selection
    if (hi.muteZones.length > 0) {
        const selected = cellSetFromZones(hi.zones);
        for (const key of muteCellSet(hi)) {
            if (selected.has(key)) muteCells.add(key);
        }
    }
    return muteCells;
}

function drawRangeHighlight(synthId) {
    const hi = synthHighlights.get(synthId);
    if (!hi || !hi.visible) return;
    const layout = getImageLayout();
    if (!layout) return;
    const color = synthColors.get(synthId);
    if (!color) return;

    drawZones(pixelOverlay.getContext('2d'), layout, {
        color,
        zones: hi.zones,
        muteCells: computeMuteCells(synthId, hi),
    });
}

function clearRangeHighlight(synthId) {
    // We redraw the whole canvas from scratch (safer than targeting individual areas)
    redrawAllHighlights();
}

function redrawAllHighlights() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    // Cursors live on their own layer (#cursor-overlay): they survive
    // zone redraws and no longer need to be repositioned here
    synthHighlights.forEach((_, sid) => drawRangeHighlight(sid));
    pushMirrorZones();
}

// ---------- Color channel preview (hovering the R/G/B buttons) ----------
// channelIndex: 0 = red, 1 = green, 2 = blue
// The preview is rendered in grayscale rather than tinted with the channel's
// color, so luminosities can be compared at a glance between layers.

function drawChannelOverlay(channelIndex) {
    if (!hasImage || !processedPixels) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, renderW, renderH } = layout;
    const { width, height, rgba } = processedPixels;
    if (!width || !height) return;

    // Build an offscreen canvas at the grid's resolution, where each pixel
    // reflects the intensity of the chosen channel as a gray level.
    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d');
    const imageData = offCtx.createImageData(width, height);

    for (let i = 0; i < width * height; i++) {
        const value = rgba[i * 4 + channelIndex];
        const o = i * 4;
        imageData.data[o]     = value;
        imageData.data[o + 1] = value;
        imageData.data[o + 2] = value;
        imageData.data[o + 3] = 255;
    }
    offCtx.putImageData(imageData, 0, 0);

    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offCanvas, offsetX, offsetY, renderW, renderH);
    ctx.restore();
}

function hideChannelOverlay() {
    redrawAllHighlights();
}

new ResizeObserver(() => {
    resizeOverlay();
    clearOverlay();
    if (cropMode) {
        // The overlay was resized: overlay pixels changed meaning, re-fit the
        // frame inside the image bounds (ratio re-applied when locked)
        if (cropRect) cropRect = cropRatio ? applyCropRatioToRect(cropRect) : clampCropRect(cropRect);
        drawCropOverlay();
    }
    else if (transformActive) redrawTransformOverlay();
    else {
        // Resizing the canvases wiped their content: the persistent
        // highlights must be repainted — without this, any layout
        // change (window resize, synth list growing past the fold — a
        // session load reflows the page) erases the zones until the
        // next edit. Active playheads come back on the next tick.
        redrawAllHighlights();
    }
}).observe(pixelOverlay);

// ---------- State ----------
let hasImage      = false;
let origWidth     = 0;
let origHeight    = 0;
let originalPng   = null;       // base64 PNG of the original image
let processedPixels = null;     // { width, height, rgba } of the last processed render
let totalPixels   = 0;          // total number of pixels in the current grid

// Colors offered for the synths (palette configurable in config.json,
// replaced at startup by the value from get_config)
let SYNTH_COLORS = [
    '#ff2f2f', '#ff8c00', '#ffc300', '#b6f000',
    '#00e884', '#00d5b8', '#432fff', '#7d2fd4',
    '#b42fd4', '#ea2bd9', '#ff2f92', '#ff2f5d',
];

// Bounds (low, high) of the bass / medium / treble note-range filters,
// in MIDI note numbers (configurable in config.json, replaced at startup
// by the value from get_config)
let NOTE_RANGE_BOUNDS = [[21, 47], [48, 71], [72, 108]];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Scales offered for note quantization: values match the backend's Scale
// enum (serde camelCase). Chromatic = no quantization (default).
const SCALE_OPTIONS = [
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

// Scales enabled in the global config (config.json, applied at the next
// start): the per-synth scale selects only offer these. Chromatic is
// always enabled — it is the "no quantification" default.
let ENABLED_SCALES = new Set(SCALE_OPTIONS.map(o => o.value));

// Options markup for a scale select: the enabled scales, plus a ghost
// option for `activeScale` when it is globally disabled — a synth using
// it keeps its value, the config never corrupts a synth's state.
function scaleOptionsHtml(activeScale) {
    const shown = SCALE_OPTIONS.filter(o => ENABLED_SCALES.has(o.value));
    if (activeScale && !ENABLED_SCALES.has(activeScale)) {
        const ghost = SCALE_OPTIONS.find(o => o.value === activeScale);
        if (ghost) shown.push(ghost);
    }
    return shown.map(o => `<option value="${o.value}">${t(o.key)}</option>`).join('');
}

// Rebuilds a synth card's scale selects from the enabled-scales config,
// keeping each select's current value (ghost option included)
function refreshScaleSelects(el) {
    el.querySelectorAll('.synth-scale').forEach(sel => {
        const current = sel.value || 'chromatic';
        sel.innerHTML = scaleOptionsHtml(current);
        sel.value = current;
    });
}

function midiNoteName(n) {
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

// Tooltip of the bass / medium / treble buttons, built from the
// configured bounds (the values are user-configurable, they cannot be
// hardcoded in the i18n files)
function applyNoteRangeTitles(el) {
    [
        ['bass',    'synth.noteRangeBass'],
        ['medium',  'synth.noteRangeMedium'],
        ['treble',  'synth.noteRangeTreble'],
    ].forEach(([kind, key], i) => {
        const [lo, hi] = NOTE_RANGE_BOUNDS[i];
        const params = { lowName: midiNoteName(lo), highName: midiNoteName(hi), low: lo, high: hi };
        el.querySelectorAll(`.synth-${kind}`).forEach(btn => { btn.title = t(key, params); });
    });
}

// Map id → current color
const synthColors = new Map();

// Map id → { visible: bool, start: number, end: number }
const synthHighlights = new Map();

// Brightness bounds per synth (id → {min, max}), mirroring the backend's
// threshold so the UI can mark pixels outside the range as muted without
// asking the backend for each cell.
const synthBrightnessBounds = new Map();

const SLIDER_STEPS = 1000;
const MIN_CELLS    = 2;

// ---------- Logarithmic scale ----------
function sliderToCells(v, maxCells) {
  if (!maxCells || maxCells < MIN_CELLS) return MIN_CELLS;
  const lmin = Math.log(MIN_CELLS);
  const lmax = Math.log(maxCells);
  const cells = Math.round(Math.exp(lmin + (lmax - lmin) * (v / SLIDER_STEPS)));
  return Number.isFinite(cells)
    ? Math.min(maxCells, Math.max(MIN_CELLS, cells))
    : MIN_CELLS;
}

function currentGridWidth() {
  return sliderToCells(Number(gridSlider.value), origWidth);
}

// Inverse of sliderToCells: the slider position that maps to the given
// column count. The logarithmic mapping rounds cells at every step, so
// the analytic position is walked until it lands exactly on the count —
// or on the nearest reachable one at the top of the range, where one
// slider step spans several columns.
function cellsToSlider(cells, maxCells) {
  if (!maxCells || maxCells < MIN_CELLS) return SLIDER_STEPS;
  const lmin = Math.log(MIN_CELLS);
  const lmax = Math.log(maxCells);
  let v = Math.round(((Math.log(cells) - lmin) / (lmax - lmin)) * SLIDER_STEPS);
  v = Math.min(SLIDER_STEPS, Math.max(0, v));
  if (sliderToCells(v, maxCells) < cells) {
    while (v < SLIDER_STEPS && sliderToCells(v, maxCells) < cells) v++;
  } else {
    while (v > 0 && sliderToCells(v, maxCells) > cells) v--;
  }
  return v;
}

// ---------- Posterize scale ----------
// Position 0 = off; positions 1..SLIDER_STEPS map linearly from
// POSTERIZE_MAX_LEVELS levels (left) down to POSTERIZE_MIN_LEVELS (right).
const POSTERIZE_MIN_LEVELS = 2;
const POSTERIZE_MAX_LEVELS = 64;

function sliderToPosterizeLevels(v) {
  if (v <= 0) return null; // off
  const t = (v - 1) / (SLIDER_STEPS - 1); // 0 at the first notch, 1 at the far right
  const levels = Math.round(POSTERIZE_MAX_LEVELS - t * (POSTERIZE_MAX_LEVELS - POSTERIZE_MIN_LEVELS));
  return Math.min(POSTERIZE_MAX_LEVELS, Math.max(POSTERIZE_MIN_LEVELS, levels));
}

function posterizeLevelsToSlider(levels) {
  if (levels == null || levels <= 1) return 0; // off
  // Sessions saved when the maximum was 255 may hold higher values:
  // clamp them to the weakest reachable position (the first notch)
  levels = Math.min(POSTERIZE_MAX_LEVELS, Math.max(POSTERIZE_MIN_LEVELS, levels));
  const t = (POSTERIZE_MAX_LEVELS - levels) / (POSTERIZE_MAX_LEVELS - POSTERIZE_MIN_LEVELS);
  let v = Math.round(t * (SLIDER_STEPS - 1)) + 1;
  v = Math.min(SLIDER_STEPS, Math.max(1, v));
  // The analytic position may round to a neighbor: nudge it until the
  // forward mapping gives back exactly `levels`
  while (v < SLIDER_STEPS && sliderToPosterizeLevels(v) > levels) v++;
  while (v > 1 && sliderToPosterizeLevels(v - 1) < levels) v--;
  return v;
}

// ---------- Settings ----------
function buildParams() {
  return {
    grid_width:       currentGridWidth(),
    grid_height:      null,              // always deduced from the ratio
    contrast:         Number(contrast.value),
    brightness:       Number(brightness.value),
    vibrance:         Number(vibrance.value),
    posterize_levels: sliderToPosterizeLevels(Number(posterize.value)),
    texture:          Number(texture.value),
    clarity:          Number(clarity.value),
    simplify:         Number(simplify.value),
    auto_levels:      autoLevelsBtn.classList.contains('active'),
  };
}

// ---------- Display ----------
// Decodes the raw IPC format sent by the backend: 8-byte header
// (width and height as little-endian u32) followed by flat RGBA bytes.
function decodePixelResponse(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    return {
        width,
        height,
        rgba: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, width * height * 4),
    };
}

function paintPreviewCanvas(pixels) {
    if (previewCanvas.width !== pixels.width) previewCanvas.width = pixels.width;
    if (previewCanvas.height !== pixels.height) previewCanvas.height = pixels.height;
    previewCanvas.getContext('2d').putImageData(
        new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
}

// Shows the right surface: the <img> for the original ("Show original"
// toggle), the canvas for everything that comes as raw pixels (processed
// image, transform live preview — the latter taking precedence).
// The original is routed by the toggle: in the main viewer while the
// projection mirror is closed, in the mirror only while it is open (the
// main viewer then falls back to the grid render and stays interactive).
function updatePreviewSrc() {
    const showOrig = showOriginalBtn.classList.contains('active') && !mirrorOpen();
    const pixels = transformPreviewPixels ?? (showOrig ? null : processedPixels);

    if (pixels) {
        paintPreviewCanvas(pixels);
        previewCanvas.classList.remove('hidden');
        preview.classList.add('hidden');
    } else if (showOrig && originalPng) {
        preview.src = `data:image/png;base64,${originalPng}`;
        preview.classList.remove('hidden');
        previewCanvas.classList.add('hidden');
    } else {
        preview.classList.add('hidden');
        previewCanvas.classList.add('hidden');
    }

    // The processed view is the grid render: show cells as crisp blocks
    previewCanvas.classList.toggle('pixelated', !showOrig && transformPreviewPixels === null);

    pushMirrorImage();
}

function syncLabels() {
  gridValue.textContent       = hasImage ? currentGridWidth() : '-';
  contrastValue.textContent   = Number(contrast.value).toFixed(0);
  brightnessValue.textContent = Number(brightness.value).toFixed(0);
  vibranceValue.textContent   = Number(vibrance.value).toFixed(0);
  textureValue.textContent    = Number(texture.value).toFixed(0);
  clarityValue.textContent    = Number(clarity.value).toFixed(0);
  simplifyValue.textContent   = Number(simplify.value).toFixed(0);

  const p = sliderToPosterizeLevels(Number(posterize.value));
  posterizeValue.textContent = p ? t('controls.posterizeLevels', { count: p }) : t('controls.posterizeOff');
}

// ---------- Refresh ----------
let pending = false;
let lastDimensionsInfo = null; // remembers the last result, to retranslate on locale change

async function refresh() {
  if (!hasImage || pending) return;
  pending = true;

  try {
    const buf = await invoke('apply_image_adjustments', {
      params: buildParams(),
    });
    const decoded = decodePixelResponse(buf);

    processedPixels = decoded;
    updatePreviewSrc();

    totalPixels = decoded.width * decoded.height;
    gridW = decoded.width;
    gridH = decoded.height;
    clearOverlay();
    cancelZonePicking();
    updateAllSynthZones();

    lastDimensionsInfo = {
      origWidth, origHeight,
      width: decoded.width, height: decoded.height,
      cellCount: totalPixels,
    };
    dimensionsInfo.textContent = t('controls.dimensionsInfo', lastDimensionsInfo);
  } catch (err) {
    console.error('Error while processing:', err);
    dimensionsInfo.textContent = translateError(err);
  } finally {
    pending = false;
  }
}

let debounceId = null;
function scheduleRefresh(delay = 60) {
  clearTimeout(debounceId);
  debounceId = setTimeout(refresh, delay);
}

// ---------- Loading ----------
loadBtn.addEventListener('click', async () => {
  try {
    const result = await invoke('load_image');
    if (!result) return;

    exitCropMode();
    closeTransformPanel();

    origWidth   = result.orig_width;
    origHeight  = result.orig_height;
    originalPng = result.base64_png;
    hasImage    = true;

    gridSlider.value         = SLIDER_STEPS;
    showOriginalBtn.classList.remove('active');

    viewerEmpty.classList.add('hidden');

    syncLabels();
    // A new image invalidates every zone: they are grid coordinates of
    // the previous image and carry no meaning here (same policy as the
    // reshape operations). resetAllSynthZones clears them on the UI and
    // backend sides alike (silences too — they live within the
    // selection), then the plain refresh re-renders the grid: the
    // zone re-push inside it is a no-op (everything is already empty).
    resetAllSynthZones();
    await refresh();
  } catch (err) {
    console.error('Error while loading the image:', err);
    dimensionsInfo.textContent = translateError(err);
  }
});

// ---------- Image shape tools (rotate / crop / transform) ----------
// Every reshape operation resets the synth zones and silences: they are
// grid coordinates and would no longer match the manipulated image.
function resetAllSynthZones() {
    synthHighlights.forEach(hi => {
        hi.zones = [];
        hi.muteZones = [];
    });
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        const id = Number(el.dataset.synthId);
        sendSynthZones(id);
        sendSynthMuteZones(id);
        updateZonesLabel(id);
    });
    redrawAllHighlights();
}

// Applies a backend reshape result (new original) to the frontend state
async function applyReshapedImage(result) {
    origWidth   = result.orig_width;
    origHeight  = result.orig_height;
    originalPng = result.base64_png;

    resetAllSynthZones();
    syncLabels();
    updatePreviewSrc();
    await refresh();
}

// ---------- Rotation (90° steps) ----------
rotateBtn.addEventListener('click', async () => {
    if (!hasImage) return;
    try {
        const result = await invoke('rotate_image');

        exitCropMode();
        closeTransformPanel();
        await applyReshapedImage(result);
    } catch (err) {
        console.error('Error while rotating the image:', err);
        dimensionsInfo.textContent = translateError(err);
    }
});

// ---------- Crop ----------
const cropBar          = document.querySelector('#crop-bar');
const cropApplyBtn     = document.querySelector('#crop-apply-btn');
const cropCancelBtn    = document.querySelector('#crop-cancel-btn');

let cropMode  = false;
let cropRect  = null; // { x, y, w, h } in overlay canvas pixels
let cropDrag  = null; // drag in progress: { kind: 'new'|'move'|'resize', handle, startX, startY, orig }
let cropRatio = null; // forced aspect ratio (w/h), null = free

const CROP_HANDLE_HIT  = 6; // grab tolerance around an edge/corner, in overlay px
const CROP_HANDLE_DRAW = 8; // on-screen size of the handle squares
const CROP_MIN_SIZE    = 1; // smallest frame a resize can produce, in overlay px
const CROP_HANDLE_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize',   s: 'ns-resize',
    e: 'ew-resize',   w: 'ew-resize',
};

// Image bounds in overlay canvas pixels: the frame never leaves them
function cropImageBounds() {
    const layout = getImageLayout();
    if (layout) return { x: layout.offsetX, y: layout.offsetY, w: layout.renderW, h: layout.renderH };
    return { x: 0, y: 0, w: pixelOverlay.width, h: pixelOverlay.height };
}

// Shifts the rect (size unchanged) so it stays inside the image bounds
function clampCropRect(rect) {
    const b = cropImageBounds();
    rect.w = Math.min(rect.w, b.w);
    rect.h = Math.min(rect.h, b.h);
    rect.x = Math.min(Math.max(rect.x, b.x), b.x + b.w - rect.w);
    rect.y = Math.min(Math.max(rect.y, b.y), b.y + b.h - rect.h);
    return rect;
}

// Re-fits an existing rect onto the forced ratio: the size is capped by both
// the current rect and the image bounds, the position keeps the rect center
function applyCropRatioToRect(rect) {
    if (!cropRatio) return rect;
    const b = cropImageBounds();
    let w = rect.w;
    let h = w / cropRatio;
    if (h > rect.h) { h = rect.h; w = h * cropRatio; }
    if (w > b.w)    { w = b.w;    h = w / cropRatio; }
    if (h > b.h)    { h = b.h;    w = h * cropRatio; }
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return clampCropRect({ x: cx - w / 2, y: cy - h / 2, w, h });
}

// What a press at (px, py) would grab: a resize handle, the frame interior
// (move), or empty space (draw a brand new frame)
function cropDragTargetAt(px, py) {
    if (!cropRect) return { kind: 'new', handle: null };
    const { x, y, w, h } = cropRect;
    const t = CROP_HANDLE_HIT;
    const inside = px >= x && px <= x + w && py >= y && py <= y + h;
    // A tiny frame is easier to move than to resize: interior presses move it
    if (inside && w <= 2 * t && h <= 2 * t) return { kind: 'move', handle: null };
    const nearL = Math.abs(px - x) <= t;
    const nearR = Math.abs(px - (x + w)) <= t;
    const nearT = Math.abs(py - y) <= t;
    const nearB = Math.abs(py - (y + h)) <= t;
    if (nearL && nearT) return { kind: 'resize', handle: 'nw' };
    if (nearR && nearT) return { kind: 'resize', handle: 'ne' };
    if (nearL && nearB) return { kind: 'resize', handle: 'sw' };
    if (nearR && nearB) return { kind: 'resize', handle: 'se' };
    if (nearT) return { kind: 'resize', handle: 'n' };
    if (nearB) return { kind: 'resize', handle: 's' };
    if (nearL) return { kind: 'resize', handle: 'w' };
    if (nearR) return { kind: 'resize', handle: 'e' };
    if (inside) return { kind: 'move', handle: null };
    return { kind: 'new', handle: null };
}

// Computes the frame for the drag in progress from the current pointer
// position. Every branch keeps the frame inside the image bounds.
function updateCropDrag(cx, cy) {
    const { kind, handle, startX, startY, orig } = cropDrag;
    const b = cropImageBounds();
    const dx = cx - startX;
    const dy = cy - startY;

    if (kind === 'move') {
        return clampCropRect({ x: orig.x + dx, y: orig.y + dy, w: orig.w, h: orig.h });
    }

    if (kind === 'new') {
        // Anchor clamped inside the image: pressing outside the image starts
        // the frame on the nearest image edge
        const ax = Math.max(b.x, Math.min(b.x + b.w, startX));
        const ay = Math.max(b.y, Math.min(b.y + b.h, startY));
        const dirX = cx >= ax ? 1 : -1;
        const dirY = cy >= ay ? 1 : -1;
        const availW = dirX > 0 ? b.x + b.w - ax : ax - b.x;
        const availH = dirY > 0 ? b.y + b.h - ay : ay - b.y;
        let w = Math.min(Math.abs(cx - ax), availW);
        let h = Math.min(Math.abs(cy - ay), availH);
        if (cropRatio) {
            // Dominant drag axis drives the frame, the other follows
            if (w >= h * cropRatio) {
                h = w / cropRatio;
                if (h > availH) { h = availH; w = h * cropRatio; }
            } else {
                w = h * cropRatio;
                if (w > availW) { w = availW; h = w / cropRatio; }
            }
        }
        return { x: dirX > 0 ? ax : ax - w, y: dirY > 0 ? ay : ay - h, w, h };
    }

    // --- resize ---
    if (!cropRatio) {
        let left = orig.x, right = orig.x + orig.w;
        let top = orig.y, bottom = orig.y + orig.h;
        if (handle.includes('w')) left = orig.x + dx;
        if (handle.includes('e')) right = orig.x + orig.w + dx;
        if (handle.includes('n')) top = orig.y + dy;
        if (handle.includes('s')) bottom = orig.y + orig.h + dy;
        left  = Math.min(Math.max(left, b.x), right - CROP_MIN_SIZE);
        right = Math.min(Math.max(right, left + CROP_MIN_SIZE), b.x + b.w);
        top   = Math.min(Math.max(top, b.y), bottom - CROP_MIN_SIZE);
        bottom = Math.min(Math.max(bottom, top + CROP_MIN_SIZE), b.y + b.h);
        return { x: left, y: top, w: right - left, h: bottom - top };
    }

    // Ratio-locked resize: the opposite edge/corner stays anchored. Corner
    // handles follow the dominant drag axis; edge handles resize along their
    // axis and stay centered on the other.
    const horiz = handle.includes('w') || handle.includes('e');
    const vert  = handle.includes('n') || handle.includes('s');
    if (horiz && vert) {
        const ax = handle.includes('w') ? orig.x + orig.w : orig.x; // anchored vertical edge
        const ay = handle.includes('n') ? orig.y + orig.h : orig.y; // anchored horizontal edge
        const availW = handle.includes('w') ? ax - b.x : b.x + b.w - ax;
        const availH = handle.includes('n') ? ay - b.y : b.y + b.h - ay;
        const wantW = handle.includes('w') ? orig.w - dx : orig.w + dx;
        const wantH = handle.includes('n') ? orig.h - dy : orig.h + dy;
        let w, h;
        if (wantW >= wantH * cropRatio) { w = wantW; h = w / cropRatio; }
        else                            { h = wantH; w = h * cropRatio; }
        w = Math.max(CROP_MIN_SIZE, Math.min(w, availW));
        h = w / cropRatio;
        if (h > availH) { h = availH; w = h * cropRatio; }
        return clampCropRect({
            x: handle.includes('w') ? ax - w : ax,
            y: handle.includes('n') ? ay - h : ay,
            w, h,
        });
    }
    const centerX = orig.x + orig.w / 2;
    const centerY = orig.y + orig.h / 2;
    let w, h;
    if (horiz) {
        const availW = Math.min(centerX - b.x, b.x + b.w - centerX) * 2;
        const wantW = handle === 'w' ? orig.w - dx : orig.w + dx;
        w = Math.max(CROP_MIN_SIZE, Math.min(wantW, availW));
        h = w / cropRatio;
        const availH = Math.min(centerY - b.y, b.y + b.h - centerY) * 2;
        if (h > availH) { h = availH; w = h * cropRatio; }
    } else {
        const availH = Math.min(centerY - b.y, b.y + b.h - centerY) * 2;
        const wantH = handle === 'n' ? orig.h - dy : orig.h + dy;
        h = Math.max(CROP_MIN_SIZE, Math.min(wantH, availH));
        w = h * cropRatio;
        const availW = Math.min(centerX - b.x, b.x + b.w - centerX) * 2;
        if (w > availW) { w = availW; h = w / cropRatio; }
    }
    return clampCropRect({ x: centerX - w / 2, y: centerY - h / 2, w, h });
}

function drawCropOverlay() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    if (!cropRect) return;
    const { x, y, w, h } = cropRect;
    const vw = pixelOverlay.width;
    const vh = pixelOverlay.height;

    ctx.save();
    // Dim everything outside the selection
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, vw, y);
    ctx.fillRect(0, y + h, vw, vh - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, vw - x - w, h);
    // Selection outline
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    // Corner & edge handles
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    const hs = CROP_HANDLE_DRAW;
    for (const [hx, hy] of [
        [x, y], [x + w / 2, y], [x + w, y],
        [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h],
        [x, y + h], [x, y + h / 2],
    ]) {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
    ctx.restore();
}

function enterCropMode() {
    if (!hasImage || cropMode) return;
    cancelZonePicking();
    closeTransformPanel();
    cropMode = true;
    cropRect = null;
    cropDrag = null;
    // Each session starts free-form: predictable behavior across sessions
    cropRatio = null;
    cropRatioGroup.querySelectorAll('.ratio-btn').forEach(btn => {
        btn.classList.toggle('active', !btn.dataset.cropRatio);
    });
    cropBtn.classList.add('active');
    pixelOverlay.classList.add('picking');
    pixelOverlay.style.cursor = 'crosshair';
    cropBar.classList.remove('hidden');
    cropApplyBtn.disabled = true;
    drawCropOverlay();
}

function exitCropMode() {
    if (!cropMode) return;
    cropMode = false;
    cropRect = null;
    cropDrag = null;
    cropBtn.classList.remove('active');
    pixelOverlay.classList.remove('picking');
    pixelOverlay.style.cursor = '';
    cropBar.classList.add('hidden');
    redrawAllHighlights();
}

cropBtn.addEventListener('click', () => cropMode ? exitCropMode() : enterCropMode());
cropCancelBtn.addEventListener('click', exitCropMode);

// ---------- Crop: forced aspect ratio ----------
const cropRatioGroup = document.querySelector('#crop-ratio-group');

// "1", "4/3", "16/9"... -> number (w/h); "" -> null (free form)
function parseCropRatio(str) {
    if (!str) return null;
    const m = str.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return null;
    return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
}

cropRatioGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.ratio-btn');
    if (!btn) return;
    const ratio = parseCropRatio(btn.dataset.cropRatio);
    if (ratio === cropRatio) return;
    cropRatio = ratio;
    cropRatioGroup.querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b === btn));
    // An existing frame is re-fitted onto the new ratio
    if (cropRect) {
        cropRect = applyCropRatioToRect(cropRect);
        drawCropOverlay();
    }
});

cropApplyBtn.addEventListener('click', async () => {
    if (!cropMode || !cropRect || !hasImage) return;
    const layout = getImageLayout();
    if (!layout) return;

    // Overlay canvas pixels → original image pixels
    const x = Math.max(0, Math.round((cropRect.x - layout.offsetX) / layout.renderW * origWidth));
    const y = Math.max(0, Math.round((cropRect.y - layout.offsetY) / layout.renderH * origHeight));
    const w = Math.max(1, Math.min(origWidth - x, Math.round(cropRect.w / layout.renderW * origWidth)));
    const h = Math.max(1, Math.min(origHeight - y, Math.round(cropRect.h / layout.renderH * origHeight)));

    try {
        const result = await invoke('crop_image', { x, y, width: w, height: h });
        exitCropMode();
        await applyReshapedImage(result);
    } catch (err) {
        console.error('Error while cropping the image:', err);
        dimensionsInfo.textContent = translateError(err);
    }
});

// ---------- Transform (fine rotation + perspective) ----------
const transformPanel          = document.querySelector('#transform-panel');
const transformApplyBtn       = document.querySelector('#transform-apply-btn');
const transformCancelBtn      = document.querySelector('#transform-cancel-btn');
const transformRotation       = document.querySelector('#transform-rotation');
const transformRotationValue  = document.querySelector('#transform-rotation-value');
const transformPerspV         = document.querySelector('#transform-persp-v');
const transformPerspVValue    = document.querySelector('#transform-persp-v-value');
const transformPerspH         = document.querySelector('#transform-persp-h');
const transformPerspHValue    = document.querySelector('#transform-persp-h-value');
const transformGridBtn        = document.querySelector('#transform-grid-btn');

let transformActive = false;
let transformPreviewPixels = null; // live preview { width, height, rgba }, shown instead of the normal image
let transformDebounceId = null;
let transformRequestToken = 0;     // discards stale preview responses

function transformParams() {
    return {
        rotation: Number(transformRotation.value),
        perspective_v: Number(transformPerspV.value) / 100,
        perspective_h: Number(transformPerspH.value) / 100,
    };
}

function isTransformPending() {
    const p = transformParams();
    return p.rotation !== 0 || p.perspective_v !== 0 || p.perspective_h !== 0;
}

// ---------- Alignment grid overlay ----------
// Computes the render rect of the image currently displayed in the viewer:
// the transform preview while the panel is open (its canvas changes size
// with the rotation/perspective), the processed grid otherwise.
function getDisplayedImageLayout() {
    const vw = pixelOverlay.width;
    const vh = pixelOverlay.height;
    const pixels = transformPreviewPixels ?? processedPixels;
    if (!pixels || !pixels.width || !pixels.height || !vw || !vh) return null;
    const imgRatio  = pixels.width / pixels.height;
    const viewRatio = vw / vh;
    let renderW, renderH;
    if (imgRatio > viewRatio) { renderW = vw; renderH = vw / imgRatio; }
    else                      { renderH = vh; renderW = vh * imgRatio; }
    return {
        renderW, renderH,
        offsetX: (vw - renderW) / 2,
        offsetY: (vh - renderH) / 2,
    };
}

// Rule of thirds plus a finer 12-division grid, drawn over the displayed
// image. The grid is fixed relative to the viewer: it does not rotate with
// the image, so it can be used as an alignment reference.
const TRANSFORM_GRID_DIVISIONS = 12;

function drawTransformGrid() {
    const layout = getDisplayedImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, renderW, renderH } = layout;
    const ctx = pixelOverlay.getContext('2d');

    ctx.save();
    ctx.lineWidth = 1;

    const vline = i => offsetX + Math.round(renderW * i / TRANSFORM_GRID_DIVISIONS) + 0.5;
    const hline = i => offsetY + Math.round(renderH * i / TRANSFORM_GRID_DIVISIONS) + 0.5;
    const third1 = TRANSFORM_GRID_DIVISIONS / 3;
    const third2 = 2 * TRANSFORM_GRID_DIVISIONS / 3;

    // Fine grid (thirds drawn separately, stronger)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    for (let i = 1; i < TRANSFORM_GRID_DIVISIONS; i++) {
        if (i === third1 || i === third2) continue;
        ctx.moveTo(vline(i), offsetY);
        ctx.lineTo(vline(i), offsetY + renderH);
        ctx.moveTo(offsetX, hline(i));
        ctx.lineTo(offsetX + renderW, hline(i));
    }
    ctx.stroke();

    // Rule of thirds
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    for (const i of [third1, third2]) {
        ctx.moveTo(vline(i), offsetY);
        ctx.lineTo(vline(i), offsetY + renderH);
        ctx.moveTo(offsetX, hline(i));
        ctx.lineTo(offsetX + renderW, hline(i));
    }
    ctx.stroke();

    // Displayed image bounds (the transform preview includes transparent
    // corners when rotated)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, renderW - 1, renderH - 1);

    ctx.restore();
}

// Rebuilds the whole overlay while the transform panel is open: synth
// highlights first, alignment grid on top.
function redrawTransformOverlay() {
    redrawAllHighlights();
    if (transformGridBtn.classList.contains('active')) drawTransformGrid();
}

function syncTransformLabels() {
    transformRotationValue.textContent = `${Number(transformRotation.value).toFixed(1)}°`;
    transformPerspVValue.textContent = Number(transformPerspV.value);
    transformPerspHValue.textContent = Number(transformPerspH.value);
    transformApplyBtn.disabled = !isTransformPending();
}

function scheduleTransformPreview(delay = 150) {
    clearTimeout(transformDebounceId);
    transformDebounceId = setTimeout(requestTransformPreview, delay);
}

async function requestTransformPreview() {
    if (!transformActive) return;
    // No adjustment: show the original as-is (no backend round trip)
    if (!isTransformPending()) {
        transformRequestToken++;
        transformPreviewPixels = null;
        updatePreviewSrc();
        redrawTransformOverlay();
        return;
    }
    const params = transformParams();
    const token = ++transformRequestToken;
    try {
        const buf = await invoke('preview_image_transform', { params });
        if (!transformActive || token !== transformRequestToken) return;
        transformPreviewPixels = decodePixelResponse(buf);
        updatePreviewSrc();
        redrawTransformOverlay();
    } catch (err) {
        console.error('Error in preview_image_transform:', err);
    }
}

function openTransformPanel() {
    if (!hasImage || transformActive) return;
    cancelZonePicking();
    exitCropMode();
    transformActive = true;
    transformBtn.classList.add('active');
    transformPanel.classList.remove('hidden');
    // The sliders start from zero: any previous adjustment was consumed
    // into the original when applied
    transformRotation.value = 0;
    transformPerspV.value = 0;
    transformPerspH.value = 0;
    syncTransformLabels();
    transformPreviewPixels = null;
    updatePreviewSrc();
    redrawTransformOverlay();
}

function closeTransformPanel() {
    if (!transformActive) return;
    transformActive = false;
    clearTimeout(transformDebounceId);
    transformRequestToken++;
    transformPreviewPixels = null;
    transformBtn.classList.remove('active');
    transformPanel.classList.add('hidden');
    updatePreviewSrc();
    redrawAllHighlights(); // removes the alignment grid
}

transformBtn.addEventListener('click', () => transformActive ? closeTransformPanel() : openTransformPanel());
transformCancelBtn.addEventListener('click', closeTransformPanel);

[transformRotation, transformPerspV, transformPerspH].forEach(el => {
    el.addEventListener('input', () => {
        syncTransformLabels();
        scheduleTransformPreview();
    });
});

transformGridBtn.addEventListener('click', () => {
    transformGridBtn.classList.toggle('active');
    redrawTransformOverlay();
});

// Keyboard control while the transform panel is open: arrows adjust the
// perspective, Shift+up/down the fine rotation. Skipped when the focus is
// already in a form field or button, since the focused widget handles the
// keys itself (native slider behavior).
window.addEventListener('keydown', (e) => {
    if (!transformActive) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

    let slider = null;
    let delta  = 0;
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        slider = transformRotation;
        delta  = e.key === 'ArrowUp' ? 0.1 : -0.1;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        slider = transformPerspV;
        delta  = e.key === 'ArrowUp' ? 1 : -1;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        slider = transformPerspH;
        delta  = e.key === 'ArrowRight' ? 1 : -1;
    }
    if (!slider) return;

    e.preventDefault(); // the arrows must not scroll the page
    const next = Math.min(Number(slider.max), Math.max(Number(slider.min), Number(slider.value) + delta));
    // Rounded to one decimal: the rotation accumulates 0.1 steps and the
    // float sum would drift (0.1 + 0.2 = 0.30000000000000004)
    slider.value = Math.round(next * 10) / 10;
    syncTransformLabels();
    scheduleTransformPreview();
});

// Double-click on a slider resets it to zero
[transformRotation, transformPerspV, transformPerspH].forEach(el => {
    el.addEventListener('dblclick', () => {
        el.value = 0;
        syncTransformLabels();
        scheduleTransformPreview();
    });
});

transformApplyBtn.addEventListener('click', async () => {
    if (!transformActive || !hasImage || !isTransformPending()) return;
    const params = transformParams();
    try {
        const result = await invoke('apply_image_transform', { params });
        closeTransformPanel(); // restores the normal preview
        await applyReshapedImage(result);
    } catch (err) {
        console.error('Error while transforming the image:', err);
        dimensionsInfo.textContent = translateError(err);
    }
});

// ---------- Reset ----------
resetBtn.addEventListener('click', () => {
  gridSlider.value  = SLIDER_STEPS;
  contrast.value    = 0;
  brightness.value  = 0;
  vibrance.value  = 0;
  posterize.value   = 0;
  texture.value    = 0;
  clarity.value    = 0;
  simplify.value   = 0;
  autoLevelsBtn.classList.remove('active');

  syncLabels();
  refresh();
});

// ---------- Session save / load ----------
const saveSessionBtn = document.querySelector('#save-session-btn');
const loadSessionBtn = document.querySelector('#load-session-btn');

// Collects the frontend-owned state (metronome tempo, image sliders, synth
// colors in display order); the backend owns the rest (image, synths).
saveSessionBtn.addEventListener('click', async () => {
    const ui = {
        bpm: clampBpm(Number(bpmInput.value)),
        grid_slider: Number(gridSlider.value),
        contrast: Number(contrast.value),
        brightness: Number(brightness.value),
        vibrance: Number(vibrance.value),
        posterize_levels: sliderToPosterizeLevels(Number(posterize.value)),
        texture: Number(texture.value),
        clarity: Number(clarity.value),
        simplify: Number(simplify.value),
        auto_levels: autoLevelsBtn.classList.contains('active'),
        mirror_zones_mode: mirrorZonesMode,
        synth_colors: Array.from(synthListBody.querySelectorAll('.synth-block')).map(el => ({
            id: Number(el.dataset.synthId),
            color: synthColors.get(Number(el.dataset.synthId)),
        })),
    };
    try {
        await invoke('save_session', { ui });
    } catch (err) {
        console.error('Error while saving the session:', err);
        alert(translateError(err));
    }
});

loadSessionBtn.addEventListener('click', async () => {
    let session;
    try {
        session = await invoke('load_session');
    } catch (err) {
        console.error('Error while loading the session:', err);
        alert(translateError(err));
        return;
    }
    if (!session) return; // dialog canceled

    // Stop everything and clear the current synths
    await invoke('stop_metronome');
    exitCropMode();
    closeTransformPanel();
    metronomeRunning = false;
    synthListBody.querySelectorAll('.synth-block').forEach(el => el.remove());
    synthTabs.querySelectorAll('.synth-tab').forEach(el => el.remove());
    synthColors.clear();
    synthCursors.clear();
    synthHighlights.clear();
    synthNames.clear();
    synthDisplayNumbers.clear();
    placeholder.classList.remove('hidden');
    cancelZonePicking();
    syncPlayAllButton();
    updateImageControlsLockState();

    // Restore the image and its processing settings (the backend already
    // holds the original: refresh re-derives the processed grid)
    origWidth = session.orig_width;
    origHeight = session.orig_height;
    originalPng = session.image_base64;
    hasImage = true;
    gridSlider.value = session.image_settings.grid_slider;
    contrast.value = session.image_settings.contrast;
    brightness.value = session.image_settings.brightness;
    vibrance.value = session.image_settings.vibrance ?? 0;
    posterize.value = posterizeLevelsToSlider(session.image_settings.posterize_levels);
    texture.value = session.image_settings.texture ?? 0;
    clarity.value = session.image_settings.clarity ?? 0;
    simplify.value = session.image_settings.simplify ?? 0;
    autoLevelsBtn.classList.toggle('active', session.image_settings.auto_levels ?? false);
    mirrorZonesMode = session.image_settings.mirror_zones_mode;
    updateMirrorZonesButton();
    showOriginalBtn.classList.remove('active');
    viewerEmpty.classList.add('hidden');
    syncLabels();
    // The plain refresh re-renders the processed grid at the session's
    // column count. updateAllSynthZones inside it is a no-op (the UI
    // synth list is still empty here): the synths restored by
    // load_session already hold their zones, in the session's own grid
    // coordinates, on the backend's side.
    await refresh();

    // Restore the tempo and the synths
    bpmInput.value = clampBpm(session.bpm);
    if (session.synths.length > 0) {
        placeholder.classList.add('hidden');
        for (const s of session.synths) {
            // Pre-seed the name and color for createSynthElement to pick up
            synthColors.set(s.id, s.color);
            if (s.name) synthNames.set(s.id, s.name);
            // The saved programs were just resent by the backend: reflect
            // them in the display map (keyed by the synth's port/channel)
            if (s.program && Number.isInteger(s.program.program)) {
                programMap.set(programKey(s.midi_port, s.channel), s.program);
            }
            // The synth settings are flattened into the session-synth object
            // (serde flatten), so `s` itself is the config to apply
            synthDevices.appendChild(createSynthElement(s.id, s));
            const hi = synthHighlights.get(s.id);
            if (hi) {
                // Zones come as run-encoded components; the backend
                // already holds them (load_session restored its side)
                hi.zones = s.zones || [];
                hi.muteZones = s.mute_zones || [];
            }
            updateZonesLabel(s.id);
        }
        // New zones must never collide with the restored creation orders
        seedZoneOrder(Array.from(synthHighlights.values())
            .flatMap(hi => hi.zones.concat(hi.muteZones)));
        redrawAllHighlights();
        // Normalize the ids of legacy session files (possible gaps after
        // deletions): the ids must match the display order again
        await renumberSynthIds();
    }
});

// ---------- Listeners ----------
// The column-count change only ever happens while nothing plays (the
// slider is locked during playback): the debounced refresh re-renders
// continuously during the drag, and the zones simply stay at their
// place — updateAllSynthZones clips them to the new grid and drops
// the ones that no longer intersect it.
[gridSlider, contrast, brightness, vibrance, posterize, texture, clarity, simplify].forEach(el => {
  el.addEventListener('input', () => {
    syncLabels();
    scheduleRefresh();
  });
});

// Double-click a slider to reset it to its default value (0 for the
// adjustments, the maximum for the grid width)
const sliderDefaults = new Map([
  [gridSlider, SLIDER_STEPS],
  [contrast, 0],
  [brightness, 0],
  [vibrance, 0],
  [posterize, 0],
  [texture, 0],
  [clarity, 0],
  [simplify, 0],
]);
sliderDefaults.forEach((def, el) => {
  el.addEventListener('dblclick', () => {
    if (el.value == def) return;
    el.value = def;
    syncLabels();
    scheduleRefresh();
  });
});

autoLevelsBtn.addEventListener('click', () => {
  autoLevelsBtn.classList.toggle('active');
  scheduleRefresh();
});

// ---------- Manual column entry: double-click the placeholder ----------
// The column count normally follows the logarithmic slider; a
// double-click on the displayed count opens an inline input to type an
// exact number instead. Values outside 2..origWidth are refused (the
// input closes without changing anything), as is any entry while the
// controls are locked during playback.
gridValue.addEventListener('dblclick', () => {
  if (!hasImage || gridSlider.disabled || document.querySelector('#grid-width-input')) return;

  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'grid-width-input';
  input.className = 'grid-width-input';
  input.min = MIN_CELLS;
  input.max = origWidth;
  input.step = 1;
  input.value = currentGridWidth();

  gridValue.classList.add('hidden');
  gridValue.after(input);
  input.focus();
  input.select();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input.remove();
    gridValue.classList.remove('hidden');
  };
  const commit = () => {
    if (closed) return;
    const cells = Math.round(Number(input.value));
    if (Number.isFinite(cells) && cells >= MIN_CELLS && cells <= origWidth) {
      gridSlider.value = cellsToSlider(cells, origWidth);
      syncLabels();
      scheduleRefresh();
    }
    close();
  };

  input.addEventListener('keydown', (e) => {
    // Enter commits, Escape cancels; stopPropagation prevents global
    // handlers (zone picking, help mode) from firing as well
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', commit);
});

// "Show original" routes the original image by the mirror's state:
// main viewer while the mirror is closed, mirror only while it is open
// (see updatePreviewSrc). Closing the mirror while the original is
// shown there resets the toggle.
showOriginalBtn.addEventListener('click', () => {
    showOriginalBtn.classList.toggle('active');
    updatePreviewSrc();
});

// ---------- Projection mirror window ----------
// Performance mode: a display-only Tauri window that mirrors the image
// area on a second screen/projector. The main window stays fully
// interactive and pushes its viewer state to the mirror through Tauri
// events, funneled through the same single points that repaint the main
// viewer (updatePreviewSrc for the image surface, redrawAllHighlights
// for the zones).
const fullscreenBtn  = document.querySelector('#fullscreen-btn');
const mirrorZonesBtn = document.querySelector('#mirror-zones-btn');

const MIRROR_LABEL = 'mirror';
// Zone display in the mirror, cycled by the zones button: 'all' (every
// synth's zones), 'active' (only the synths whose eye button is on in
// the main window) or 'none' (nothing). The mirror's display is fully
// independent of the main viewer, except in 'active' mode which follows
// the eye buttons.
const MIRROR_ZONES_MODES = ['all', 'active', 'none'];
let mirrorZonesMode = 'all';
let mirrorCreating   = false; // window creation in flight (guards double clicks)
let mirrorWindowRef  = null;  // live WebviewWindow while the mirror is open

function updateMirrorZonesButton() {
    mirrorZonesBtn.classList.toggle('active', mirrorZonesMode !== 'none');
    mirrorZonesBtn.classList.toggle('selective', mirrorZonesMode === 'active');
}

function mirrorOpen() {
    return mirrorWindowRef !== null;
}

// The fullscreen button stays enabled while the mirror is open (it then
// closes it); it is disabled when no second screen is available.
async function updateMirrorButtonStates() {
    let hasSecondScreen = false;
    try {
        hasSecondScreen = (await availableMonitors()).length >= 2;
    } catch (err) {
        console.error('Error while detecting monitors:', err);
    }
    // Resync the reference with reality, in case the mirror went away
    // without a close-requested event (killed, unplugged screen). While
    // creation is in flight the window is not yet listed.
    if (mirrorCreating) return;
    try {
        mirrorWindowRef = await WebviewWindow.getByLabel(MIRROR_LABEL);
    } catch (err) {
        mirrorWindowRef = null;
    }
    fullscreenBtn.disabled  = !hasSecondScreen && !mirrorOpen();
    fullscreenBtn.classList.toggle('active', mirrorOpen());
}

// Opens the mirror on the first monitor other than the one hosting the
// main window, in fullscreen. Built invisible, positioned on the target
// monitor, then shown, so it never flashes on the wrong screen. When the
// user leaves fullscreen (double-click inside the mirror), the floating
// window keeps the monitor's geometry and can be dragged anywhere.
async function openMirrorWindow() {
    const monitors = await availableMonitors();
    const current = await currentMonitor();
    // First monitor other than the one hosting the main window. Names
    // can be unavailable on some platforms: the second monitor is then
    // the pragmatic answer (the floating mirror can always be dragged).
    const target = monitors.find(m => !current || m.name !== current.name)
        ?? (monitors.length > 1 ? monitors[1] : null);
    if (!target) return;

    const { PhysicalPosition, PhysicalSize } = window.__TAURI__.dpi;
    const win = new WebviewWindow(MIRROR_LABEL, {
        url: 'viewer.html',
        title: 'Wysiwyl',
        visible: false,
        decorations: true,
        resizable: true,
    });
    mirrorWindowRef = win;

    win.once('tauri://created', async () => {
        mirrorCreating = false;
        if (mirrorWindowRef !== win) {
            // The main window closed while creation was in flight: the
            // mirror must not outlive its event source
            try {
                await win.destroy();
            } catch (err) {
                console.error('Error while closing the stale mirror window:', err);
            }
            return;
        }
        try {
            await win.setPosition(new PhysicalPosition(target.position.x, target.position.y));
            await win.setSize(new PhysicalSize(target.size.width, target.size.height));
            await win.setFullscreen(true);
            await win.show();
        } catch (err) {
            console.error('Error while placing the mirror window:', err);
        }
        updateMirrorButtonStates();
    });

    win.once('tauri://error', (e) => {
        console.error('Mirror window error:', e);
        mirrorWindowRef = null;
        mirrorCreating = false;
        updateMirrorButtonStates();
    });
}

async function toggleMirrorWindow() {
    if (mirrorWindowRef) {
        const win = mirrorWindowRef;
        try {
            await win.close(); // mirror.js reports the closing via mirror:closed
        } catch (err) {
            // The window is already gone: resync the state
            console.error('Error while closing the mirror window:', err);
            mirrorWindowRef = null;
            updateMirrorButtonStates();
        }
    } else if (!mirrorCreating) {
        // The window is created asynchronously: the guard prevents a
        // double click from spawning two windows with the same label
        mirrorCreating = true;
        await openMirrorWindow();
    }
}

fullscreenBtn.addEventListener('click', toggleMirrorWindow);

mirrorZonesBtn.addEventListener('click', () => {
    const idx = MIRROR_ZONES_MODES.indexOf(mirrorZonesMode);
    mirrorZonesMode = MIRROR_ZONES_MODES[(idx + 1) % MIRROR_ZONES_MODES.length];
    updateMirrorZonesButton();
    pushMirrorZones();
});

// Playhead cursors: the positions of every playing synth, pushed on
// each tick (tiny payloads, low frequency — no throttling needed). A
// muted pixel keeps its position and is drawn at half opacity, matching
// the main viewer.
function pushMirrorCursors() {
    if (!mirrorOpen()) return;
    const cursors = [];
    synthCursors.forEach((cursor, sid) => {
        const color = synthColors.get(sid);
        if (!color) return;
        // The grid dims the cursor was recorded on travel with it: the
        // mirror decodes the absolute index against the right grid even
        // when the column count changes while synths are playing
        const g = synthCursorGrid.get(sid);
        cursors.push({
            cursor, color,
            muted: !!synthCursorMuted.get(sid),
            w: g ? g.w : gridW,
            h: g ? g.h : gridH,
        });
    });
    emit('mirror:cursors', { cursors });
}

// The mirror announces itself when loaded, and reports its own closing
// (its close-requested handler runs before the window goes away).
listen('mirror:ready', () => {
    // Opening the mirror reroutes the original image to it (when the
    // toggle is on): the main viewer falls back to the grid render.
    // updatePreviewSrc also pushes the mirror image snapshot, covering
    // the initial push in the same repaint.
    updatePreviewSrc();
    // A freshly opened mirror must receive the current snapshots even
    // when they are identical to the last session's (the dedup would
    // otherwise skip the push to a window that never got them)
    lastMirrorZonesJson = null;
    pushMirrorZones();
    pushMirrorCursors();
});

listen('mirror:closed', () => {
    mirrorWindowRef = null;
    // The original image was rerouted to the (now gone) mirror: the
    // main viewer already shows the grid render, and the toggle goes
    // back to inactive so its state keeps meaning "the original is
    // visible somewhere" (one click shows it in the main viewer again)
    showOriginalBtn.classList.remove('active');
    updateMirrorButtonStates();
});

// Re-check monitor availability whenever the main window regains focus:
// plugging or unplugging a projector updates the buttons live.
getCurrentWindow().onFocusChanged(() => {
    updateMirrorButtonStates();
});

// Closing the main window closes the projection too: without this the
// app would live on with a mirror whose source of events is gone. The
// mirror is destroyed directly (bypassing its close-requested handler,
// which would needlessly report back to a dying window).
getCurrentWindow().onCloseRequested(async () => {
    if (!mirrorWindowRef) return;
    const win = mirrorWindowRef;
    mirrorWindowRef = null;
    try {
        await win.destroy();
    } catch (err) {
        // The window may already be gone
        console.error('Error while closing the mirror window:', err);
    }
    // No preventDefault: the main window then closes normally
});

// Snapshot of the currently displayed surface, downscaled for the
// projection: photographic content (original, transform live preview)
// ships as JPEG for fluidity — the full-resolution RGBA would be tens of
// MB per frame through IPC — while the grid render ships as PNG so the
// cells stay crisp on the projector.
const MIRROR_SNAPSHOT_MAX_W = 1600;

// The original <img> may not be decoded yet when the snapshot is taken
// (its src was just set): the snapshot decodes its own copy and waits.
function decodeImage(source) {
    return new Promise((resolve, reject) => {
        source.onload = () => resolve(source);
        source.onerror = () => reject(new Error('image decode failed'));
    });
}

async function mirrorImageSnapshot() {
    const showOrig = showOriginalBtn.classList.contains('active');
    const pixels = transformPreviewPixels ?? (showOrig ? null : processedPixels);

    let source, w, h, lossy;
    if (pixels) {
        source = previewCanvas; // freshly painted by updatePreviewSrc
        w = pixels.width;
        h = pixels.height;
        lossy = transformPreviewPixels !== null; // full-res preview → JPEG
    } else if (showOrig && originalPng) {
        const img = new Image();
        const decoded = decodeImage(img);
        img.src = `data:image/png;base64,${originalPng}`;
        source = await decoded;
        w = img.naturalWidth || origWidth;
        h = img.naturalHeight || origHeight;
        lossy = true;
    } else {
        return null;
    }

    const scale = Math.min(1, MIRROR_SNAPSHOT_MAX_W / w);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const offCanvas = document.createElement('canvas');
    offCanvas.width = cw;
    offCanvas.height = ch;
    const ctx = offCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = lossy;
    ctx.drawImage(source, 0, 0, cw, ch);

    return {
        src: lossy ? offCanvas.toDataURL('image/jpeg', 0.85)
                   : offCanvas.toDataURL('image/png'),
        lossy, // false = grid render: the mirror displays it pixelated, like the main viewer
        gridW,
        gridH,
    };
}

// Trailing throttle: live manipulations (transform sliders) repaint far
// faster than IPC needs to carry them — ~30 fps keeps the mirror fluid.
const MIRROR_IMAGE_MIN_INTERVAL = 33; // ms
let mirrorImageLast = 0;
let mirrorImageTimer = 0;

async function pushMirrorImage() {
    if (!mirrorOpen()) return;
    const now = performance.now();
    const elapsed = now - mirrorImageLast;
    if (elapsed < MIRROR_IMAGE_MIN_INTERVAL) {
        if (mirrorImageTimer) return;
        mirrorImageTimer = setTimeout(() => {
            mirrorImageTimer = 0;
            pushMirrorImage();
        }, MIRROR_IMAGE_MIN_INTERVAL - elapsed);
        return;
    }
    mirrorImageLast = now;
    try {
        const snapshot = await mirrorImageSnapshot();
        if (snapshot) emit('mirror:image', snapshot);
    } catch (err) {
        console.error('Error while building the mirror snapshot:', err);
    }
}

// Full snapshot of every synth's zones — regardless of their visibility
// in the main window: the mirror toggle overrides the per-synth eye
// buttons, and zones stay shown while a synth is playing. The mute-cell
// computation only runs when the mirror actually shows zones.
//
// The snapshot is throttled and deduplicated: zone drags call
// redrawAllHighlights at mousemove rate while the committed zones stay
// unchanged — identical consecutive payloads are not re-sent.
const MIRROR_ZONES_MIN_INTERVAL = 33; // ms
let mirrorZonesLast = 0;
let mirrorZonesTimer = 0;
let lastMirrorZonesJson = null;

function pushMirrorZones() {
    if (!mirrorOpen()) return;
    const now = performance.now();
    const elapsed = now - mirrorZonesLast;
    if (elapsed < MIRROR_ZONES_MIN_INTERVAL) {
        if (mirrorZonesTimer) return;
        mirrorZonesTimer = setTimeout(() => {
            mirrorZonesTimer = 0;
            pushMirrorZones();
        }, MIRROR_ZONES_MIN_INTERVAL - elapsed);
        return;
    }
    mirrorZonesLast = now;

    const synths = [];
    if (mirrorZonesMode !== 'none') {
        synthHighlights.forEach((hi, sid) => {
            // 'active' mode: the mirror follows the main window's eye buttons
            if (mirrorZonesMode === 'active' && !hi.visible) return;
            const color = synthColors.get(sid);
            if (!color) return;
            synths.push({
                color,
                zones: hi.zones,
                muteCells: Array.from(computeMuteCells(sid, hi)),
            });
        });
    }
    const payload = { showZones: mirrorZonesMode !== 'none', synths };
    const json = JSON.stringify(payload);
    if (json === lastMirrorZonesJson) return;
    lastMirrorZonesJson = json;
    emit('mirror:zones', payload);
}

updateMirrorButtonStates();
updateMirrorZonesButton(); // reflect the initial mode on the button

// ---------- Init ----------
syncLabels();

// The mute rest glyph is only ever drawn on a canvas; canvas fillText
// does NOT trigger a lazy @font-face download (the Noto Music font is
// fetched only when one of its unicode-range characters appears in the
// DOM — the note-length buttons of a synth card, which don't exist
// before the first synth is created). Without this, mute marks drawn
// right after a session load would show the font's fallback (an empty
// box) until something repaints them later. Force the download at
// startup and repaint whatever was drawn with the fallback font.
document.fonts.load('16px "Noto Music"', MUTE_GLYPH)
    .then(() => redrawAllHighlights())
    .catch(err => console.error('Error while loading the Noto Music font:', err));
document.fonts.ready.then(() => redrawAllHighlights());

// ---------- Metronome ----------
const bpmInput = document.querySelector('#bpm-input');
const bpmMinus10 = document.querySelector('#bpm-minus10');
const bpmMinus5  = document.querySelector('#bpm-minus5');
const bpmPlus5   = document.querySelector('#bpm-plus5');
const bpmPlus10  = document.querySelector('#bpm-plus10');
const metronomeLed = document.querySelector('#metronome-led');

const BPM_MIN = 20;
const BPM_MAX = 300;

let metronomeRunning = false;

function clampBpm(value) {
    return Math.min(BPM_MAX, Math.max(BPM_MIN, value));
}

async function applyBpm(newBpm) {
    const clamped = clampBpm(newBpm);
    bpmInput.value = clamped;
    if (metronomeRunning) {
        await invoke('set_metronome_bpm', { bpm: clamped });
    }
    updateAllSynthZonesLabels();
}

// Starts the Rust metronome if it's not already running
async function ensureMetronomeStarted() {
    if (metronomeRunning) return;
    await invoke('set_metronome_bpm', { bpm: clampBpm(Number(bpmInput.value)) });
    await invoke('start_metronome');
    metronomeRunning = true;
}

// Stops the Rust metronome if no synth is playing anymore
async function stopMetronomeIfIdle() {
    if (!metronomeRunning) return;
    const anyPlaying = synthListBody.querySelectorAll('.synth-play.active').length > 0;
    if (anyPlaying) return;

    await invoke('stop_metronome');
    metronomeRunning = false;

    // Restore the highlights hidden during playback
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        const sid = Number(el.dataset.synthId);
        eraseSynthCursor(sid);
        const hi = synthHighlights.get(sid);
        if (hi && hi._wasVisible) {
            hi.visible = true;
            hi._wasVisible = false;
            syncEyeButton(el, true);
        }
    });
    redrawAllHighlights();
}

bpmMinus10.addEventListener('click', () => applyBpm(Number(bpmInput.value) - 10));
bpmMinus5.addEventListener('click',  () => applyBpm(Number(bpmInput.value) - 5));
bpmPlus5.addEventListener('click',   () => applyBpm(Number(bpmInput.value) + 5));
bpmPlus10.addEventListener('click',  () => applyBpm(Number(bpmInput.value) + 10));

// Custom ±1 spinner arrows (replacing the native, uncolorable ones)
document.querySelector('#bpm-up').addEventListener('click',   () => applyBpm(Number(bpmInput.value) + 1));
document.querySelector('#bpm-down').addEventListener('click', () => applyBpm(Number(bpmInput.value) - 1));

// Mouse wheel / trackpad scroll over a hovered numeric input (number or
// range): increments (scroll up) or decrements (scroll down) the value,
// then lets the existing listeners apply it. Delegated at document level
// so dynamically created inputs (e.g. synth sliders) work too. Trackpad
// scrolls emit many tiny deltas: they are accumulated, and one step is
// applied per WHEEL_TRACKPAD_THRESHOLD accumulated units. Mouse-wheel
// notches are detected separately (isWheelNotch below) and apply exactly
// one step per physical notch.
let WHEEL_TRACKPAD_THRESHOLD = 100; // accumulated deltas per step (config: wheel_trackpad_threshold)
const WHEEL_ACCUM_RESET_MS = 200;  // scroll pause after which the accumulator resets
let wheelAccum = 0;
let wheelTime = 0;
let wheelTarget = null;

// --- Mouse-wheel notch vs trackpad (precise) scroll classification ---
// Shared by the delegated input stepper below and the synth volume wheel.
// A notch is a line/page-mode event (Firefox, some Linux webviews), or a
// pixel delta at least WHEEL_NOTCH_MIN_DELTA big that either arrives
// isolated (no wheel event for WHEEL_NOTCH_GAP_MS: on macOS WKWebView one
// wheel notch is a single ~10 px event, Chromium-based webviews send one
// ±100 px event) or continues a run of such notches (fast spin: events
// arrive faster than the gap, each still one physical notch). A trackpad
// streams events continuously (~60 Hz, momentum included) and every
// gesture starts with tiny deltas: a trackpad event is therefore never
// isolated mid-stream and never starts a run, so ALL trackpad deltas go
// through the accumulator, whose threshold fully controls the feel.
// Free-spin wheels (varying deltas, no quantization) behave the same.
// Live observation from the Web Inspector:
// localStorage.setItem('wheelDebug', '1')
const WHEEL_NOTCH_GAP_MS = 60;   // no wheel event for this long = isolated
const WHEEL_NOTCH_MIN_DELTA = 8; // smallest delta that can be a full notch
let wheelLastTime = 0;
let wheelInNotchRun = false;
const isWheelNotch = (event, delta) => {
    const gap = event.timeStamp - wheelLastTime;
    const isolated = gap > WHEEL_NOTCH_GAP_MS;
    const magnitude = Math.abs(delta);
    const notch =
        event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || // line/page mode: real wheel
        (magnitude >= WHEEL_NOTCH_MIN_DELTA && (isolated || wheelInNotchRun));
    if (localStorage.getItem('wheelDebug') === '1') {
        console.debug(`wheel: delta=${delta} mode=${event.deltaMode} gap=${Math.round(gap)}ms isolated=${isolated} run=${wheelInNotchRun} notch=${notch}`);
    }
    wheelLastTime = event.timeStamp;
    wheelInNotchRun = notch;
    return notch;
};

document.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return; // pinch zoom / ctrl+wheel: don't touch the value
    // The synth range inputs sit under a .synth-range-track overlay with
    // pointer-events on the track, so hovering the track must count too.
    // Dual-handle tracks (brightness, velocity) stack two inputs: scroll
    // drives the lower handle, Shift+scroll the upper one.
    const wrapper = event.target.closest('.bpm-input-wrapper');
    const track = event.target.closest('.synth-range-track');
    const input = wrapper
        ? wrapper.querySelector('input[type="number"]')
        : track
            ? (event.shiftKey
                ? track.querySelectorAll('input[type="range"]')[1] || track.querySelector('input[type="range"]')
                : track.querySelector('input[type="range"]'))
            : event.target.closest('input[type="number"], input[type="range"]');
    if (!input) return;
    if (input.disabled) return; // e.g. the BPM input while synced to a DAW
    event.preventDefault();

    // On macOS, Shift+scroll can translate the vertical gesture into
    // horizontal deltas (deltaY = 0): fall back to deltaX so Shift keeps
    // working there
    const delta = event.deltaY !== 0 ? event.deltaY : (event.shiftKey ? event.deltaX : 0);

    // Reset the accumulator when switching input or after a pause
    if (input !== wheelTarget || event.timeStamp - wheelTime > WHEEL_ACCUM_RESET_MS) wheelAccum = 0;
    wheelTarget = input;
    wheelTime = event.timeStamp;

    if (isWheelNotch(event, delta)) {
        wheelAccum = 0; // discrete mouse-wheel notch: one step, no accumulation
    } else {
        if (Math.sign(delta) !== Math.sign(wheelAccum)) wheelAccum = 0;
        wheelAccum += delta;
        if (Math.abs(wheelAccum) < WHEEL_TRACKPAD_THRESHOLD) return; // keep scrolling
        wheelAccum -= Math.sign(wheelAccum) * WHEEL_TRACKPAD_THRESHOLD;
    }

    const step = Number(input.step) || 1;
    const min = input.min === '' ? -Infinity : Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    const value = Math.min(max, Math.max(min,
        Number(input.value || 0) + (delta < 0 ? step : -step)));
    input.value = String(value);
    // Sliders react to "input" (live update), commit-style listeners to
    // "change" — dispatch both
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change'));
}, { passive: false });

// Keep the notch classifier's clock fresh across page scrolls (wheel
// events that never reach the input stepper above): a trackpad swipe
// crossing over an input mid-gesture must not look like an isolated
// mouse notch. Registered after the stepper so it runs after it and
// only refreshes the timestamp, never the classification inputs.
document.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return; // pinch zoom is not a scroll
    wheelLastTime = event.timeStamp;
}, { passive: true });

// Direct keyboard input: validated on blur or on "Enter"
bpmInput.addEventListener('change', () => applyBpm(Number(bpmInput.value)));

// Keyboard support: ↑/↓ arrows to increment/decrement by 1
bpmInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
        event.preventDefault(); // prevents the native <input type="number"> behavior
        applyBpm(Number(bpmInput.value) + 1);
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        applyBpm(Number(bpmInput.value) - 1);
    }
});

// Listens to ticks emitted by the Rust backend
window.__TAURI__.event.listen('metronome-tick', (event) => {
    metronomeLed.classList.add('active');
    setTimeout(() => metronomeLed.classList.remove('active'), 100);
});

// DAW sync and master clock: while an external MIDI clock (24 ppqn)
// streams in, the metronome follows it and the tempo controls are
// disabled — the backend pushes the measured BPM so the display keeps
// showing the DAW's tempo. When the clock stops, the controls are
// released and the metronome keeps running at the last synced BPM. In
// master mode the app broadcasts its own clock: the badge then shows
// the master state, and the tempo controls stay active (the user is
// the tempo's master).
const syncBadge = document.querySelector('#sync-badge');
const bpmUpBtn = document.querySelector('#bpm-up');
const bpmDownBtn = document.querySelector('#bpm-down');
const bpmControls = [bpmMinus10, bpmMinus5, bpmPlus5, bpmPlus10, bpmUpBtn, bpmDownBtn];

let metronomeSynced = false;
let metronomeMaster = false;

function setMetronomeSynced(synced, bpm) {
    metronomeSynced = synced;
    if (synced && Number.isFinite(bpm)) {
        bpmInput.value = clampBpm(bpm);
    }
    bpmInput.disabled = synced;
    bpmControls.forEach(btn => { btn.disabled = synced; });
    refreshClockBadge();
}

// The badge reflects the current clock state: "Sync DAW" (tempo
// controls locked) or "Clock master" (broadcasting to the outputs).
// The data-i18n-title follows so the contextual help matches the state.
function refreshClockBadge() {
    const master = metronomeMaster && !metronomeSynced;
    syncBadge.classList.toggle('master', master);
    syncBadge.classList.toggle('hidden', !(metronomeSynced || metronomeMaster));
    syncBadge.textContent = t(master ? 'metronome.masterBadge' : 'metronome.syncBadge');
    syncBadge.title = t(master ? 'metronome.masterBadge' : 'metronome.syncBadge');
    syncBadge.dataset.i18nTitle = master ? 'metronome.masterBadge' : 'metronome.syncBadge';
}

listen('metronome-sync', (event) => {
    const { synced, bpm, master } = event.payload;
    if (master !== undefined) metronomeMaster = Boolean(master);
    setMetronomeSynced(Boolean(synced), Number(bpm));
});

// ---------- Clock source (master / slave) ----------
const clockModeSelect = document.querySelector('#clock-mode-select');
const clockSourceSelect = document.querySelector('#clock-source-select');

const CLOCK_MODES = ['off', 'auto', 'input', 'master'];
// Persisted source applied once the port list is populated (both arrive
// asynchronously); null = nothing pending.
let pendingClockSource = null;
let clockPortsLoaded = false;

function updateClockSourceVisibility() {
    clockSourceSelect.classList.toggle('hidden', clockModeSelect.value !== 'input');
}

// Applies the config's clock mode/source to the selects once both are
// known: the mode select directly, the source once the port list has
// arrived (the stored port may have disappeared since).
function hydrateClockMode(mode, source) {
    clockModeSelect.value = CLOCK_MODES.includes(mode) ? mode : 'auto';
    if (source) {
        pendingClockSource = source;
        applyPendingClockSource();
    }
    updateClockSourceVisibility();
}

function applyPendingClockSource() {
    if (pendingClockSource === null || !clockPortsLoaded) return;
    const name = pendingClockSource;
    pendingClockSource = null;
    const option = clockSourceSelect.querySelector(`option[value="${CSS.escape(name)}"]`);
    if (option) {
        clockSourceSelect.value = name;
    } else {
        // The saved input port no longer exists (device unplugged, or no
        // input port at all): revert to Auto on both sides, the backend
        // included (the change persists, like any mode change)
        clockModeSelect.value = 'auto';
        updateClockSourceVisibility();
        invoke('set_clock_mode', { mode: 'auto', source: null })
            .catch(err => console.error('Error in set_clock_mode:', err));
    }
}

// Input ports offered as the sync source, populated once at startup
// (the backend opens every input port for the app's lifetime). The
// app's own virtual port is the route a DAW's MIDI clock takes.
invoke('list_midi_input_ports').then(ports => {
    clockSourceSelect.innerHTML = ports.map(p =>
        `<option value="${p.name}">${p.isVirtual ? t('metronome.virtualSource') : p.name}</option>`
    ).join('');
    // Without any input port the "Source…" mode is meaningless
    clockModeSelect.querySelector('option[value="input"]').disabled = ports.length === 0;
    clockPortsLoaded = true;
    applyPendingClockSource();
}).catch(err => console.error('Error in list_midi_input_ports:', err));

function applyClockMode() {
    const mode = clockModeSelect.value;
    updateClockSourceVisibility();
    // Guard: "Source…" needs a selected port (an empty list disables the
    // option, but stay safe against a stale select)
    if (mode === 'input' && !clockSourceSelect.value) {
        clockModeSelect.value = 'auto';
        return;
    }
    invoke('set_clock_mode', {
        mode,
        source: mode === 'input' ? clockSourceSelect.value : null,
    }).catch(err => console.error('Error in set_clock_mode:', err));
}

clockModeSelect.addEventListener('change', applyClockMode);
clockSourceSelect.addEventListener('change', applyClockMode);

// Programs learned from the MIDI input (Program Change / Bank Select
// turned on the instruments): update the map and every synth concerned.
window.__TAURI__.event.listen('midi-program', (event) => {
    const { port, channel, program } = event.payload;
    programMap.set(programKey(port, channel), program);
    refreshProgramDisplays(port, channel);
});

// Hydrate the programs already learned before this page was ready
invoke('get_known_programs').then(entries => {
    entries.forEach(({ port, channel, program }) => {
        programMap.set(programKey(port, channel), program);
    });
}).catch(err => console.error('Error in get_known_programs:', err));

// ==========================================
// Synthesizers
// ==========================================
const addSynthBtn   = document.querySelector('#add-synth-btn');
const playAllBtn    = document.querySelector('#play-all-btn');
const synthListBody = document.querySelector('.synth-list-body');
const synthTabs     = document.querySelector('.synth-tabs');
const synthDevices  = document.querySelector('.synth-devices-wrapper');
const placeholder   = synthListBody.querySelector('.placeholder-text');

// Initial state of the play-all button: icon and label ship empty in the
// markup, this fills them for the current locale
syncPlayAllButton();

// The full synth card in the devices column
function synthElementById(id) {
    return synthDevices.querySelector(`.synth-block[data-synth-id="${id}"]`);
}

// The compact tab in the tabs column
function synthTabById(id) {
    return synthTabs.querySelector(`.synth-tab[data-synth-id="${id}"]`);
}

// Reflects the synth's channel volume on its tab: the bottom bar's
// width follows the volume, expressed as a percentage of the MIDI
// range 0–127 (see .synth-tab-volume-bar).
function setTabVolumeBar(tab, volume) {
    const v = Math.max(0, Math.min(127, volume));
    tab?.style.setProperty('--synth-volume', `${(v / 127 * 100).toFixed(2)}%`);
}

// Reflects a newly created synth's backend state (built from the
// default-synth template) into its UI. No backend calls needed: the state
// is already applied server-side.
function applySynthConfig(el, cfg) {
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
function noteRangeGroup() {
    return `
        <div class="synth-note-range">
            <button class="synth-bass icon-btn" data-i18n-title="synth.noteRangeBass">𝄢</button>
            <button class="synth-medium icon-btn" data-i18n-title="synth.noteRangeMedium">𝄡</button>
            <button class="synth-treble icon-btn" data-i18n-title="synth.noteRangeTreble">𝄞</button>
        </div>`;
}

function createSynthElement(id, cfg = null) {
    const el = document.createElement('div');
    el.className = 'synth-block';
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
    const tab = document.createElement('div');
    tab.className = 'synth-tab';
    tab.dataset.synthId = id;
    tab.title = synthDisplayName(id);
    tab.innerHTML = `
        <button class="synth-tab-drag-handle" data-i18n-title="synth.dragHandle" tabindex="-1">
            <span class="material-symbols-outlined" aria-hidden="true">drag_indicator</span>
        </button>
        <button class="synth-tab-play" tabindex="-1">
            <span class="material-symbols-outlined synth-play-icon" aria-hidden="true">play_arrow</span>
            <span class="synth-play-label"></span>
        </button>
        <div class="synth-tab-volume-bar"></div>`;
    const tabPlayBtn = tab.querySelector('.synth-tab-play');
    setPlayButtonState(tabPlayBtn, false);
    tabPlayBtn.addEventListener('click', () => onSynthPlayClick(id, el));
    initTabDrag(tab, el);
    synthTabs.appendChild(tab);
    el._tab = tab;

    // Color: reuse a pre-seeded entry (session load), or take the first
    // palette color not already used by another synth — falling back to
    // rotation when the palette is exhausted
    const seededColor = synthColors.get(id);
    const usedColors = new Set(synthColors.values());
    const defaultColor = seededColor
        || SYNTH_COLORS.find(c => !usedColors.has(c))
        || SYNTH_COLORS[(synthColors.size) % SYNTH_COLORS.length];
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

    const colorSwatches = SYNTH_COLORS.map(c =>
        `<button class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('');

    el.innerHTML = `        <div class="synth-color-band" style="background:${defaultColor}" data-i18n-title="synth.pickColor"></div>
        <div class="synth-color-picker hidden">
            <div class="color-swatches">${colorSwatches}</div>
        </div>
        <div class="synth-header">
            <div class="synth-header-row">
                <select class="synth-midi-port" data-i18n-title="synth.midiPort"></select>
                <select class="synth-channel">${channelOptions}</select>
                <div class="flex-fill"></div>
                <button class="synth-save-template icon-btn" data-i18n-title="synth.saveAsTemplate">
                    <span class="material-symbols-outlined" aria-hidden="true">bookmark_add</span>
                </button>
                <button class="synth-toggle-full-options icon-btn" data-i18n-title="synth.toggleFullOptions">
                        <span class="material-symbols-outlined" aria-hidden="true">collapse_all</span>
                    </button>
                <button class="synth-remove icon-btn" data-i18n-title="synth.remove">
                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>
                <div class="synth-header-row">
                    <div class="synth-title-label" data-i18n-title="synth.renameHint"></div>
                    <div class="synth-section-program-change" data-i18n-title="synth.programEditHint">
                        <span class="program-label" data-i18n="synth.programLabel"></span>
                        <select class="program-bank-manual" data-i18n-title="synth.programBankManual">${bankOptions}</select>
                        <input type="number" class="program-number-manual" placeholder="-" min="1" max="128" step="1" data-i18n-title="synth.programManual" />
                    </div>
                </div>
        </div>
        <div class="synth-body">
            <div class="synth-section">
                <div class="synth-section-header">
                    <span class="synth-section-title" data-i18n="synth.zonesLabel"></span>
                    <em class="synth-section-value zones-val"></em>
                    <div class="flex-fill"></div>
                    <button class="synth-add-zone-btn icon-btn" data-i18n-title="synth.addZone">
                        <span class="material-symbols-outlined" aria-hidden="true">select</span>
                    </button>
                    <button class="synth-lasso-add-zone-btn icon-btn" data-i18n-title="synth.addZoneLasso">
                        <span class="material-symbols-outlined" aria-hidden="true">lasso_select</span>
                    </button>
                    <button class="synth-magic-wand-add-zone-btn icon-btn" data-i18n-title="synth.addZoneMagicWand">
                        <span class="material-symbols-outlined" aria-hidden="true">wand_shine</span>
                    </button>
                    <input type="number" class="magic-wand-tolerance" value="32" min="1" max="255" step="1" data-i18n-title="synth.magicWandTolerance" />
                    <button class="synth-select-all-btn icon-btn" data-i18n-title="synth.selectAllZones">
                        <span class="material-symbols-outlined" aria-hidden="true">select_all</span>
                    </button>
                    <button class="synth-clear-zones-btn icon-btn" data-i18n-title="synth.clearZones">
                        <span class="material-symbols-outlined" aria-hidden="true">remove_selection</span>
                    </button>
                    <div class="flex-fill"></div>
                    
                    <button class="synth-eye-btn icon-btn active" data-i18n-title="synth.toggleHighlight"><span class="material-symbols-outlined" aria-hidden="true">visibility</span></button>
                </div>
            </div>

            <div class="synth-section synth-playback">
                <div class="synth-section-header">
                    <span class="synth-section-title" data-i18n="synth.playbackTitle"></span>
                    <div class="flex-fill"></div>
                    <select class="synth-tempo" data-i18n-title="synth.tempoRatio">
                        <option value=1>1/1</option>
                        <option value=0.75>3/4</option>
                        <option value=0.66>2/3</option>
                        <option value=0.5>1/2</option>
                        <option value=0.33>1/3</option>
                        <option value=0.25>1/4</option>
                    </select>
                    <div class="flex-fill"></div>                    
                    <select class="synth-reading-direction" data-i18n-title="synth.readingDirectionTitle">${readingDirectionOptions}</select>
                    <button class="synth-sort-btn icon-btn" data-i18n-title="synth.toggleSort"><span class="material-symbols-outlined" aria-hidden="true">sort</span></button>
                    <div class="flex-fill"></div>
                    <button class="synth-loop-btn icon-btn active" data-i18n-title="synth.toggleLoop">
                        <span class="material-symbols-outlined" aria-hidden="true">laps</span>
                    </button>
                    <button class="synth-back-n-forth-btn icon-btn" data-i18n-title="synth.toggleBackAndForth">
                        <span class="material-symbols-outlined" aria-hidden="true">sync_alt</span>
                    </button>    
                </div>
                
                <div class="synth-section-body center extra-margin">
                    <span class="material-symbols-outlined" aria-hidden="true">volume_up</span>
                    <input type="number" class="synth-volume" min="0" max="127" step="1" value="127" data-i18n-title="synth.volume" />
                    <div class="flex-filler grow"></div>
                    <button class="synth-rewind icon-btn" data-i18n-title="synth.rewind">
                        <span class="material-symbols-outlined" aria-hidden="true">fast_rewind</span>
                    </button>
                    <button class="synth-play">
                        <span class="material-symbols-outlined synth-play-icon" aria-hidden="true">play_arrow</span>
                        <span class="synth-play-label"></span>
                    </button>
                    <button class="synth-step-forward icon-btn" data-i18n-title="synth.stepForward">
                        <span class="material-symbols-outlined" aria-hidden="true">step</span>
                    </button>    
                </div>
            </div>

            <div class="synth-section">
                <div class="synth-section-header">
                    <button class="synth-mode-btn toggle-btn active" data-mode="monophonic"></button>
                    <button class="synth-mode-btn toggle-btn" data-mode="polyphonic"></button>
                </div>
            </div>

            <div class="synth-full-options">
                <div class="synth-mode-panel synth-mode-panel-mono">
                    <div class="synth-section">
                        <div class="synth-section-header">
                            <span class="synth-section-title" data-i18n="synth.noteRangeTitle" data-i18n-title="synth.noteRangeTitle"></span>
                        </div>
                        <div class="synth-section-body">
                            ${noteRangeGroup()}
                            <select class="synth-scale" data-i18n-title="synth.scale"></select>
                            <select class="synth-scale-root" data-i18n-title="synth.scaleRoot"></select>
                        </div>
                    </div>
                    <div class="synth-section">
                        <div class="synth-section-header">
                            <span class="synth-section-title" data-i18n="synth.hueShift" data-i18n-title="synth.hueShift"></span>
                            <em class="synth-section-value hue-shift-val">0°</em>
                        </div>
                        <div class="synth-section-body">
                            <input type="range" class="synth-hue-shift gradient-hue" min="0" max="360" value="0" step="1" />
                        </div>
                    </div>
                </div>

                <div class="synth-mode-panel synth-mode-panel-poly hidden">
                    <div class="synth-section">
                        <div class="synth-section-header">
                            <span class="synth-section-title" data-i18n="synth.channelsPanelLabel"></span>
                            <select class="synth-scale" data-i18n-title="synth.scale"></select>
                            <select class="synth-scale-root" data-i18n-title="synth.scaleRoot"></select>
                        </div>
                        <div class="synth-section-body">
                            <div class="synth-channel-toggles">
                                <div class="synth-channel-toggle-group">
                                    <button class="synth-channel-toggle channel-red active" data-channel="0" data-i18n-title="synth.toggleRed">R</button>
                                    ${noteRangeGroup()}
                                </div>
                                <div class="synth-channel-toggle-group">
                                    <button class="synth-channel-toggle channel-green active" data-channel="1" data-i18n-title="synth.toggleGreen">G</button>
                                    ${noteRangeGroup()}
                                </div>
                                <div class="synth-channel-toggle-group">
                                    <button class="synth-channel-toggle channel-blue active" data-channel="2" data-i18n-title="synth.toggleBlue">B</button>
                                    ${noteRangeGroup()}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="synth-section">
                    <div class="synth-section-header">
                        <span class="synth-section-title" data-i18n="synth.noteLengthsTitle"></span>
                        <div class="flex-fill"></div>
                        <button class="synth-reverse-note-length icon-btn" data-i18n-title="synth.reverseNoteLength">
                            <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
                        </button>
                        <button class="synth-note-sustain icon-btn" data-i18n-title="synth.noteSustain">
                            <span class="material-symbols-outlined" aria-hidden="true">touch_long</span>
                        </button>
                    </div>
                    <div class="synth-section-body synth-note-length-section">
                        <button class="note-length-btn noto-music icon-btn" data-length="sixteenth" data-i18n-title="synth.noteLengthSixteenth">𝅘𝅥𝅯</button>
                        <button class="note-length-btn noto-music icon-btn" data-length="eighth" data-i18n-title="synth.noteLengthEighth">𝅘𝅥𝅮</button>
                        <button class="note-length-btn noto-music icon-btn active" data-length="quarter" data-i18n-title="synth.noteLengthQuarter">𝅘𝅥</button>
                        <button class="note-length-btn noto-music icon-btn" data-length="half" data-i18n-title="synth.noteLengthHalf">𝅗𝅥</button>
                        <button class="note-length-btn noto-music icon-btn" data-length="whole" data-i18n-title="synth.noteLengthWhole">𝅝</button>
                    </div>
                </div>
                <div class="synth-section">
                    <div class="synth-section-header">
                        <span class="synth-section-title" data-i18n="synth.brightnessThreshold" data-i18n-title="synth.brightnessThreshold"></span>
                        <em class="synth-section-value"><span class="brightness-start-val">0</span> – <span class="brightness-end-val">127</span></em>
                    </div>
                    <div class="synth-section-body synth-range-track">
                        <div class="synth-range-fill gradient-wb"></div>
                        <input type="range" class="synth-range-input brightness-start" min="0" max="127" value="0" step="1" />
                        <input type="range" class="synth-range-input brightness-end" min="0" max="127" value="127" step="1" />
                    </div>
                </div>

                <div class="synth-section">
                    <div class="synth-section-header">
                        <span class="synth-section-title" data-i18n="synth.velocityRange" data-i18n-title="synth.velocityRange"></span>
                        <em class="synth-section-value"><span class="velocity-min-val">0</span> – <span class="velocity-max-val">127</span></em>   
                        <div class="flex-fill"></div> 
                        <button class="synth-relative-velocity-range icon-btn active" data-i18n-title="synth.velocityRelative">
                            <span class="material-symbols-outlined" aria-hidden="true">arrow_or_edge</span>
                        </button>                    
                    </div>
                    <div class="synth-section-body synth-range-track">
                        <div class="synth-range-fill"></div>
                        <input type="range" class="synth-range-input velocity-min" min="0" max="126" value="0" step="1" />
                        <input type="range" class="synth-range-input velocity-max" min="0" max="127" value="127" step="1" />
                    </div>
                </div>

                <p class="synth-pixel-info"></p>
            </div>
        </div>
    `;

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
    // accumulated instead, and one step is applied per
    // WHEEL_TRACKPAD_THRESHOLD accumulated units, so a trackpad swipe
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
        const steps = Math.trunc(volumeWheelAccum / WHEEL_TRACKPAD_THRESHOLD);
        if (steps === 0) return;
        volumeWheelAccum -= steps * WHEEL_TRACKPAD_THRESHOLD;
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
        pushMirrorZones();
    });

    // Zone drawing: arm/cancel the rectangle-drawing mode on the image.
    // Clicking while the lasso is armed switches to the rectangle mode
    // right away instead of merely disarming the lasso.
    el.querySelector('.synth-add-zone-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (zonePickState && zonePickState.id === id && zonePickState.mode === 'rect') {
            cancelZonePicking();
        } else {
            startZonePicking(id, btn);
        }
    });

    // Lasso: arm/cancel the free-hand selection mode on the image
    el.querySelector('.synth-lasso-add-zone-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (zonePickState && zonePickState.id === id && zonePickState.mode === 'lasso') {
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
        if (zonePickState && zonePickState.id === id && zonePickState.mode === 'wand') {
            cancelZonePicking();
        } else {
            startZonePicking(id, btn, 'wand');
        }
    });

    // Select all: the whole image as a single zone (one run per row,
    // no cell enumeration — a large grid must not materialize every
    // cell as a key)
    el.querySelector('.synth-select-all-btn').addEventListener('click', () => {
        if (!hasImage) return;
        const hi = synthHighlights.get(id);
        if (!hi) return;
        if (zonePickState && zonePickState.id === id) cancelZonePicking();
        hi.zones = [rectZone(0, 0, gridW, gridH)];
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

function updateAllSynthZones() {
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        const synthId = Number(el.dataset.synthId);
        const hi = synthHighlights.get(synthId);
        if (!hi) return;

        // Clip the zones to the new grid: cells outside disappear,
        // then the components are recomposed (a clip can split one)
        const cells = zoneCellSet(hi.zones);
        const kept = new Set([...cells].filter(k => {
            const [col, row] = k.split(',').map(Number);
            return col < gridW && row < gridH;
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
function anchorHueGradient(input, hueShift) {
    input.style.setProperty('--hue-rot', `${(360 - Number(hueShift) % 360) % 360}deg`);
}

// The id is read from the DOM at event time (not captured at creation),
// so the listeners survive the id renumbering that follows the display
// order (see renumberSynthIds).
function initBrightnessRange(el) {
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

function initVelocityRange(el) {
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

async function onSynthPlayClick(id, el) {
    const isPlaying = await invoke('is_synth_playing', { id });
    if (!isPlaying) {
        await startSynthPlayback(id, el);
    } else {
        await stopSynthPlayback(id, el);
    }
    syncPlayAllButton();
}

// Updates the "play all" button's label based on the synths' current state
function syncPlayAllButton() {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    const anyPlaying = blocks.some(el => el.querySelector('.synth-play').classList.contains('active'));
    playAllBtn.querySelector('.material-symbols-outlined').textContent = anyPlaying ? 'pause' : 'play_arrow';
    playAllBtn.querySelector('.play-all-label').textContent = anyPlaying
        ? t('synthList.stopAllLabel')
        : t('synthList.playAllLabel');
    playAllBtn.title = anyPlaying
        ? t('synthList.playAllStop')
        : t('synthList.playAllStart');
}

// CC 7 addresses the MIDI channel, not the synth: several synths sharing
// the same (port, channel) override each other's volume — the last
// setting sent wins. Flags the volume inputs and the channel selects of
// every synth in that case with the shared-channel warning style and
// tooltip.
function updateVolumeSharedChannelWarnings() {
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
function setSynthControlsLocked(el, locked) {
    el.querySelector('.synth-channel').disabled = locked;
    el.querySelector('.synth-midi-port').disabled = locked;
    el.querySelectorAll('.synth-mode-btn').forEach(btn => { btn.disabled = locked; });
    el.querySelector('.synth-step-forward').disabled = locked;
}

async function startSynthPlayback(id, el) {
    await ensureMetronomeStarted();
    await invoke('start_synth', { id });
    setSynthPlaying(id, true);
    // Lock this synth's controls while it is playing
    setSynthControlsLocked(el, true);
    updateImageControlsLockState();
}

async function stopSynthPlayback(id, el) {
    await invoke('stop_synth', { id });
    setSynthPlaying(id, false);
    await stopMetronomeIfIdle();
    // Unlock this synth's controls
    setSynthControlsLocked(el, false);
    updateImageControlsLockState();
}

// Keeps the eye button's active state in sync with the actual highlight
// visibility, wherever that state is changed programmatically
function syncEyeButton(el, visible) {
    const btn = el?.querySelector('.synth-eye-btn');
    if (btn) btn.classList.toggle('active', visible);
}


// ---------- Tab drag & drop (stack reordering) ----------
// Reorders the synths by dragging a tab's handle. The tabs move live
// during the drag; on release the devices column is mirrored to the same
// order and the ids are renumbered to match it (1..N, top to bottom).
// Brings a synth's device card fully into the devices column's view.
// When the card isn't entirely visible, it is aligned with the top of
// the view (smooth scroll) — the clicked tab's synth then reads as the
// current head of the stack. No-op when the card is already fully
// visible.
function scrollSynthCardIntoView(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const view = synthDevices.getBoundingClientRect();
    const topInView = rect.top - view.top; // < 0: cut above, > 0: below or cut
    const fullyVisible = topInView >= 0 && rect.bottom <= view.bottom;
    if (fullyVisible) return;
    synthDevices.scrollBy({ top: topInView, behavior: 'smooth' });
}

function initTabDrag(tab, el) {
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
async function renumberSynthIds() {
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
        if (zonePickState && zonePickState.id === oldId) zonePickState.id = newId;
        if (zoneDrag && zoneDrag.id === oldId) zoneDrag.id = newId;
        if (lassoDrag && lassoDrag.id === oldId) lassoDrag.id = newId;
    });
}

// Double-click confirmation for synth removal: only one remove button can
// be armed at a time; the arming auto-expires after the delay below.
const SYNTH_REMOVE_CONFIRM_DELAY_MS = 3000;
let armedSynthRemoveBtn = null;
let armedSynthRemoveTimer = null;

function resetSynthRemoveConfirm() {
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

async function onSynthRemoveClick(id, el) {
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
    await invoke('stop_synth', { id }).catch(() => {});
    await invoke('remove_synth', { id });

    if (zonePickState && zonePickState.id === id) cancelZonePicking();

    synthColors.delete(id);
    eraseSynthCursor(id);
    synthHighlights.delete(id);
    synthBrightnessBounds.delete(id);
    synthNames.delete(id);
    // The dropped entry only cleans the map: the number itself stays
    // retired (the backend counter never reuses it)
    synthDisplayNumbers.delete(id);
    el._tab?.remove();
    el.remove();
    await renumberSynthIds();
    redrawAllHighlights();
    updateVolumeSharedChannelWarnings();

    if (synthListBody.querySelectorAll('.synth-block').length === 0) {
        placeholder.classList.remove('hidden');
    }
    syncPlayAllButton();
    await stopMetronomeIfIdle();
    updateImageControlsLockState();
}

addSynthBtn.addEventListener('click', async () => {
    try {
        const synth = await invoke('add_synth');
        placeholder.classList.add('hidden');
        const el = createSynthElement(synth.id, synth);
        synthDevices.appendChild(el);
        // Bring the newly created card into view (new synths stack at the
        // end of the list, potentially below the fold)
        scrollSynthCardIntoView(el);
    } catch (err) {
        console.error('Error while adding the synthesizer:', err);
        alert(translateError(err)); // or a more discreet display like a toast/error message in the UI
    }
});

// ---------- Start/stop all synthesizers ----------
playAllBtn.addEventListener('click', async () => {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    if (blocks.length === 0) return;

    // We consider the whole set "playing" if at least one synth is already playing.
    const anyPlaying = blocks.some(el => el.querySelector('.synth-play').classList.contains('active'));

    if (anyPlaying) {
        // Stop everything
        for (const el of blocks) {
            const id = Number(el.dataset.synthId);
            if (el.querySelector('.synth-play').classList.contains('active')) {
                await stopSynthPlayback(id, el);
            }
        }
    } else {
        // Start everything
        for (const el of blocks) {
            const id = Number(el.dataset.synthId);
            await startSynthPlayback(id, el);
        }
    }
    syncPlayAllButton();
});

// Kill switch: stop every synthesizer and cut all sounding notes
const panicBtn = document.querySelector('#panic-btn');
panicBtn.addEventListener('click', async () => {
    await invoke('panic_all');
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        setSynthPlaying(Number(el.dataset.synthId), false);
        setSynthControlsLocked(el, false);
    });
    syncPlayAllButton();
    await stopMetronomeIfIdle();
    updateImageControlsLockState();
});

// Automatic stop at the end of the sequence (non-loop mode)
window.__TAURI__.event.listen('synth-stopped', async (event) => {
    const { id } = event.payload;
    const el = synthElementById(id);
    if (!el) return;
    setSynthPlaying(id, false);
    eraseSynthCursor(id);
    syncPlayAllButton();
    await stopMetronomeIfIdle();
    // Unlock this synth's controls
    setSynthControlsLocked(el, false);
    updateImageControlsLockState();
});

// Receiving pixel ticks, one per synth
window.__TAURI__.event.listen('synth-pixel-tick', (event) => {
    const { id, cursor, w, h, r, g, b, velocity, muted, mode, note, voices } = event.payload;
    const el = synthElementById(id);
    if (!el) return;

    // The tick carries the grid its cursor was computed on: during a
    // live column-count change, ticks emitted after the backend swap can
    // arrive before the change's response — adopt the new dimensions
    // right away so the playhead is drawn at the right cell (the painted
    // image catches up when the response lands)
    const tickW = Number.isFinite(w) ? w : gridW;
    const tickH = Number.isFinite(h) ? h : gridH;
    if (tickW !== gridW || tickH !== gridH) {
        gridW = tickW;
        gridH = tickH;
    }

    const rgbStr = `rgb(${r ?? '-'}, ${g ?? '-'}, ${b ?? '-'})`;
    const tslStr = rgbToTslStr(r, g, b);
    let noteInfo;

    if (mode === 'polyphonic' && Array.isArray(voices)) {
        const labels = ['R', 'G', 'B'];
        noteInfo = voices.map((v, i) => {
            if (!v.enabled) return t('synth.voiceOff', { channel: labels[i] });
            const name = midiNoteToName(v.note);
            return v.muted
                ? t('synth.voiceMuted', { channel: labels[i], note: name })
                : `${labels[i]}:${name}`;
        }).join('  ');
    } else {
        const noteName = midiNoteToName(note);
        noteInfo = t('synth.noteLabel', { note: noteName }) + (muted ? t('synth.noteMuted') : '');
    }

    const pixelInfoEl = el.querySelector('.synth-pixel-info');
    pixelInfoEl.textContent = t('synth.pixelInfo', { cursor, rgb: rgbStr, tsl: tslStr, noteInfo, velocity: velocity ?? '-' });
    pixelInfoEl.dataset.hasTick = '1';
    // Abort an erasing drag when the playhead has entered the zone being
    // edited: let the cursor play, the locked zone stays untouched
    cancelEraseDragOnLockedZone(id, cursor, tickW);
    drawSynthPixel(id, cursor, muted, tickW, tickH);
});

// Converts RGB (0–255) to HSL: hue in degrees 0–360, saturation and
// lightness in percent 0–100.
function rgbToHsl(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return [0, 0, Math.round(l * 100)];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

// Formats the TSL (teinte, saturation, luminosité) values of a pixel for the info line
function rgbToTslStr(r, g, b) {
    if (r == null || g == null || b == null) return '-';
    const [h, s, l] = rgbToHsl(r, g, b);
    return `${h}°, ${s}%, ${l}%`;
}

// Formats a MIDI note as "C4 (60)" for the pixel info line
function midiNoteToName(midi) {
    if (midi == null) return '-';
    return `${midiNoteName(midi)} (${midi})`;
}
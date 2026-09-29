import { initI18n, t, translateError, getLocale, setLocale, AVAILABLE_LOCALES } from './core/i18n.js';
import { loadTemplates } from './core/templates.js';
import { MUTE_GLYPH } from './core/geometry.js';
import { seedZoneOrder } from './core/geometry.js';
import { rgbToTslStr } from './core/utils.js';
import { midiNoteToName } from './core/utils.js';
import { createChrono } from './core/timing.js';
import { appEvents } from './core/state.js';
import { viewer } from './core/state.js';
import { registerShortcut, registerEscape, runEscapeChain, digitIndex, SCOPE } from './core/shortcuts.js';
import { installFocusPolicy, enterConsumed, spaceConsumed, digitConsumed } from './core/focus.js';
import {
    synthNames, synthColors, synthHighlights,
    synthCursors, synthCursorGrid, synthCursorMuted,
    clearSynthRegistry,
} from './core/state.js';
import { sliderToPosterizeLevels, posterizeLevelsToSlider } from './core/utils.js';
import { installInputStepper, setTrackpadThreshold } from './audio/stepper.js';
import { createClockSource } from './audio/metronome.js';
import { createMetronome, clampBpm } from './audio/metronome.js';
import { createMirror } from './mirror/window.js';
import { createSessionState } from './session/session.js';
import { setSynthColors, setNoteRangeBounds, setEnabledScales, refreshScaleSelects } from './synth/model.js';
import { synthElementById } from './synth/model.js';
import { updateZonesLabel, updateAllSynthZonesLabels } from './synth/model.js';
import {
    addSynthZone, removeSynthZoneRect,
    rectOverlapsMuteZones, addSynthMuteRect, removeSynthMuteRect,
} from './synth/selection.js';
import { programMap, programKey, refreshProgramDisplays } from './synth/model.js';
import { setSynthPlaying, retranslateSynthElement, syncEyeButton } from './synth/model.js';
import {
    resizeOverlay, drawSynthPixel, eraseSynthCursor, clearOverlay,
    computeMuteCells, redrawAllHighlights,
} from './synth/selection.js';
import {
    zoneState, cancelZonePicking, zoneDragRect,
    cellFromClientPoint, imagePointFromClient, drawZonePreview, drawLassoPreview,
    wandTogglePixels, wandToggleMutePixels, lassoTogglePixels, lassoToggleMutePixels,
    rectOverlapsZones,
} from './synth/selection.js';
import {
    createSynthElement, onSynthPlayClick, syncPlayAllButton,
    setSynthControlsLocked, startSynthPlayback, stopSynthPlayback,
    scrollSynthCardIntoView, renumberSynthIds, configureSynthCards,
    toggleSynthMute, cancelTransientTools,
} from './synth/cards.js';
import {
    syncLabels, updatePreviewSrc, refresh, exitCropMode, closeTransformPanel,
    isTransformActive, redrawTransformOverlay,
    cropState, cropDragTargetAt, updateCropDrag, drawCropOverlay,
    applyCropRatioToRect, clampCropRect, CROP_HANDLE_CURSORS,
    cropApplyBtn, transformApplyBtn, refreshDimensionsInfo, configureImageEditor,
} from './image/editor.js';

const { invoke } = window.__TAURI__.core;

await initI18n();

// Load the editable HTML layout templates (src/templates/*.html) once,
// before any synth card gets built. Without them no synth UI can be
// built: surface the failure visibly instead of silently dying into a
// zombie window with dead buttons, then stop the module.
try {
    await loadTemplates();
} catch (err) {
    console.error('Error while loading the HTML templates:', err);
    alert(translateError(err));
    throw err;
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


// ---------- Global configuration ----------
// The BPM input is initialized with the persisted default; the config
// file itself is hand-edited via the gear button in the footer (edits
// apply on the next application start).
invoke('get_config').then(config => {
    metronome.setBpm(config.default_bpm);
    // Trackpad scroll feel of the wheel-driven steppers (BPM, sliders,
    // synth volume): accumulated deltas per increment. The backend
    // already clamps the persisted value; validate defensively anyway.
    setTrackpadThreshold(config.wheel_trackpad_threshold);
    if (Array.isArray(config.synth_colors) && config.synth_colors.length > 0) {
        setSynthColors(config.synth_colors);
    }
    if (Array.isArray(config.note_range_bounds) && config.note_range_bounds.length === 3) {
        setNoteRangeBounds(config.note_range_bounds.map(([lo, hi]) => {
            const l = Math.min(Number(lo), Number(hi));
            const h = Math.max(Number(lo), Number(hi));
            return [Math.max(0, Math.min(127, l)), Math.max(0, Math.min(127, h))];
        }));
    }
    // Enabled scales: unknown values are dropped, chromatic is always
    // kept. Synth cards created before the config arrived are refreshed.
    if (Array.isArray(config.enabled_scales)) {
        setEnabledScales(config.enabled_scales);
    }
    document.querySelectorAll('.synth-block').forEach(el => refreshScaleSelects(el));
    // Clock source of the metronome (master / slave), persisted by the
    // backend and applied live on its side; the selects just reflect it.
    clockSource.hydrate(config.clock_mode, config.clock_source);
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
    refreshDimensionsInfo();
    if (typeof syncPlayAllButton === 'function') syncPlayAllButton();
    // The clock badge's label is locale-dependent too
    metronome.refreshBadge();
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

// Leaving help mode is the lowest-priority Escape target (see the shortcut
// registry): momentary popovers and active modes are cancelled first.
registerEscape(10, () => helpModeEnabled, () => setHelpMode(false));

// ---------- Elements ----------
const loadBtn         = document.querySelector('#load-btn');
const resetBtn        = document.querySelector('#reset-btn');
const rotateBtn       = document.querySelector('#rotate-img-btn');
const cropBtn         = document.querySelector('#crop-img-btn');
const transformBtn    = document.querySelector('#transform-img-btn');
const showOriginalBtn = document.querySelector('#show-original-btn');
const viewerEmpty     = document.querySelector('#viewer-empty');
const pixelOverlay    = document.querySelector('#pixel-overlay');

const gridSlider      = document.querySelector('#grid-width');

const vibrance        = document.querySelector('#vibrance');
const contrast        = document.querySelector('#contrast');
const brightness      = document.querySelector('#brightness');
const posterize       = document.querySelector('#posterize');
const texture         = document.querySelector('#texture');
const clarity         = document.querySelector('#clarity');
const simplify        = document.querySelector('#simplify');
const autoLevelsBtn   = document.querySelector('#auto-levels-btn');

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
    // Every play-state transition flows through here (synth start/stop,
    // play all, panic, automatic end-of-sequence stop, synth removal,
    // session restore) — the chrono rides along the same central hook,
    // decoupled through the event bus
    appEvents.emit('play-state-changed', anyPlaying);
}

// ---------- Chrono ----------
// Elapsed-play timer (see chrono.js): bound to its display and reset
// button, probing the play state through anySynthPlaying.
const chrono = createChrono({
    display: document.querySelector('#chrono .timer'),
    resetButton: document.querySelector('#reset-timer'),
    isPlaying: anySynthPlaying,
});
appEvents.on('play-state-changed', () => chrono.sync());
// Every play-state transition (start/stop, play all, panic, end of sequence,
// removal, session load) flows through updateImageControlsLockState, which
// emits this event: keeping the play-all button on the same hook guarantees
// its colour never lags the actual state.
appEvents.on('play-state-changed', () => syncPlayAllButton());


// Escape cancels the topmost transient UI only — press it again to go
// deeper. The other targets (crop, transform, zone picking) register their
// own handlers from their modules; this file owns the popovers and the
// single global Escape binding that runs the chain.
registerEscape(50,
    () => !!document.querySelector('.synth-color-picker:not(.hidden)'),
    () => document.querySelectorAll('.synth-color-picker').forEach(p => p.classList.add('hidden')));

// ---------- Global shortcuts ----------
// Declarative bindings handled by core/shortcuts.js (single listener, modal
// scope, auto-repeat ignored). Enter commits the pending crop or perspective
// correction (the buttons' own guards make it a no-op when nothing is
// pending). Space toggles every synth, Shift+Space is the panic kill switch.
// Bare 1-8 bring the N-th synth's card into view (like releasing its tab);
// Cmd/Ctrl+1-8 toggle its playback from any focus (even a text field);
// Alt+1-8 mute/unmute it. The digit is resolved by digitIndex (core/
// shortcuts.js), robust to the keyboard layout and to Option rewriting
// `event.key`; Space and the bare digits yield to widgets that consume them
// (see core/focus.js).
// Note: Cmd+M would be reserved by a standard macOS menu (minimize) if one
// is ever added.
// Physical digit pressed (1-8) is resolved by digitIndex (core/shortcuts.js),
// which is layout- and modifier-independent (see its comment).
function nthSynthBlock(index) {
    if (!index) return null;
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    return blocks[index - 1] || null;
}

registerShortcut({
    id: 'commit-crop-transform', key: 'Enter', scope: SCOPE.GLOBAL,
    when: e => !enterConsumed(e.target),
    run: () => {
        if (cropState.mode) cropApplyBtn.click();
        else if (isTransformActive()) transformApplyBtn.click();
    },
});

registerShortcut({
    id: 'play-all', key: ' ', scope: SCOPE.GLOBAL, primary: false, alt: false, shift: false,
    when: e => !spaceConsumed(e.target),
    run: () => playAllBtn.click(),
});

registerShortcut({
    id: 'panic', key: ' ', scope: SCOPE.GLOBAL, primary: false, alt: false, shift: true,
    when: e => !spaceConsumed(e.target),
    run: () => panicBtn.click(),
});

registerShortcut({
    id: 'synth-reveal', match: e => digitIndex(e) > 0, scope: SCOPE.GLOBAL, primary: false, alt: false,
    when: e => !digitConsumed(e.target),
    run: e => {
        const el = nthSynthBlock(digitIndex(e));
        if (el) scrollSynthCardIntoView(el);
    },
});

registerShortcut({
    id: 'synth-toggle', match: e => digitIndex(e) > 0, scope: SCOPE.GLOBAL, primary: true, alt: false,
    run: e => {
        const el = nthSynthBlock(digitIndex(e));
        if (el) onSynthPlayClick(Number(el.dataset.synthId), el);
    },
});

registerShortcut({
    id: 'synth-mute', match: e => digitIndex(e) > 0, scope: SCOPE.GLOBAL, primary: false, alt: true,
    run: e => {
        const el = nthSynthBlock(digitIndex(e));
        if (el) toggleSynthMute(Number(el.dataset.synthId));
    },
});

registerShortcut({
    id: 'toggle-mirror', key: 'm', scope: SCOPE.GLOBAL, primary: true, alt: false,
    run: () => document.querySelector('#fullscreen-btn').click(),
});

// Escape runs the topmost-only cancellation chain (see core/shortcuts.js).
// `preventDefault: false`: when the chain has nothing to cancel, Escape must
// keep its native meaning (closing a focused select popup, exiting the OS
// fullscreen…).
registerShortcut({
    id: 'escape', key: 'Escape', scope: SCOPE.GLOBAL, preventDefault: false,
    run: () => runEscapeChain(),
});

// A window that loses focus must not keep a tool armed (zone picking, remove
// confirmation, help mode): the user comes back to a clean state.
window.addEventListener('blur', () => cancelTransientTools());

installFocusPolicy();

pixelOverlay.addEventListener('mousedown', (e) => {
    if (cropState.mode) {
        if (!viewer.hasImage) return;
        e.preventDefault(); // prevents image dragging during selection
        const rect = pixelOverlay.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const target = cropDragTargetAt(px, py);
        if (target.kind === 'new') {
            cropState.drag = { kind: 'new', handle: null, startX: px, startY: py, orig: null };
            cropState.rect = { x: px, y: py, w: 0, h: 0 };
        } else {
            // Moving or resizing keeps the frame grabbed at press
            cropState.drag = {
                kind: target.kind,
                handle: target.handle,
                startX: px,
                startY: py,
                orig: { ...cropState.rect },
            };
        }
        drawCropOverlay();
        return;
    }
    if (!zoneState.pick || !viewer.hasImage) return;
    const cell = cellFromClientPoint(e.clientX, e.clientY);
    if (!cell) return;
    e.preventDefault(); // prevents image dragging during selection
    if (zoneState.pick.mode === 'lasso') {
        const pt = imagePointFromClient(e.clientX, e.clientY);
        zoneState.lasso = { id: zoneState.pick.id, points: [pt], start: cell, alt: e.altKey || zoneState.altHeld };
    } else if (zoneState.pick.mode === 'wand') {
        // The wand commits on the click itself — no drag state, so the
        // mousemove/mouseup listeners stay no-ops. The tolerance is read
        // from the armed card's input at click time.
        const card = zoneState.pick.btn.closest('.synth-block');
        const raw = parseInt(card?.querySelector('.magic-wand-tolerance')?.value, 10);
        const tolerance = Math.max(1, Math.min(255, Number.isFinite(raw) ? raw : 32));
        const toggled = (e.altKey || zoneState.altHeld)
            ? wandToggleMutePixels(zoneState.pick.id, cell, tolerance)
            : wandTogglePixels(zoneState.pick.id, cell, tolerance);
        if (toggled) redrawAllHighlights();
        return;
    } else {
        zoneState.drag = { id: zoneState.pick.id, start: cell, cur: cell, alt: e.altKey || zoneState.altHeld };
    }
});

pixelOverlay.addEventListener('mousemove', (e) => {
    if (cropState.mode && !cropState.drag) {
        // Hover feedback: the cursor hints at what a press would grab
        const rect = pixelOverlay.getBoundingClientRect();
        const target = cropDragTargetAt(e.clientX - rect.left, e.clientY - rect.top);
        pixelOverlay.style.cursor = target.kind === 'move' ? 'move'
            : target.kind === 'resize' ? CROP_HANDLE_CURSORS[target.handle]
            : 'crosshair';
    }
    if (cropState.drag) {
        const rect = pixelOverlay.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        cropState.rect = updateCropDrag(cx, cy);
        drawCropOverlay();
        return;
    }
    if (!zoneState.drag && !zoneState.lasso) return;
    if (zoneState.lasso) {
        const pt = imagePointFromClient(e.clientX, e.clientY);
        // Ignore duplicate consecutive points (same mousemove batch)
        const last = zoneState.lasso.points[zoneState.lasso.points.length - 1];
        if (!last || pt.x !== last.x || pt.y !== last.y) {
            zoneState.lasso.points.push(pt);
            redrawAllHighlights();
            drawLassoPreview();
        }
        return;
    }
    const cell = cellFromClientPoint(e.clientX, e.clientY);
    if (!cell) return;
    zoneState.drag.cur = cell;
    redrawAllHighlights();
    drawZonePreview();
});

window.addEventListener('mouseup', (e) => {
    if (cropState.drag) {
        const wasNewFrame = cropState.drag.kind === 'new';
        cropState.drag = null;
        // A degenerate rect (simple click, no real drag) is discarded
        if (wasNewFrame && cropState.rect && cropState.rect.w < 3 && cropState.rect.h < 3) cropState.rect = null;
        cropApplyBtn.disabled = !cropState.rect;
        drawCropOverlay();
        return;
    }
    if (!zoneState.drag && !zoneState.lasso) return;
    if (zoneState.lasso) {
        const { id, points, start, alt } = zoneState.lasso;
        zoneState.lasso = null;
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
    const { id, alt } = zoneState.drag;
    const rect = zoneDragRect();
    zoneState.drag = null;
    if (rect) {
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



new ResizeObserver(() => {
    resizeOverlay();
    clearOverlay();
    if (cropState.mode) {
        // The overlay was resized: overlay pixels changed meaning, re-fit the
        // frame inside the image bounds (ratio re-applied when locked)
        if (cropState.rect) cropState.rect = cropState.ratio ? applyCropRatioToRect(cropState.rect) : clampCropRect(cropState.rect);
        drawCropOverlay();
    }
    else if (isTransformActive()) redrawTransformOverlay();
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
// The loaded image and the current grid dimensions live in
// state/viewer-state.js (imported `viewer`).

// Current column count, derived from the grid slider and the original width

// ---------- Session save / load ----------
const saveSessionBtn = document.querySelector('#save-session-btn');
const loadSessionBtn = document.querySelector('#load-session-btn');

// Session lifecycle state (path/name, dirty flag, title, unsaved modal,
// close confirmation): see session-state.js.
const sessionState = createSessionState({
    getMetronomeInput: () => metronome.getInput(),
    isProjectionOpen: () => mirror.isOpen(),
    closeProjection: () => mirror.destroy(),
    saveSession: () => saveCurrentSession(),
});
sessionState.refreshTitle();
// Modules that mutate saved state without holding the session instance
// (zone edits, synth commands) mark the session dirty through the bus.
appEvents.on('session-dirty', () => sessionState.markDirty());

// Collects the frontend-owned state (metronome tempo, image sliders, synth
// colors in display order); the backend owns the rest (image, synths).
function buildSessionUi() {
    return {
        bpm: clampBpm(metronome.getBpm()),
        grid_slider: Number(gridSlider.value),
        contrast: Number(contrast.value),
        brightness: Number(brightness.value),
        vibrance: Number(vibrance.value),
        posterize_levels: sliderToPosterizeLevels(Number(posterize.value)),
        texture: Number(texture.value),
        clarity: Number(clarity.value),
        simplify: Number(simplify.value),
        auto_levels: autoLevelsBtn.classList.contains('active'),
        mirror_zones_mode: mirror.getZonesMode(),
        synth_colors: Array.from(synthListBody.querySelectorAll('.synth-block')).map(el => ({
            id: Number(el.dataset.synthId),
            color: synthColors.get(Number(el.dataset.synthId)),
        })),
    };
}

// Saves the session: to the current file when there is one (direct
// update), otherwise through a native Save As dialog. Returns false
// when the dialog was canceled or the write failed (the caller then
// keeps the session open).
async function saveCurrentSession() {
    try {
        const path = await invoke('save_session', { ui: buildSessionUi(), path: sessionState.getPath() });
        if (!path) return false; // save dialog canceled
        sessionState.setPath(path);
        sessionState.setDirty(false);
        return true;
    } catch (err) {
        console.error('Error while saving the session:', err);
        alert(translateError(err));
        return false;
    }
}

saveSessionBtn.addEventListener('click', () => saveCurrentSession());

async function openSession() {
    let session;
    try {
        session = await invoke('load_session');
    } catch (err) {
        console.error('Error while loading the session:', err);
        alert(translateError(err));
        return;
    }
    if (!session) return; // dialog canceled

    // The whole UI rebuild below assigns values programmatically: the
    // dirty tracking must not see it as user edits
    sessionState.beginRestore();

    try {
        // Stop everything and clear the current synths
        await invoke('stop_metronome');
        exitCropMode();
        closeTransformPanel();
        metronome.markStopped();
        synthListBody.querySelectorAll('.synth-block').forEach(el => el.remove());
        synthTabs.querySelectorAll('.synth-tab').forEach(el => el.remove());
        clearSynthRegistry();
        placeholder.classList.remove('hidden');
        cancelZonePicking();
        syncPlayAllButton();
        updateImageControlsLockState();

        // Restore the image and its processing settings (the backend already
        // holds the original: refresh re-derives the processed grid)
        viewer.origWidth = session.orig_width;
        viewer.origHeight = session.orig_height;
        viewer.originalPng = session.image_base64;
        viewer.hasImage = true;
        gridSlider.value = session.image_settings.grid_slider;
        contrast.value = session.image_settings.contrast;
        brightness.value = session.image_settings.brightness;
        vibrance.value = session.image_settings.vibrance ?? 0;
        posterize.value = posterizeLevelsToSlider(session.image_settings.posterize_levels);
        texture.value = session.image_settings.texture ?? 0;
        clarity.value = session.image_settings.clarity ?? 0;
        simplify.value = session.image_settings.simplify ?? 0;
        autoLevelsBtn.classList.toggle('active', session.image_settings.auto_levels ?? false);
        mirror.setZonesMode(session.image_settings.mirror_zones_mode);
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
        metronome.setBpm(session.bpm);
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

    } finally {
        // A failed restore must never leave the tracking disabled
        sessionState.endRestore();
    }
    sessionState.setPath(session.path);
    sessionState.setDirty(false);
}

loadSessionBtn.addEventListener('click', () => openSession());

// ---------- Session shortcuts (Cmd/Ctrl+S, Cmd/Ctrl+O) ----------
// Global-scope bindings: the modal scope blocks them while the unsaved
// prompt is open (formerly they fired behind it).
registerShortcut({
    id: 'session-save', key: 's', scope: SCOPE.GLOBAL, primary: true, alt: false,
    run: () => saveCurrentSession(),
});
registerShortcut({
    id: 'session-open', key: 'o', scope: SCOPE.GLOBAL, primary: true, alt: false,
    run: () => openSession(),
});


// ---------- Projection mirror window ----------
// Performance mode: a display-only Tauri window that mirrors the image
// area on a second screen/projector (see mirror-window.js). The main
// window stays fully interactive and pushes its viewer state to the
// mirror through the same single points that repaint the main viewer.
const mirror = createMirror({
    synthColors, synthHighlights, synthCursors, synthCursorGrid, synthCursorMuted,
    getViewerState: () => ({
        gridW: viewer.gridW,
        gridH: viewer.gridH,
        processedPixels: viewer.processedPixels,
        transformPreviewPixels: viewer.transformPreviewPixels,
        originalPng: viewer.originalPng,
        origWidth: viewer.origWidth,
        origHeight: viewer.origHeight,
    }),
    computeMuteCells,
    onReady: updatePreviewSrc,
    onZonesModeChanged: sessionState.markDirty,
});

// The overlay and the cards emit through the bus; forward those to the
// mirror's push points (the overlay no longer depends on the mirror).
appEvents.on('cursors-changed', () => mirror.pushCursors());
appEvents.on('highlights-changed', () => mirror.pushZones());
appEvents.on('viewer-image-changed', () => mirror.pushImage());

// The image editor reaches the mirror routing through this hook (the
// mirror is created above).
configureImageEditor({
    isMirrorOpen: () => mirror.isOpen(),
});

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
const metronome = createMetronome({
    isPlaying: anySynthPlaying,
    updateZonesLabels: updateAllSynthZonesLabels,
    // Cleanup run once the metronome goes idle: restore the highlights
    // hidden during playback and erase the leftover cursors.
    onIdle: () => {
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
    },
});

// The synth cards reach the metronome and the image-controls lock through
// these hooks (they are created above, after the cards' own module).
configureSynthCards({
    ensureMetronomeStarted: metronome.ensureStarted,
    stopMetronomeIfIdle: metronome.stopIfIdle,
    updateImageControlsLockState,
});

// Mouse-wheel / trackpad stepper for hovered numeric inputs (BPM,
// sliders, synth volume), plus the notch classifier it shares with the
// synth volume wheel: see input-stepper.js.
installInputStepper();

// ---------- Clock source (master / slave) ----------
const clockSource = createClockSource();

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

// be armed at a time; the arming auto-expires after the delay below.

addSynthBtn.addEventListener('click', async () => {
    try {
        // A tool armed on an existing synth (zone picking, pending removal)
        // must not survive the creation of a new element — it could then act
        // on the wrong card by accident.
        cancelTransientTools();
        const synth = await invoke('add_synth');
        sessionState.markDirty();
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
    const isPlaying = el => el.querySelector('.synth-play').classList.contains('active');
    const playing = blocks.filter(isPlaying);

    if (playing.length === blocks.length) {
        // Every synth is running: the button is the stop-all affordance (red)
        for (const el of playing) {
            await stopSynthPlayback(Number(el.dataset.synthId), el);
        }
    } else {
        // Idle or partial: start every synth that is not running yet
        // (green starts them all, orange finishes the set)
        for (const el of blocks) {
            if (!isPlaying(el)) await startSynthPlayback(Number(el.dataset.synthId), el);
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
    await metronome.stopIfIdle();
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
    await metronome.stopIfIdle();
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
    const tickW = Number.isFinite(w) ? w : viewer.gridW;
    const tickH = Number.isFinite(h) ? h : viewer.gridH;
    if (tickW !== viewer.gridW || tickH !== viewer.gridH) {
        viewer.gridW = tickW;
        viewer.gridH = tickH;
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
    drawSynthPixel(id, cursor, muted, tickW, tickH);
});


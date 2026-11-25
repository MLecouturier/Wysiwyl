// ==========================================================================
// Image modulation LFOs
// ==========================================================================
// Three low-frequency oscillators living under the image sliders. Each one
// drives the image adjustment sliders it is assigned to: the slider value
// is the *center* of the oscillation, the assignment's amplitude (percent
// of the slider's half-range) and phase offset (percentage; 100 % = anti-phase)
// shape the offset applied on top. The offsets are injected into the render params by
// image/editor.js — the backend never hears about the LFOs.
//
// A single rAF loop animates the graphs and drives a throttled re-render
// (~15 fps) while at least one enabled LFO is assigned to a slider. The
// loop stops when no LFO is enabled.

import { t } from '../core/i18n.js';
import { sliderToPosterizeLevels } from '../core/utils.js';
import { freqToTicks, ticksToFreq } from '../core/timing.js';
import { registerEscape } from '../core/shortcuts.js';
import { appEvents, viewer } from '../core/state.js';
import { currentBpm } from '../audio/metronome.js';
import { isWheelNotch, getTrackpadThreshold, WHEEL_ACCUM_RESET_MS } from '../audio/stepper.js';

const LFO_COUNT = 2;

// Waveform ids (also the values persisted in the session and the keys of
// the controls.lfoWave* labels).
const WAVEFORMS = ['sin', 'triangle', 'saw', 'square', 'sample_hold'];

// Frequency range of the drag control, on a logarithmic scale.
const FREQ_MIN = 0.05;
const FREQ_MAX = 5;
const DEFAULT_FREQ = 0.5;

// Multiplicative frequency step per mouse-wheel notch. The scale is
// logarithmic, so a notch scales the value instead of adding to it.
const FREQ_WHEEL_STEP = 1.1;

// Display unit of a frequency readout: 'hz' (the stored value) or 'tick'
// (one tick = one metronome beat, at the current BPM). Clicking the readout
// toggles it. A display preference only — the stored frequency stays in Hz —
// so it lives in localStorage rather than the session. In tick mode the drag
// and the wheel snap the frequency to a whole number of ticks.
const UNITS = ['hz', 'tick'];
const UNITS_STORAGE_KEY = 'wysiwyl.lfoUnits';

function loadLfoUnits() {
    let stored = null;
    if (typeof localStorage !== 'undefined') {
        try { stored = JSON.parse(localStorage.getItem(UNITS_STORAGE_KEY)); } catch { /* corrupt: keep Hz */ }
    }
    return Array.from({ length: LFO_COUNT }, (_, i) =>
        UNITS.includes(stored?.[i]) ? stored[i] : 'hz');
}

const lfoUnits = loadLfoUnits();

function saveLfoUnits() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(UNITS_STORAGE_KEY, JSON.stringify(lfoUnits)); } catch { /* private mode: keep in memory */ }
}

// Whole-tick bounds of the drag control at a tempo: at least one tick per
// cycle (the fastest reachable frequency, BPM/60) up to the slowest one
// (FREQ_MIN). The high end of the Hz range has no whole tick and is only
// reachable in Hz mode.
function tickRange(bpm) {
    return { min: 1, max: Math.max(1, Math.floor(freqToTicks(FREQ_MIN, bpm))) };
}

// Identification colors of the LFOs (see _variables.scss): cyan, magenta.
const LFO_COLORS = ['#00e0ff', '#ff00e0'];

// Image adjustment sliders the LFOs can be assigned to.
const IMAGE_TARGETS = ['brightness', 'contrast', 'vibrance', 'clarity', 'texture', 'simplify', 'posterize'];
const IMAGE_TARGET_SET = new Set(IMAGE_TARGETS);

// Per-synth hue-shift targets are keyed "synth:<id>"; the id follows the
// stack renumbering (see renameLfoTarget).
const SYNTH_TARGET_PREFIX = 'synth:';
const synthTargetKey = id => `${SYNTH_TARGET_PREFIX}${id}`;

// One render every ~33 ms (30 fps): smooth enough for the fastest LFO (5 Hz,
// ~6 samples per cycle) while keeping the backend load light.
const RENDER_INTERVAL = 1000 / 30;

// Duration represented by the graph width, in seconds. The cursor sits at the
// center; each lateral marker (at 1/8 and 7/8 of the width) marks 1 s of the
// signal from the cursor — one cycle at 1 Hz. The number of cycles drawn is
// therefore proportional to the frequency.
const WINDOW_SECONDS = 8 / 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function clampFreq(v) {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, FREQ_MIN, FREQ_MAX) : DEFAULT_FREQ;
}

// Deterministic pseudo-random in [-1, 1] for the sample & hold waveform: a
// hash of the cycle index, so a held value is stable across frames without
// any per-LFO state.
function hashNoise(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
}

// Evaluates a waveform at a phase expressed in cycles (any real; only the
// fractional part matters). Returns a value in [-1, 1].
function waveValue(wave, cycles) {
    const p = cycles - Math.floor(cycles);
    switch (wave) {
        case 'sin':         return Math.sin(2 * Math.PI * p);
        case 'triangle':    return 4 * Math.abs(p - Math.floor(p + 0.5)) - 1;
        case 'saw':         return 2 * p - 1;
        case 'square':      return p < 0.5 ? 1 : -1;
        case 'sample_hold': return hashNoise(Math.floor(cycles));
        default:            return Math.sin(2 * Math.PI * p);
    }
}

// ---------- State ----------
const lfoState = Array.from({ length: LFO_COUNT }, () => ({
    enabled: false,
    waveform: 'sin',
    freq: DEFAULT_FREQ,
    // Phase (in cycles) of the last frame drawn while enabled. A stopped LFO
    // is redrawn at this phase, so switching it off freezes the curve instead
    // of snapping it back to the start.
    frozenPhase: 0,
}));

// targetId -> { lfo, amount (0..100 %), phase (0..100 %) }
const assignments = new Map();

// Live offsets in slider units, rebuilt every frame.
let offsets = new Map();

// Modulation targets, keyed by an opaque id: an image slider id
// ("brightness") or a per-synth hue shift ("synth:3"). A target with an
// `apply` is backend-owned: the effective value must be pushed to Rust each
// throttle tick. Image targets have none — their offset rides along
// editor.js's buildParams().
const targets = new Map();

// Cross-domain hooks injected by editor.js (the renderer lives there).
let hooks = { requestRefresh: () => {}, isPaused: () => false };
export function configureLfo(injected) {
    hooks = { ...hooks, ...injected };
}

/// Registers a modulation target. `element` is the slider the base value and
/// range are read from; `apply` (backend-owned targets only) receives the
/// effective value to push; `label` (optional) titles the assignment popover;
/// `ghost` (optional) is the second-thumb marker; `display` (optional) renders
/// the live numeric readout; `wrap` makes the modulation circle around the
/// range (the hue shift) instead of clamping to its ends.
export function registerLfoTarget(key, { element, apply = null, label = null, ghost = null, display = null, wrap = false }) {
    targets.set(key, {
        element, apply, label, ghost, display, wrap,
        lastApplied: undefined, lastDisplay: undefined,
    });
}

/// Drops a target, its assignment and its assign button (a removed synth).
export function unregisterLfoTarget(key) {
    if (menuTarget === key) closeMenu();
    targets.delete(key);
    assignments.delete(key);
    const btn = assignButtons.get(key);
    if (btn) {
        btn.remove();
        assignButtons.delete(key);
    }
}

export function unregisterLfoTargetsByPrefix(prefix) {
    for (const key of Array.from(targets.keys())) {
        if (key.startsWith(prefix)) unregisterLfoTarget(key);
    }
}

/// Follows the synth id renumbering: moves a target, its assignment and its
/// assign button under the new key (see cards.js's renumberSynthIds).
export function renameLfoTarget(oldKey, newKey) {
    if (oldKey === newKey) return;
    if (menuTarget === oldKey) menuTarget = newKey;
    const target = targets.get(oldKey);
    if (target) {
        targets.delete(oldKey);
        targets.set(newKey, target);
    }
    const a = assignments.get(oldKey);
    if (a) {
        assignments.delete(oldKey);
        assignments.set(newKey, a);
    }
    const btn = assignButtons.get(oldKey);
    if (btn) {
        assignButtons.delete(oldKey);
        btn.dataset.target = newKey;
        assignButtons.set(newKey, btn);
        syncAssignButton(newKey);
    }
}

/// Key of the synth hue-shift target of a synth id.
export const lfoSynthHueKey = synthTargetKey;

// ---------- DOM ----------
let widgets = [];                 // per LFO: { root, canvas, ctx, powerBtn, waveBtn, glyph, ... }
const assignButtons = new Map();  // targetId -> <button>
let menu = null;                  // shared assignment popover
let menuTarget = null;            // targetId currently edited, or null
let menuAnchor = null;            // assign button the menu is anchored to
let menuCloseTimer = 0;           // idle auto-close timer of the popover
const MENU_IDLE_MS = 10000;       // close the popover after this idle delay

let initialized = false;

// ---------- Loop ----------
let rafId = 0;
let loopStart = 0;   // performance.now() when the loop (re)started
let lastTime = 0;    // last phase time in seconds (for out-of-loop refreshes)
let lastRender = 0;  // performance.now() of the last requested render

function anyEnabled() {
    return lfoState.some(s => s.enabled);
}

function hasActiveModulation() {
    for (const a of assignments.values()) {
        if (lfoState[a.lfo]?.enabled) return true;
    }
    return false;
}

// True when at least one *image* target is driven by an enabled LFO: only
// then does the loop need to re-render the grid (a synth hue-shift target is
// pushed to Rust without touching the image).
function hasActiveImageModulation() {
    for (const [key, a] of assignments) {
        if (!lfoState[a.lfo]?.enabled) continue;
        const target = targets.get(key);
        if (target && !target.apply) return true;
    }
    return false;
}

function nowSeconds() {
    return loopStart ? (performance.now() - loopStart) / 1000 : lastTime;
}

function targetElement(targetId) {
    return document.getElementById(targetId);
}

// Rebuilds the image-target offset map for the given phase time. Backend
// targets are pushed separately (see applyBackendTargets).
function computeOffsets(time) {
    offsets = new Map();
    for (const [key, a] of assignments) {
        const target = targets.get(key);
        if (!target || target.apply) continue; // backend target: not an offset
        const st = lfoState[a.lfo];
        if (!st || !st.enabled) continue;
        const el = target.element;
        const halfSpan = (Number(el.max) - Number(el.min)) / 2;
        // Phase is a percentage: 100 % = half a cycle (anti-phase).
        const phase = time * st.freq + a.phase / 200;
        offsets.set(key, (a.amount / 100) * halfSpan * waveValue(st.waveform, phase));
    }
}

// Quantized effective value of a target at a phase time. Circular targets
// (the hue shift) wrap around their range so the modulation keeps going past
// 0°/360°; the others clamp to their ends. Returns the base (inactive) when
// the target is not driven by an enabled LFO.
function effectiveValue(target, a, time) {
    const el = target.element;
    const min = Number(el.min);
    const max = Number(el.max);
    const span = max - min;
    const step = Number(el.step) || 1;
    const base = Number(el.value);
    const st = a ? lfoState[a.lfo] : null;
    if (!a || !st?.enabled) return { active: false, value: base, min, max };

    const halfSpan = span / 2;
    // Phase is a percentage: 100 % = half a cycle (anti-phase).
    const phase = time * st.freq + a.phase / 200;
    const raw = base + (a.amount / 100) * halfSpan * waveValue(st.waveform, phase);
    const quantized = Math.round(raw / step) * step;
    const value = (target.wrap && span > 0)
        ? min + ((((quantized - min) % span) + span) % span)
        : clamp(quantized, min, max);
    return { active: true, value, min, max };
}

// Pushes the effective value of every backend-owned target (per-synth hue
// shift) to Rust. While a target is modulated the value is pushed on every
// tick (the base can change under it — a slider drag — so a diff would miss
// the new modulated value); once the modulation stops the base is restored.
function applyBackendTargets(time) {
    for (const [key, target] of targets) {
        if (!target.apply || !target.element.isConnected) continue;
        const { active, value } = effectiveValue(target, assignments.get(key), time);
        if (active) {
            target.apply(value);
            target.lastApplied = value;
        } else if (target.lastApplied !== undefined && target.lastApplied !== value) {
            target.apply(value); // restore the base once
            target.lastApplied = value;
        }
    }
}

// Updates the ghost thumb and the live numeric readout of every target: while
// the LFO runs, the ring follows the modulated value and the number oscillates;
// when it stops, both fall back to the base. Runs on the render tick (~15 fps),
// like the image itself, so the UI and the image stay in step.
function updateTargetDisplays(time) {
    for (const [key, target] of targets) {
        const el = target.element;
        if (!el.isConnected) continue;
        const a = assignments.get(key);
        const { active, value: shown, min, max } = effectiveValue(target, a, time);

        if (target.ghost) {
            target.ghost.classList.toggle('hidden', !active);
            if (active) {
                const frac = (shown - min) / (max - min || 1);
                target.ghost.style.setProperty('--lfo-color', LFO_COLORS[a.lfo]);
                // Match the native thumb's travel (inset by half its width at
                // both ends) so the ring sits exactly on the value.
                target.ghost.style.left =
                    `calc(${(frac * 100).toFixed(3)}% + ${((0.5 - frac) * 14).toFixed(2)}px)`;
            }
        }

        // While modulated the readout is rewritten every tick (syncLabels may
        // have reset it to the base in between); once stopped it is restored
        // to the base a single time.
        if (active) {
            target.display?.(shown);
            target.lastDisplay = shown;
        } else if (target.lastDisplay !== shown) {
            target.display?.(shown);
            target.lastDisplay = shown;
        }
    }
}

/// Current modulation offset (in slider units) for a target slider, 0 when
/// the slider is unassigned or its LFO is off. Read by editor.js's
/// buildParams().
export function getLfoOffset(targetId) {
    return offsets.get(targetId) || 0;
}

// ---------- Drawing ----------
function layoutWidget(w) {
    const rect = w.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(rect.width));
    const ch = Math.max(1, Math.round(rect.height));
    if (w.canvas.width !== cw * dpr || w.canvas.height !== ch * dpr) {
        w.canvas.width = cw * dpr;
        w.canvas.height = ch * dpr;
    }
    w.cssW = cw;
    w.cssH = ch;
    w.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawWidget(w, i, cycles) {
    const st = lfoState[i];
    const ctx = w.ctx;
    const W = w.cssW;
    const H = w.cssH;
    if (!W || !H) return;

    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = 1;

    const midY = H / 2;
    const pad = 2;
    const amp = Math.max(1, (H - 2 * pad) / 2);

    // Zero line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(W, midY + 0.5);
    ctx.stroke();

    // Fixed time-scale markers: one second of signal from the cursor, i.e. one
    // cycle at 1 Hz, at 1/8 and 7/8 of the width. Drawn under the curve, in the
    // LFO's color but dimmed — no gray.
    const markerX = W / 8;
    ctx.strokeStyle = LFO_COLORS[i];
    ctx.lineWidth = 1;
    ctx.globalAlpha = st.enabled ? 0.35 : 0.15;
    ctx.beginPath();
    ctx.moveTo(markerX + 0.5, 0);
    ctx.lineTo(markerX + 0.5, H);
    ctx.moveTo(W - markerX + 0.5, 0);
    ctx.lineTo(W - markerX + 0.5, H);
    ctx.stroke();

    // Waveform scrolling under a fixed center cursor: the phase at x is
    // offset so the cursor (x = W/2) always shows the current value. The time
    // scale is fixed (WINDOW_SECONDS across the width), so the number of cycles
    // grows with the frequency. Off, the curve keeps the LFO's color but
    // dimmed — no gray.
    const cyclesSpan = st.freq * WINDOW_SECONDS;
    // Thinner trace as the frequency rises, so a dense curve stays readable.
    const logMin = Math.log(FREQ_MIN);
    const logMax = Math.log(FREQ_MAX);
    const freqT = clamp((Math.log(st.freq) - logMin) / (logMax - logMin), 0, 1);
    ctx.globalAlpha = st.enabled ? 1 : 0.35;
    ctx.lineWidth = 1.5 - 0.5 * freqT;
    ctx.beginPath();
    const steps = Math.max(2, Math.round(W));
    for (let s = 0; s <= steps; s++) {
        const frac = s / steps;
        const u = (frac - 0.5) * cyclesSpan + cycles;
        const x = frac * W;
        const y = midY - waveValue(st.waveform, u) * amp;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fixed cursor at the center, marking the current value
    ctx.globalAlpha = st.enabled ? 0.7 : 0.2;
    ctx.beginPath();
    ctx.moveTo(W / 2 + 0.5, 0);
    ctx.lineTo(W / 2 + 0.5, H);
    ctx.stroke();
    ctx.globalAlpha = 1;
}

function drawAll(time) {
    widgets.forEach((w, i) => {
        const st = lfoState[i];
        // An enabled LFO advances to the current phase and remembers it; a
        // stopped one keeps its frozen phase (see redrawGraphs).
        if (st.enabled) st.frozenPhase = time * st.freq;
        drawWidget(w, i, st.frozenPhase);
    });
}

// Redraws the graphs at the phase they already hold, without advancing time.
// Used while no loop is running (every LFO stopped) so a change that affects
// the drawing — waveform, frequency — shows up right away.
function redrawGraphs() {
    widgets.forEach((w, i) => drawWidget(w, i, lfoState[i].frozenPhase));
}

function drawGlyph(w, i) {
    const st = lfoState[i];
    const ctx = w.glyphCtx;
    const W = w.glyphW;
    const H = w.glyphH;
    ctx.clearRect(0, 0, W, H);
    const midY = H / 2;
    const amp = Math.max(1, (H - 2) / 2);
    ctx.strokeStyle = LFO_COLORS[i];
    ctx.globalAlpha = st.enabled ? 1 : 0.4;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let s = 0; s <= W; s++) {
        const v = waveValue(st.waveform, s / W);
        const x = s;
        const y = midY - v * amp;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
}

// ---------- Loop control ----------
function loop(ts) {
    rafId = 0;
    if (!anyEnabled()) {
        loopStart = 0;
        redrawGraphs(); // freeze the graphs where they stand
        return;
    }
    const time = (ts - loopStart) / 1000;
    lastTime = time;
    computeOffsets(time);
    drawAll(time);

    if (ts - lastRender >= RENDER_INTERVAL && hasActiveModulation()) {
        lastRender = ts;
        applyBackendTargets(time);
        updateTargetDisplays(time);
        if (!hooks.isPaused() && viewer.hasImage && hasActiveImageModulation()) hooks.requestRefresh();
    }
    rafId = requestAnimationFrame(loop);
}

function ensureLoop() {
    if (rafId) return;
    if (!anyEnabled()) {
        redrawGraphs();
        return;
    }
    loopStart = performance.now();
    lastRender = 0;
    rafId = requestAnimationFrame(loop);
}

// Applies a state change that affects the rendered image: recompute the
// offsets at the current phase, push the backend targets and request a single
// render (the running loop would pick it up within a frame anyway; this covers
// the case where the loop is not running, e.g. the last LFO was just switched
// off).
function syncModulation() {
    const time = nowSeconds();
    computeOffsets(time);
    applyBackendTargets(time);
    updateTargetDisplays(time);
    if (viewer.hasImage) hooks.requestRefresh();
}

// ---------- Widgets ----------
function updateFreqLabel(i) {
    const w = widgets[i];
    if (!w) return;
    if (lfoUnits[i] === 'tick') {
        const ticks = freqToTicks(lfoState[i].freq, currentBpm());
        w.freqLabel.textContent = `${ticks.toFixed(2)} ${t('controls.lfoTickUnit')}`;
    } else {
        w.freqLabel.textContent = `${lfoState[i].freq.toFixed(2)} Hz`;
    }
    const tip = t('controls.lfoFreqToggle');
    w.freqLabel.title = tip;
    w.freqLabel.setAttribute('aria-label', tip);
}

function updateWaveTooltip(i) {
    const w = widgets[i];
    if (!w) return;
    w.waveBtn.title = t(`controls.lfoWave_${lfoState[i].waveform}`);
    w.waveBtn.setAttribute('aria-label', w.waveBtn.title);
}

function setFreqFromX(i, clientX) {
    const w = widgets[i];
    const rect = w.canvas.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    if (lfoUnits[i] === 'tick') {
        // Log scale over whole ticks: dragging right raises the displayed
        // number (more ticks = slower), snapping to an integer.
        const bpm = currentBpm();
        const { min, max } = tickRange(bpm);
        const logMin = Math.log(min);
        const logMax = Math.log(max);
        const ticks = Math.round(Math.exp(logMin + (logMax - logMin) * frac));
        lfoState[i].freq = clampFreq(ticksToFreq(ticks, bpm));
    } else {
        const logMin = Math.log(FREQ_MIN);
        const logMax = Math.log(FREQ_MAX);
        lfoState[i].freq = Math.exp(logMin + (logMax - logMin) * frac);
    }
    updateFreqLabel(i);
    redrawGraphs();
    appEvents.emit('session-dirty');
}

// Applies one wheel step to an LFO's frequency (dir > 0 up, < 0 down). In Hz
// mode the value is scaled on the logarithmic scale; in tick mode it moves by
// one whole tick, so the step never stalls on small values.
function stepFreq(i, dir) {
    if (lfoUnits[i] === 'tick') {
        const bpm = currentBpm();
        const { min, max } = tickRange(bpm);
        const current = clamp(Math.round(freqToTicks(lfoState[i].freq, bpm)), min, max);
        const next = clamp(current + (dir > 0 ? 1 : -1), min, max);
        lfoState[i].freq = clampFreq(ticksToFreq(next, bpm));
    } else {
        const factor = dir > 0 ? FREQ_WHEEL_STEP : 1 / FREQ_WHEEL_STEP;
        lfoState[i].freq = clampFreq(lfoState[i].freq * factor);
    }
    updateFreqLabel(i);
    redrawGraphs();
    appEvents.emit('session-dirty');
}

// Wires one LFO widget (markup lives in index.html). The `--lfo-color`
// custom property tints its graph and its power button.
function initWidget(root, i) {
    root.style.setProperty('--lfo-color', LFO_COLORS[i]);

    const canvas = root.querySelector('.lfo-canvas');
    const powerBtn = root.querySelector('.lfo-power');
    const waveBtn = root.querySelector('.lfo-wave');
    const freqLabel = root.querySelector('.lfo-freq');
    const glyph = root.querySelector('.lfo-wave-glyph');

    const dpr = window.devicePixelRatio || 1;
    const glyphW = 24;
    const glyphH = 14;
    glyph.width = glyphW * dpr;
    glyph.height = glyphH * dpr;
    const glyphCtx = glyph.getContext('2d');
    glyphCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = {
        root, canvas, ctx: canvas.getContext('2d'), powerBtn, waveBtn, freqLabel,
        glyph, glyphCtx, glyphW, glyphH, cssW: 0, cssH: 0, dragging: false,
    };

    // The frequency readout is a button: clicking it flips this LFO between Hz
    // and whole ticks. The change is a display preference — it does not touch
    // the session.
    freqLabel.setAttribute('role', 'button');
    freqLabel.setAttribute('tabindex', '0');
    const toggleUnit = () => {
        lfoUnits[i] = lfoUnits[i] === 'hz' ? 'tick' : 'hz';
        saveLfoUnits();
        updateFreqLabel(i);
    };
    freqLabel.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleUnit();
    });
    freqLabel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleUnit();
        }
    });

    powerBtn.addEventListener('click', () => {
        lfoState[i].enabled = !lfoState[i].enabled;
        syncWidgetState(i);
        ensureLoop();
        appEvents.emit('session-dirty');
        syncModulation();
    });

    waveBtn.addEventListener('click', () => {
        const next = (WAVEFORMS.indexOf(lfoState[i].waveform) + 1) % WAVEFORMS.length;
        lfoState[i].waveform = WAVEFORMS[next];
        updateWaveTooltip(i);
        drawGlyph(w, i);
        redrawGraphs();
        appEvents.emit('session-dirty');
        syncModulation();
    });

    canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        w.dragging = true;
        canvas.setPointerCapture(e.pointerId);
        setFreqFromX(i, e.clientX);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (w.dragging) setFreqFromX(i, e.clientX);
    });
    const endDrag = (e) => {
        if (!w.dragging) return;
        w.dragging = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', () => {
        lfoState[i].freq = DEFAULT_FREQ;
        updateFreqLabel(i);
        redrawGraphs();
        appEvents.emit('session-dirty');
        syncModulation();
    });

    // Wheel over the graph steps the frequency, with the same notch/trackpad
    // handling as the sliders (see audio/stepper.js): a mouse-wheel notch is
    // one step, a trackpad gesture accumulates up to the shared threshold.
    let wheelAccum = 0;
    let wheelTime = 0;
    canvas.addEventListener('wheel', (e) => {
        if (e.ctrlKey) return; // pinch zoom / ctrl+wheel: leave the value alone
        e.preventDefault();
        // macOS turns Shift+scroll into horizontal deltas (deltaY = 0).
        const delta = e.deltaY !== 0 ? e.deltaY : (e.shiftKey ? e.deltaX : 0);
        if (delta === 0) return;
        if (e.timeStamp - wheelTime > WHEEL_ACCUM_RESET_MS) wheelAccum = 0;
        wheelTime = e.timeStamp;
        if (isWheelNotch(e, delta)) {
            wheelAccum = 0; // discrete mouse-wheel notch: one step
        } else {
            if (Math.sign(delta) !== Math.sign(wheelAccum)) wheelAccum = 0;
            wheelAccum += delta;
            if (Math.abs(wheelAccum) < getTrackpadThreshold()) return; // keep scrolling
            wheelAccum -= Math.sign(wheelAccum) * getTrackpadThreshold();
        }
        stepFreq(i, delta < 0 ? 1 : -1);
    }, { passive: false });

    return w;
}

function syncWidgetState(i) {
    const w = widgets[i];
    if (!w) return;
    const st = lfoState[i];
    w.root.classList.toggle('enabled', st.enabled);
    w.powerBtn.classList.toggle('active', st.enabled);
    w.powerBtn.setAttribute('aria-pressed', st.enabled ? 'true' : 'false');
    w.powerBtn.title = t('controls.lfoPower');
    w.powerBtn.setAttribute('aria-label', w.powerBtn.title);
    updateWaveTooltip(i);
    updateFreqLabel(i);
    drawGlyph(w, i);
}

// ---------- Assignment buttons ----------
function targetLabel(key) {
    const target = targets.get(key);
    if (target?.label) return target.label();
    const el = target?.element ?? targetElement(key);
    const head = el?.closest('label')?.querySelector('.control-head');
    return head?.querySelector('span')?.textContent?.trim() || key;
}

function syncAssignButton(key) {
    const btn = assignButtons.get(key);
    if (!btn) return;
    const a = assignments.get(key);
    btn.classList.toggle('assigned', !!a);
    if (a) {
        btn.style.setProperty('--lfo-color', LFO_COLORS[a.lfo]);
        btn.title = t('controls.lfoAssigned', { n: a.lfo + 1 });
    } else {
        btn.style.removeProperty('--lfo-color');
        btn.title = t('controls.lfoAssign');
    }
    btn.setAttribute('aria-label', btn.title);
}

// Wires an existing assign button (a synth card's, from the template) to its
// target key. The key is read from the DOM at click time, so the button
// survives the synth id renumbering (see renameLfoTarget).
export function attachLfoAssignButton(btn, key) {
    if (!btn) return;
    if (!btn.querySelector('.lfo-assign-dot')) {
        btn.appendChild(makeAssignDot());
    }
    btn.dataset.target = key;
    if (!btn._lfoWired) {
        btn._lfoWired = true;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const k = btn.dataset.target;
            if (menuTarget === k) closeMenu();
            else openMenu(k, btn);
        });
        // Double-click clears the assignment (no need to open the popover).
        btn.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const k = btn.dataset.target;
            if (assignments.has(k)) {
                assignments.delete(k);
                syncAssignButton(k);
                ensureLoop();
                appEvents.emit('session-dirty');
                syncModulation();
            }
            closeMenu();
        });
    }
    assignButtons.set(key, btn);
    syncAssignButton(key);
}

function makeAssignDot() {
    const dot = document.createElement('span');
    dot.className = 'lfo-assign-dot';
    return dot;
}

// Builds the assign button of an image slider into its .control-head.
function buildLfoAssignButton(key, container) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lfo-assign-btn';
    btn.appendChild(makeAssignDot());
    container?.appendChild(btn);
    attachLfoAssignButton(btn, key);
    return btn;
}

// ---------- Assignment popover ----------
// The popover markup lives in index.html (hidden); this only wires it.
function initMenu() {
    menu = document.getElementById('lfo-menu');
    if (!menu) return;

    // The LFO picker is a row of dots (None / 1 / 2): label each one for
    // accessibility and wire the selection.
    menu.querySelectorAll('.lfo-menu-lfo').forEach(btn => {
        const idx = Number(btn.dataset.lfo);
        const label = idx < 0 ? t('controls.lfoMenuNone') : t('controls.lfoMenuLfoN', { n: idx + 1 });
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.addEventListener('click', () => selectLfo(idx));
    });

    const closeBtn = menu.querySelector('.lfo-menu-close');
    closeBtn.title = t('controls.lfoMenuClose');
    closeBtn.setAttribute('aria-label', closeBtn.title);
    closeBtn.addEventListener('click', () => closeMenu());

    menu.querySelector('.lfo-menu-amount').addEventListener('input', (e) => setAmount(Number(e.target.value)));
    menu.querySelector('.lfo-menu-phase').addEventListener('input', (e) => setPhase(Number(e.target.value)));

    // Any interaction inside the popover pushes its idle auto-close back.
    menu.addEventListener('input', armMenuClose);
    menu.addEventListener('click', armMenuClose);

    // Outside click closes the popover; clicks inside or on an assign
    // button are left to their own handlers.
    document.addEventListener('pointerdown', (e) => {
        if (!menuTarget) return;
        if (menu.contains(e.target)) return;
        if (e.target.closest('.lfo-assign-btn')) return;
        closeMenu();
    });
    window.addEventListener('resize', () => closeMenu());
    // Any scrollable ancestor (image controls, synth list) moving under the
    // popover closes it: the capture phase catches non-bubbling scroll events.
    document.addEventListener('scroll', () => closeMenu(), { capture: true, passive: true });
}

function refreshMenuValues() {
    const a = menuTarget ? assignments.get(menuTarget) : null;
    menu.querySelector('.lfo-menu-title').textContent = menuTarget ? targetLabel(menuTarget) : '';
    const current = a ? a.lfo : -1;
    menu.querySelectorAll('.lfo-menu-lfo').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.lfo) === current);
    });
    const amount = a ? a.amount : 0;
    const phase = a ? a.phase : 0;
    const amountInput = menu.querySelector('.lfo-menu-amount');
    const phaseInput = menu.querySelector('.lfo-menu-phase');
    amountInput.value = amount;
    phaseInput.value = phase;
    amountInput.disabled = !a;
    phaseInput.disabled = !a;
    menu.querySelector('.lfo-menu-amount-val').textContent = `${Math.round(amount)}%`;
    menu.querySelector('.lfo-menu-phase-val').textContent = `${Math.round(phase)}%`;
}

function openMenu(targetId, anchor) {
    closeMenu();
    menuTarget = targetId;
    menuAnchor = anchor;
    refreshMenuValues();
    menu.classList.remove('hidden');

    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let x = r.right - mw;
    x = clamp(x, 8, Math.max(8, window.innerWidth - mw - 8));
    let y = r.bottom + 6;
    if (y + mh > window.innerHeight - 8) y = r.top - mh - 6;
    menu.style.left = `${x}px`;
    menu.style.top = `${Math.max(8, y)}px`;

    anchor.classList.add('active');
    armMenuClose();
}

// (Re)arms the idle auto-close: any interaction inside the popover pushes it
// back, and a period without one closes it (same pattern as the dither panel).
function armMenuClose() {
    clearTimeout(menuCloseTimer);
    menuCloseTimer = setTimeout(closeMenu, MENU_IDLE_MS);
}

function closeMenu() {
    clearTimeout(menuCloseTimer);
    menuCloseTimer = 0;
    if (!menuTarget) return;
    menuTarget = null;
    menu?.classList.add('hidden');
    menuAnchor?.classList.remove('active');
    menuAnchor = null;
}

function ensureAssignment() {
    if (!menuTarget) return null;
    let a = assignments.get(menuTarget);
    if (!a) {
        a = { lfo: 0, amount: 0, phase: 0 };
        assignments.set(menuTarget, a);
    }
    return a;
}

function selectLfo(idx) {
    if (!menuTarget) return;
    if (idx < 0) {
        assignments.delete(menuTarget);
    } else {
        const a = ensureAssignment();
        a.lfo = idx;
    }
    refreshMenuValues();
    syncAssignButton(menuTarget);
    ensureLoop();
    appEvents.emit('session-dirty');
    syncModulation();
}

function setAmount(value) {
    const a = ensureAssignment();
    if (!a) return;
    a.amount = clamp(value, 0, 100);
    menu.querySelector('.lfo-menu-amount-val').textContent = `${Math.round(a.amount)}%`;
    syncAssignButton(menuTarget);
    appEvents.emit('session-dirty');
}

function setPhase(value) {
    const a = ensureAssignment();
    if (!a) return;
    a.phase = clamp(value, 0, 100);
    menu.querySelector('.lfo-menu-phase-val').textContent = `${Math.round(a.phase)}%`;
    appEvents.emit('session-dirty');
}

// ---------- Session ----------
/// Frontend-owned LFO state for the session save payload.
export function getLfoSession() {
    return {
        lfos: lfoState.map(s => ({ enabled: s.enabled, waveform: s.waveform, freq: s.freq })),
        lfo_assignments: Array.from(assignments, ([target, a]) => ({
            target, lfo: a.lfo, amount: a.amount, phase: a.phase,
        })),
    };
}

/// Restores the LFO state from a loaded session (missing/partial data keeps
/// the defaults, so an older session restores cleanly).
export function applyLfoSession(data) {
    const lfos = Array.isArray(data?.lfos) ? data.lfos : [];
    for (let i = 0; i < LFO_COUNT; i++) {
        const s = lfos[i];
        lfoState[i] = {
            enabled: !!s?.enabled,
            waveform: WAVEFORMS.includes(s?.waveform) ? s.waveform : 'sin',
            freq: clampFreq(s?.freq),
            frozenPhase: 0,
        };
    }

    assignments.clear();
    const list = Array.isArray(data?.lfo_assignments) ? data.lfo_assignments : [];
    for (const a of list) {
        if (!isValidTargetKey(a?.target)) continue;
        const lfo = Number(a.lfo);
        if (!(lfo >= 0 && lfo < LFO_COUNT)) continue;
        assignments.set(a.target, {
            lfo,
            amount: clamp(Number(a.amount) || 0, 0, 100),
            phase: clamp(Number(a.phase) || 0, 0, 100),
        });
    }

    syncAll();
}

// A persisted target key: an image slider id, or a per-synth hue shift. The
// synth may not exist yet (a session restore registers its targets after the
// LFO state is restored), so only the shape is checked here.
function isValidTargetKey(key) {
    if (IMAGE_TARGET_SET.has(key)) return true;
    return new RegExp(`^${SYNTH_TARGET_PREFIX}\\d+$`).test(key);
}

/// Resets every LFO to its default (used by the image Reset button).
export function resetLfos() {
    for (let i = 0; i < LFO_COUNT; i++) {
        lfoState[i] = { enabled: false, waveform: 'sin', freq: DEFAULT_FREQ, frozenPhase: 0 };
    }
    assignments.clear();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    loopStart = 0;
    lastTime = 0;
    syncAll();
}

function syncAll() {
    widgets.forEach((_, i) => syncWidgetState(i));
    for (const targetId of assignButtons.keys()) syncAssignButton(targetId);
    // Refresh the offsets and push the backend targets for the current phase;
    // the caller renders (a session restore refreshes right after, the Reset
    // button too).
    const time = nowSeconds();
    computeOffsets(time);
    applyBackendTargets(time);
    updateTargetDisplays(time);
    ensureLoop();
}

/// Re-applies the translated tooltips after a locale change.
export function retranslateLfos() {
    widgets.forEach((_, i) => syncWidgetState(i));
    for (const targetId of assignButtons.keys()) syncAssignButton(targetId);
    if (menuTarget) refreshMenuValues();
}

/// Re-reads every frequency readout. In tick mode the value follows the
/// metronome BPM, so the caller refreshes them when the tempo changes.
export function refreshLfoFreqLabels() {
    widgets.forEach((_, i) => updateFreqLabel(i));
}

// ---------- Init ----------
// Default numeric readout of an image target: the `.control-value` next to the
// slider's label. Posterize shows its level count (or "off"), like syncLabels.
function imageTargetDisplay(key) {
    const label = document.getElementById(`${key}-value`);
    if (!label) return null;
    if (key === 'posterize') {
        return (v) => {
            const levels = sliderToPosterizeLevels(v);
            label.textContent = levels
                ? t('controls.posterizeLevels', { count: levels })
                : t('controls.posterizeOff');
        };
    }
    return (v) => { label.textContent = Math.round(v); };
}

export function initLfos() {
    if (initialized) return;
    initialized = true;

    const set = document.querySelector('.lfos-set');
    if (set) {
        widgets = Array.from(set.querySelectorAll('.lfo'))
            .slice(0, LFO_COUNT)
            .map((root, i) => initWidget(root, i));
    }

    initMenu();
    // Register the image-slider targets and drop their assign buttons into
    // each .control-head. Synth hue-shift targets are registered by the synth
    // cards as they are created.
    for (const key of IMAGE_TARGETS) {
        const slider = document.getElementById(key);
        if (!slider) continue;
        registerLfoTarget(key, {
            element: slider,
            ghost: slider.closest('.slider-track')?.querySelector('.lfo-ghost') || null,
            display: imageTargetDisplay(key),
        });
        buildLfoAssignButton(key, slider.closest('label')?.querySelector('.control-head'));
    }

    const layoutAll = () => {
        widgets.forEach(layoutWidget);
        redrawGraphs();
    };
    layoutAll();
    window.addEventListener('resize', layoutAll);
    if (set && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(layoutAll).observe(set);
    }

    registerEscape(50, () => menuTarget !== null, closeMenu);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        } else {
            ensureLoop();
        }
    });

    widgets.forEach((_, i) => syncWidgetState(i));
    ensureLoop();
}

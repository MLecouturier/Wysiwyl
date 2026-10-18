// Masking effects of the projection mirror. The mirror permanently
// stacks two surfaces — the original image and the processed grid — and
// the active effect paints a mask over the top layer to reveal the
// other version underneath.
//
// This module is the single registry shared by both windows: the main
// window builds its effect dropdown and options panel from the
// definitions (ids, labels, option specs), the mirror window calls the
// painter of the active effect on its mask canvas. Adding an effect is
// one entry here; everything else adapts.
//
// Mask semantics: the painter receives a transparent viewport-sized
// canvas and must paint opaque (alpha 1) where the top layer stays
// visible, leaving holes (alpha 0 or a soft gradient) where the bottom
// layer shows through. The painter must fill the whole canvas — with
// 'destination-in' compositing, an unpainted area would erase the top
// layer entirely.
//
// An effect may also declare a `paintOverlay` painter: it draws a
// colored layer on a separate canvas stacked over the two surfaces,
// blended in 'screen' mode (see mirror.scss) — the alpha-only mask
// cannot carry color.
//
// The pure helpers (registry lookups, option sanitizing, the visited-
// cell trail buffers, the reveal ramp) are exercised by the node test
// runner; the painters need a canvas 2D context and only ever run in the
// mirror window.

import { computeLayout } from '../core/geometry.js';

// Identifier of the no-op effect: the top layer covers the bottom one
// (no mask), the mirror looks exactly like the single-surface era.
export const NO_EFFECT = 'none';

// Longest trail a synth can keep, in grid cells: the option's maximum.
// The buffer is capped here whatever the current option value, so the
// painters only ever slice the tail they need.
export const TRAIL_MAX_CELLS = 100;

// Opacity of the colored trail tint, as a fraction of the reveal ramp:
// the overlay is blended in 'screen' mode, so full alpha would wash the
// projection out.
const TRAIL_TINT_ALPHA = 0.75;

// Options are stored as plain numbers and serialized as such in the
// session file. The boolean "colored" toggle travels as 0/1 so it fits
// the numeric option pipeline (sanitize, IPC, the session's f64 map).
const TRAIL_OPTIONS = [
    { id: 'length',  labelKey: 'mirrorEffect.trailLength',  helpKey: 'controls.mirrorEffectTrailLength',  min: 1, max: TRAIL_MAX_CELLS, def: 12 },
    { id: 'colored', labelKey: 'mirrorEffect.trailColored', helpKey: 'controls.mirrorEffectTrailColored', min: 0, max: 1,   def: 0, type: 'bool' },
    { id: 'fade',    labelKey: 'mirrorEffect.trailFade',    helpKey: 'controls.mirrorEffectTrailFade',    min: 0, max: 100, def: 6 },
];

// The registry itself. `animated` marks effects whose mask evolves on
// its own (the mirror then runs its requestAnimationFrame loop); a
// non-animated mask is only repainted when its inputs change.
// `synthFilter` marks effects that target the synths' playhead cursors
// one by one: their options panel grows a toggle row selecting which
// synths the effect applies to (see synthEffectExcluded in state.js),
// and their painter receives the excluded ids to filter the cursors.
export const EFFECTS = [
    {
        id: NO_EFFECT,
        labelKey: 'mirrorEffect.none',
        animated: false,
        options: [],
    },
    {
        id: 'drag',
        labelKey: 'mirrorEffect.drag',
        animated: false,
        synthFilter: true,
        options: TRAIL_OPTIONS,
        paintMask: paintTrailMask,
        paintOverlay: paintTrailOverlay,
    },
];

export function getEffect(id) {
    return EFFECTS.find(e => e.id === id) ?? null;
}

// Registry lookup with a safe fallback: an unknown id (a session saved
// by a newer version, a hand-edited file) loads as the no-op effect.
export function effectOrDefault(id) {
    return getEffect(id) ?? EFFECTS[0];
}

// The default option values of an effect, keyed by option id.
export function defaultOptions(effect) {
    const out = {};
    for (const def of effect.options) out[def.id] = def.def;
    return out;
}

function clampOption(def, value) {
    const n = Number(value);
    const v = Number.isFinite(n) ? n : def.def;
    return Math.min(def.max, Math.max(def.min, v));
}

// Clamps the given values onto the effect's option definitions and
// drops everything unknown: the painters and the session file only
// ever see well-formed numbers.
export function sanitizeOptions(effect, options) {
    const out = {};
    if (!options) return out;
    for (const def of effect.options) {
        if (Object.hasOwn(options, def.id)) out[def.id] = clampOption(def, options[def.id]);
    }
    return out;
}

// Visited cells per synth, oldest first: the only state the trail needs.
// The mirror window feeds it from the cursor ticks (updateTrail) and the
// painters read it back; a non-animated effect is repainted on every
// tick, so nothing else has to be remembered. Each entry carries the
// grid dimensions the cell was recorded on, so a column-count change
// mid-playback never misplaces a past cell.
const trailBuffers = new Map(); // synthId -> [{ cell, w, h, color }]

// Merges one cursor tick into the trail buffers: appends the new cell of
// every playing synth (a repeat of the last cell is ignored), trims each
// buffer to its cap, and drops the synths absent from the payload — a
// synth that stopped playing loses its trail at once, which also makes a
// stack renumbering unable to misattribute a frozen trail.
export function updateTrail(cursors) {
    const seen = new Set();
    for (const c of cursors ?? []) {
        seen.add(c.id);
        const buf = trailBuffers.get(c.id) ?? [];
        const last = buf[buf.length - 1];
        if (!last || last.cell !== c.cursor) {
            buf.push({ cell: c.cursor, w: c.w ?? 0, h: c.h ?? 0, color: c.color });
            if (buf.length > TRAIL_MAX_CELLS) buf.splice(0, buf.length - TRAIL_MAX_CELLS);
        }
        trailBuffers.set(c.id, buf);
    }
    for (const id of [...trailBuffers.keys()]) {
        if (!seen.has(id)) trailBuffers.delete(id);
    }
}

// Drops every buffered trail: the grid changed (a new image makes the
// recorded cells meaningless) or the active effect changed.
export function clearTrails() {
    trailBuffers.clear();
}

// The buffered cells of one synth, oldest first (the painters and the
// tests read it; the buffer itself stays private).
export function getTrail(id) {
    return trailBuffers.get(id) ?? [];
}

// Reveal strength of a trail cell: 1 (full reveal of the bottom layer)
// behind the cursor, fading linearly to 0 across the `fade` oldest
// cells. Index 0 is the oldest cell, length - 1 the cursor cell. A zero
// fade keeps a hard edge; a fade longer than the trail spreads over the
// whole trail, the cursor cell always staying at full strength.
export function trailReveal(index, length, fade) {
    if (length <= 1 || fade <= 0) return 1;
    const ramp = Math.min(fade, length - 1);
    return Math.min(1, index / ramp);
}

// Decodes one visited cell into its viewport rectangle, using the grid
// dimensions recorded with the visit (falling back to the viewer's
// current grid).
function cellRect(viewW, viewH, gridW, gridH, visit) {
    const layout = computeLayout(viewW, viewH, visit.w || gridW, visit.h || gridH);
    if (!layout) return null;
    const col = visit.cell % layout.gridW;
    const row = Math.floor(visit.cell / layout.gridW);
    return {
        x: layout.offsetX + col * layout.cellW,
        y: layout.offsetY + row * layout.cellH,
        w: layout.cellW,
        h: layout.cellH,
    };
}

// The trail of one synth, trimmed to the current option length.
function trailTail(buf, options) {
    const length = Math.max(1, Math.round(options.length));
    return buf.slice(-length);
}

// 'drag': the mask stays opaque except for the cells the playing synths
// just visited — a trail of holes fading out at its oldest end, so the
// bottom layer shows through behind every cursor. The synths unchecked
// in the options panel are excluded. Overlapping cells (a synth crossing
// its own path, two synths sharing cells) accumulate their alpha, which
// only deepens the reveal.
function paintTrailMask(ctx, { viewW, viewH, gridW, gridH, options, excluded }) {
    // Base of the mask: keep the top layer everywhere.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, viewW, viewH);

    const skip = excluded instanceof Set ? excluded : new Set(excluded);
    const fade = Math.max(0, Math.round(options.fade));

    ctx.globalCompositeOperation = 'destination-out';
    for (const [id, buf] of trailBuffers) {
        if (skip.has(id)) continue;
        const trail = trailTail(buf, options);
        for (let i = 0; i < trail.length; i++) {
            const alpha = trailReveal(i, trail.length, fade);
            if (alpha <= 0) continue;
            const rect = cellRect(viewW, viewH, gridW, gridH, trail[i]);
            if (!rect) continue;
            ctx.globalAlpha = alpha;
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
}

// Colored variant of the drag effect: repaints the same trail as a band
// of the synth colors on the mirror's overlay canvas, blended against
// the layer stack in 'screen' mode — the reveal turns brighter and
// tinted. The mask holes stay in place, so the bottom layer keeps
// showing through. Does nothing while the option is off (the mirror
// clears the overlay beforehand either way).
function paintTrailOverlay(ctx, { viewW, viewH, gridW, gridH, options, excluded }) {
    if (!options.colored) return;

    const skip = excluded instanceof Set ? excluded : new Set(excluded);
    const fade = Math.max(0, Math.round(options.fade));

    for (const [id, buf] of trailBuffers) {
        if (skip.has(id)) continue;
        const trail = trailTail(buf, options);
        for (let i = 0; i < trail.length; i++) {
            const alpha = trailReveal(i, trail.length, fade);
            if (alpha <= 0) continue;
            const rect = cellRect(viewW, viewH, gridW, gridH, trail[i]);
            if (!rect) continue;
            ctx.globalAlpha = alpha * TRAIL_TINT_ALPHA;
            ctx.fillStyle = trail[i].color || '#808080';
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        }
    }
    ctx.globalAlpha = 1;
}

// Unit tests for the projection mirror's effect registry
// (src/js/mirror/effects.js). The registry integrity and the pure
// helpers (option sanitizing, the visited-cell trail buffers, the
// movement axis, the reveal ramps) run here; the mask painters need a
// canvas and only ever run in the mirror window.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    EFFECTS, NO_EFFECT, TRAIL_MAX_CELLS,
    getEffect, effectOrDefault, defaultOptions, sanitizeOptions,
    updateTrail, clearTrails, getTrail, trailReveal, lineReveal,
} from '../src/js/mirror/effects.js';

test('the registry holds unique ids and the no-op effect first', () => {
    const ids = EFFECTS.map(e => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[0], NO_EFFECT);
    assert.equal(getEffect(NO_EFFECT).id, NO_EFFECT);
    assert.equal(getEffect('not-an-effect'), null);
});

test('every effect and option definition is complete', () => {
    for (const effect of EFFECTS) {
        assert.equal(typeof effect.labelKey, 'string');
        assert.equal(typeof effect.animated, 'boolean');
        for (const def of effect.options) {
            assert.equal(typeof def.labelKey, 'string');
            assert.equal(typeof def.helpKey, 'string');
            assert.ok(def.min < def.max, `option ${def.id}: min must be below max`);
            assert.ok(def.def >= def.min && def.def <= def.max,
                `option ${def.id}: default out of range`);
            // Boolean options ride the numeric pipeline as 0/1
            if (def.type === 'bool') {
                assert.equal(def.min, 0, `option ${def.id}: boolean min must be 0`);
                assert.equal(def.max, 1, `option ${def.id}: boolean max must be 1`);
            }
        }
        // An effect that animates must be able to paint its mask
        if (effect.animated) assert.equal(typeof effect.paintMask, 'function');
        // A synth-filtering effect targets cursors one by one: its
        // painter receives the excluded ids to filter them
        if (effect.synthFilter) assert.equal(typeof effect.paintMask, 'function');
    }
});

test('effectOrDefault falls back to the no-op effect on unknown ids', () => {
    assert.equal(effectOrDefault('drag').id, 'drag');
    assert.equal(effectOrDefault('frontline').id, 'frontline');
    assert.equal(effectOrDefault('holograms').id, NO_EFFECT);
    assert.equal(effectOrDefault(null).id, NO_EFFECT);
    assert.equal(effectOrDefault(undefined).id, NO_EFFECT);
});

test('defaultOptions returns each option default keyed by id', () => {
    for (const id of ['drag', 'frontline']) {
        const effect = getEffect(id);
        assert.deepEqual(defaultOptions(effect), {
            length: effect.options.find(o => o.id === 'length').def,
            fade: effect.options.find(o => o.id === 'fade').def,
            colored: effect.options.find(o => o.id === 'colored').def,
        });
    }
    assert.deepEqual(defaultOptions(getEffect(NO_EFFECT)), {});
});

test('sanitizeOptions clamps values, coerces strings and drops unknown keys', () => {
    const drag = getEffect('drag');
    const length = drag.options.find(o => o.id === 'length');
    const colored = drag.options.find(o => o.id === 'colored');

    assert.deepEqual(
        sanitizeOptions(drag, { length: length.max + 100, colored: 5, fade: '17' }),
        { length: length.max, colored: 1, fade: 17 },
    );
    // Unknown keys never reach the painter
    assert.deepEqual(
        sanitizeOptions(drag, { length: 12, lasers: 50 }),
        { length: 12 },
    );
    // Non-numeric values fall back to the option default
    assert.deepEqual(
        sanitizeOptions(drag, { length: NaN, colored: 'yes' }),
        { length: length.def, colored: colored.def },
    );
    assert.deepEqual(sanitizeOptions(drag, null), {});

    // The frontline length accepts 0 (whole line)
    const frontline = getEffect('frontline');
    assert.deepEqual(sanitizeOptions(frontline, { length: 0 }), { length: 0 });
    assert.equal(frontline.options.find(o => o.id === 'length').min, 0);
});

test('the cursor effects filter the playheads by synth', () => {
    assert.equal(getEffect('drag').synthFilter, true);
    assert.equal(getEffect('frontline').synthFilter, true);
    assert.equal(getEffect('none').synthFilter, undefined);
});

test('updateTrail records visited cells, ignoring repeats and purging absents', () => {
    clearTrails();
    updateTrail([
        { id: 1, cursor: 0, color: '#f00', w: 10, h: 10 },
        { id: 2, cursor: 5, color: '#0f0', w: 10, h: 10 },
    ]);
    // A repeat of the last cell is not a new visit
    updateTrail([{ id: 1, cursor: 0, color: '#f00', w: 10, h: 10 }]);
    assert.deepEqual(getTrail(1).map(v => v.cell), [0]);
    // Synth 2 is absent from the tick: it stopped, its trail is gone
    assert.deepEqual(getTrail(2), []);

    // Revisiting a cell after another one is a genuine new visit
    clearTrails();
    updateTrail([{ id: 1, cursor: 1, color: '#f00', w: 4, h: 4 }]);
    updateTrail([{ id: 1, cursor: 2, color: '#f00', w: 4, h: 4 }]);
    updateTrail([{ id: 1, cursor: 1, color: '#f00', w: 4, h: 4 }]);
    assert.deepEqual(getTrail(1).map(v => v.cell), [1, 2, 1]);
    // Each visit carries the grid dims and color it was recorded with
    assert.deepEqual(getTrail(1)[0], { cell: 1, w: 4, h: 4, color: '#f00', axis: null });

    // Cursors without explicit dims fall back to zero (the viewer grid)
    clearTrails();
    updateTrail([{ id: 7, cursor: 3, color: '#00f' }]);
    assert.deepEqual(getTrail(7)[0], { cell: 3, w: 0, h: 0, color: '#00f', axis: null });

    // Empty input drops every buffered trail
    clearTrails();
    assert.deepEqual(getTrail(1), []);
});

test('updateTrail caps every buffer at the option maximum, oldest first', () => {
    clearTrails();
    for (let i = 0; i < TRAIL_MAX_CELLS + 20; i++) {
        updateTrail([{ id: 1, cursor: i, color: '#f00', w: 10, h: 10 }]);
    }
    const buf = getTrail(1);
    assert.equal(buf.length, TRAIL_MAX_CELLS);
    assert.equal(buf[0].cell, 20);
    assert.equal(buf[buf.length - 1].cell, TRAIL_MAX_CELLS + 19);
    clearTrails();
});

test('updateTrail tags each visit with the movement axis', () => {
    // 10-wide grid: +1 is a horizontal move, +10 a vertical one
    const at = (cursor) => [{ id: 1, cursor, color: '#f00', w: 10, h: 10 }];

    clearTrails();
    updateTrail(at(5));   // first visit: no axis yet
    updateTrail(at(6));   // 5 → 6: horizontal
    updateTrail(at(16));  // 6 → 16: next row, vertical
    updateTrail(at(17));  // 16 → 17: horizontal
    assert.deepEqual(getTrail(1).map(v => v.axis), [null, 'h', 'v', 'h']);

    // A diagonal jump (row or zone transition) keeps the previous axis
    clearTrails();
    updateTrail(at(0));
    updateTrail(at(1));   // 0 → 1: horizontal
    updateTrail(at(10));  // 1 → 10: diagonal jump, keeps 'h'
    assert.deepEqual(getTrail(1).map(v => v.axis), [null, 'h', 'h']);

    // A jump of more than one cell along a row is still horizontal
    clearTrails();
    updateTrail(at(0));
    updateTrail(at(4));   // 0 → 4: same row, horizontal
    assert.equal(getTrail(1)[1].axis, 'h');

    clearTrails();
});

test('trailReveal fades the oldest cells and keeps the cursor cell full', () => {
    // No fade: every cell is fully revealed (hard edge)
    assert.equal(trailReveal(0, 20, 0), 1);
    assert.equal(trailReveal(19, 20, 0), 1);
    // A single-cell trail is always full
    assert.equal(trailReveal(0, 1, 6), 1);
    // Fade spread over the 6 oldest cells: 0 at the tail, 1 from the
    // 7th cell on (index 0 = oldest, 19 = the cursor cell)
    assert.equal(trailReveal(0, 20, 6), 0);
    assert.equal(trailReveal(3, 20, 6), 0.5);
    assert.equal(trailReveal(6, 20, 6), 1);
    assert.equal(trailReveal(19, 20, 6), 1);
    // A fade longer than the trail spreads over the whole trail, the
    // cursor cell still reaching full strength
    assert.equal(trailReveal(0, 20, 100), 0);
    assert.equal(trailReveal(19, 20, 100), 1);
    const mid = trailReveal(9, 20, 100);
    assert.ok(mid > 0.45 && mid < 0.5, `mid ramp ${mid} out of range`);
});

test('lineReveal fades toward both ends and keeps the cursor cell full', () => {
    // No fade: the whole line is fully revealed (hard edge)
    assert.equal(lineReveal(0, 20, 0), 1);
    assert.equal(lineReveal(20, 20, 0), 1);
    // A cursor at the end of its line has no extent to fade over
    assert.equal(lineReveal(0, 0, 6), 1);
    // Fade spread over the last 6 cells before the end
    assert.equal(lineReveal(20, 20, 6), 0);
    assert.equal(lineReveal(17, 20, 6), 0.5);
    assert.equal(lineReveal(14, 20, 6), 1);
    assert.equal(lineReveal(0, 20, 6), 1);
    // A fade longer than the half-line spreads over the whole half-line,
    // the cursor cell still reaching full strength
    assert.equal(lineReveal(20, 20, 100), 0);
    assert.equal(lineReveal(0, 20, 100), 1);
    const mid = lineReveal(10, 20, 100);
    assert.ok(mid > 0.45 && mid < 0.55, `mid ramp ${mid} out of range`);
});

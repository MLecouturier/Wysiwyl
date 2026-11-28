// Cursor lead: draws a synth's playhead slightly ahead of the sound. The
// backend announces the next pixel through `synth-pixel-upcoming` with its
// absolute due instant (`due_at_ms`); this module converts it to local time
// through the calibrated clock (see clock-sync.js) and schedules the draw at
// `due - lead` on a lightweight requestAnimationFrame scheduler. The
// authoritative `synth-pixel-tick` still corrects the display (the caller
// passes an idempotent `draw`), and the lead is disabled at 0.
//
// Shared by the main window and the projection mirror: each instance owns its
// own clock calibration (the two webviews have distinct `performance.now()`
// origins) and draws through its injected callback.

import { createClockSync } from '../core/clock-sync.js';

// The cursor may lead by at most this fraction of a step: it must stay on the
// announced pixel, never reach into the next one.
const MAX_LEAD_FRACTION = 0.9;

// `draw(id, cursor, w, h)` is called to paint the announced pixel; it must be
// idempotent (no-op when the display already shows that pixel).
export function createCursorLead({ draw }) {
    const { listen } = window.__TAURI__.event;
    const clock = createClockSync();

    let leadMs = 0; // 0 = disabled (current behavior: the tick draws)
    let raf = 0;
    const pending = new Map(); // synthId -> { cursor, w, h, drawAt }
    const lastSeq = new Map(); // synthId -> last announced seq

    // Lightweight scheduler: a single rAF loop drains the draws whose instant
    // has passed. rAF alone (no bare setTimeout) keeps the draw on the frame
    // timeline and is cheap while nothing is pending.
    function tick(now) {
        raf = 0;
        for (const [id, p] of pending) {
            if (now >= p.drawAt) {
                pending.delete(id);
                draw(id, p.cursor, p.w, p.h);
            }
        }
        if (pending.size > 0) schedule();
    }

    function schedule() {
        if (!raf) raf = requestAnimationFrame(tick);
    }

    function onUpcoming(payload) {
        const { id, cursor, w, h, due_at_ms, step_ms, seq } = payload;

        // Loss / reordering guard: a stale or repeated announcement for this
        // synth is dropped.
        const seen = lastSeq.get(id);
        if (seen !== undefined && seq <= seen) return;
        lastSeq.set(id, seq);

        if (leadMs <= 0) return; // disabled: the tick draws as before

        const dueLocal = clock.rustToLocal(due_at_ms);
        if (dueLocal === null) return; // not calibrated yet: fall back

        // Bound the lead so the cursor never anticipates more than one step
        const lead = Math.min(leadMs, MAX_LEAD_FRACTION * step_ms);
        const drawAt = dueLocal - lead;
        // Arrived too late (or no positive lead left): fall back to the tick
        if (drawAt <= performance.now()) return;

        pending.set(id, { cursor, w, h, drawAt });
        schedule();
    }

    function cancel(id) {
        pending.delete(id);
    }

    function cancelAll() {
        pending.clear();
        if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
        }
    }

    function setLeadMs(ms) {
        leadMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
        if (leadMs <= 0) cancelAll();
    }

    listen('synth-pixel-upcoming', (event) => onUpcoming(event.payload));

    return {
        setLeadMs,
        getLeadMs: () => leadMs,
        cancel,
        cancelAll,
        clock,
    };
}

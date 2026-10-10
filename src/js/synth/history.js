// Undo/redo history for zone and silence edits.
//
// The zone model is immutable-by-replacement: rebuildZones/rectZone/mergeZones
// return fresh arrays and selection.js always reassigns hi.zones / hi.muteZones
// (never mutates them in place). A snapshot therefore only needs to keep the
// current array references per synth — cheap, and race-free with the backend.
//
// This module owns the stack; selection.js feeds it through scheduleCapture()
// from its zone-sending choke points (sendSynthZones / sendSynthMuteZones), and
// injects the re-push/redraw helpers via configure() so there is no import
// cycle back into selection.js.

import { zonesEqual } from '../core/geometry.js';
import { synthHighlights } from '../core/state.js';

// Undo depth (number of steps kept).
export const HISTORY_LIMIT = 25;

// Pure, DOM-free stack of opaque states — kept separate so it can be unit
// tested without the synth registry. `states[index]` is the current state;
// undo/redo move the index; capture truncates the redo branch.
export function createHistoryStack(limit = HISTORY_LIMIT) {
    const max = Math.max(1, limit);
    let states = [];
    let index = -1;
    const trim = () => {
        const excess = states.length - max;
        if (excess > 0) {
            states = states.slice(excess);
            index -= excess;
        }
    };
    return {
        reset(state) {
            states = [state];
            index = 0;
        },
        // Records `state` as a new step. `equal` (optional) skips a step
        // identical to the current one (no-op edits don't pollute history).
        capture(state, equal) {
            if (index < 0) { this.reset(state); return; }
            if (equal && equal(states[index], state)) return;
            states = states.slice(0, index + 1);
            states.push(state);
            index = states.length - 1;
            trim();
        },
        undo() {
            if (index <= 0) return null;
            index -= 1;
            return states[index];
        },
        redo() {
            if (index >= states.length - 1) return null;
            index += 1;
            return states[index];
        },
        current() { return index >= 0 ? states[index] : null; },
        canUndo() { return index > 0; },
        canRedo() { return index >= 0 && index < states.length - 1; },
        depth() { return states.length; },
    };
}

// Re-push / redraw helpers injected by selection.js (avoids an import cycle).
let senders = null;
export function configure(next) {
    senders = next;
}

let restoring = false;       // true while applying an undo/redo (no capture)
let captureScheduled = false;
let captureEpoch = 0;        // bumped by resetHistory to drop pending captures

const stack = createHistoryStack(HISTORY_LIMIT);

// Snapshot of every synth's zone arrays (references; see module note).
function snapshot() {
    const state = new Map();
    synthHighlights.forEach((hi, id) => {
        state.set(id, { zones: hi.zones, muteZones: hi.muteZones });
    });
    return state;
}

// Are two snapshots identical (same ids and same zone geometry)?
function statesEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const [id, sa] of a) {
        const sb = b.get(id);
        if (!sb) return false;
        if (!zonesEqual(sa.zones, sb.zones)) return false;
        if (!zonesEqual(sa.muteZones, sb.muteZones)) return false;
    }
    return true;
}

// Reinstalls a snapshot and re-pushes only the synths whose zones changed.
function restore(target) {
    const before = snapshot();
    restoring = true;
    try {
        synthHighlights.forEach((hi, id) => {
            const t = target.get(id);
            if (!t) return; // synth unknown to the snapshot: leave it alone
            hi.zones = t.zones;
            hi.muteZones = t.muteZones;
        });
        if (senders) {
            synthHighlights.forEach((hi, id) => {
                const t = target.get(id);
                if (!t) return;
                const c = before.get(id);
                const zonesChanged = !c || !zonesEqual(c.zones, t.zones);
                const mutesChanged = !c || !zonesEqual(c.muteZones, t.muteZones);
                if (zonesChanged) senders.pushZones(id);
                if (mutesChanged) senders.pushMutes(id);
                if (zonesChanged || mutesChanged) senders.updateLabel(id);
            });
            senders.redraw();
        }
    } finally {
        restoring = false;
    }
}

// Records the current zone state as a new undo step. Coalesced within the
// current task so a single logical edit (which may push zones then mutes)
// produces exactly one step.
export function scheduleCapture() {
    if (restoring || captureScheduled) return;
    captureScheduled = true;
    const epoch = captureEpoch;
    queueMicrotask(() => {
        captureScheduled = false;
        if (epoch !== captureEpoch || restoring) return;
        stack.capture(snapshot(), statesEqual);
    });
}

// Forgets the history and starts a fresh baseline. Called on structural
// changes that are out of the undo scope: session load, image load/reshape,
// synth add/remove/reorder.
export function resetHistory() {
    captureEpoch += 1;
    captureScheduled = false;
    stack.reset(snapshot());
}

export function undo() {
    const target = stack.undo();
    if (!target) return false;
    restore(target);
    return true;
}

export function redo() {
    const target = stack.redo();
    if (!target) return false;
    restore(target);
    return true;
}

export const canUndo = () => stack.canUndo();
export const canRedo = () => stack.canRedo();

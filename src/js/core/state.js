// Shared application state: the reactive store, the event bus, the
// per-synth registry and the viewer/image state.



// Minimal reactive store: holds a value and notifies subscribers when it
// changes. The foundation for the non-DOM shared state as main.js is
// split up (config, mirror options, shortcut bindings…).

export function createStore(initial) {
    let value = initial;
    const subscribers = new Set();

    const get = () => value;

    const set = (next) => {
        if (Object.is(next, value)) return;
        value = next;
        for (const fn of [...subscribers]) fn(value);
    };

    const update = (fn) => set(fn(value));

    // Calls `fn` immediately with the current value, then on every change.
    // Returns an unsubscribe function.
    const subscribe = (fn) => {
        subscribers.add(fn);
        fn(value);
        return () => subscribers.delete(fn);
    };

    return { get, set, update, subscribe };
}

// Minimal event bus: the decoupling seam between the modules as main.js
// is split up. Listeners are keyed by event name; `on` returns an
// unsubscribe function so a listener's lifetime is explicit.

export function createEventBus() {
    const listeners = new Map(); // name → Set<fn>

    const on = (name, fn) => {
        let set = listeners.get(name);
        if (!set) {
            set = new Set();
            listeners.set(name, set);
        }
        set.add(fn);
        return () => set.delete(fn);
    };

    const off = (name, fn) => {
        listeners.get(name)?.delete(fn);
    };

    // Iterates over a copy so a listener unsubscribing during dispatch
    // does not perturb the current round.
    const emit = (name, payload) => {
        const set = listeners.get(name);
        if (!set) return;
        for (const fn of [...set]) fn(payload);
    };

    return { on, off, emit };
}

// Shared bus for the application.
export const appEvents = createEventBus();

// Per-synth frontend state, keyed by synth id. Centralized here so the
// modules that read or write it (synth cards, viewer overlays, mirror
// snapshots, session restore) share a single owner instead of scattered
// module-level Maps in main.js.
//
// The Maps are exported directly: every existing .get/.set/.delete/.clear
// call site keeps working, only the declaration moves. Lifecycle helpers
// (clearSynthRegistry, removeSynthFromRegistry) cover the two bulk
// operations — a full session load and a synth removal.

// id → custom display name (None = default title)
export const synthNames = new Map();

// id → display number of the default title. Attributed once at creation,
// never changed nor reused: unlike the id (renumbered with the stack's
// display order), it keeps a synth's default name ("Synth #n") stable
// across reorders and removals.
export const synthDisplayNumbers = new Map();

// id → current color
export const synthColors = new Map();

// id → { visible, zones, muteZones, start, end, _wasVisible }
export const synthHighlights = new Map();

// id → { min, max }: the brightness threshold, mirroring the backend so
// the UI can mark out-of-range pixels as muted without asking per cell.
export const synthBrightnessBounds = new Map();

// id → current playhead cursor index (for drawing)
export const synthCursors = new Map();

// id → { w, h }: the grid dimensions the cursor was recorded on. The
// column count can change while synths play, so a recorded cursor can
// only be decoded (and erased) against the grid it was computed on.
export const synthCursorGrid = new Map();

// id → last tick's muted flag: a muted pixel keeps its position and stays
// drawn, at half opacity.
export const synthCursorMuted = new Map();

// Empties every map (full reset / session load).
export function clearSynthRegistry() {
    synthNames.clear();
    synthDisplayNumbers.clear();
    synthColors.clear();
    synthHighlights.clear();
    synthBrightnessBounds.clear();
    synthCursors.clear();
    synthCursorGrid.clear();
    synthCursorMuted.clear();
}

// Drops every entry of one synth (removal). The cursor overlay must be
// erased before calling this (see eraseSynthCursor).
export function removeSynthFromRegistry(id) {
    synthNames.delete(id);
    synthDisplayNumbers.delete(id);
    synthColors.delete(id);
    synthHighlights.delete(id);
    synthBrightnessBounds.delete(id);
    synthCursors.delete(id);
    synthCursorGrid.delete(id);
    synthCursorMuted.delete(id);
}

// Viewer/image state: the loaded image, its grid dimensions and the
// transient transform preview. Centralized here as a mutable object so
// the modules that read or write it (image processing, zone tools, the
// mirror snapshots, session restore) share one owner. An object (not a
// store) keeps `viewer.gridW` cheap and explicit at the many hot-path
// read sites.

export const viewer = {
    hasImage: false,
    origWidth: 0,
    origHeight: 0,
    originalPng: null,            // base64 PNG of the original image
    processedPixels: null,        // { width, height, rgba } of the last processed render
    totalPixels: 0,               // total number of pixels in the current grid
    gridW: 1,                     // current grid width in pixels
    gridH: 1,                     // current grid height in pixels
    transformPreviewPixels: null, // live preview { width, height, rgba }, shown instead of the normal image
};

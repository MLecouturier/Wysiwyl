// Timing: note-length math and the elapsed-play chrono.



// Note-length timing helpers: the frontend mirror of the backend's
// length_beats / pick_note_length (metronome.rs). Pure, no DOM.

// Note-length values in beats.
export const NOTE_LENGTH_BEATS = {
    sixteenth: 0.25,
    eighth: 0.5,
    quarter: 1,
    half: 2,
    whole: 4,
};

// Duration in compact clock form: 0:42, 1:23, 1:02:03 (whole seconds,
// locale-independent digits).
export function formatDurationClock(totalSeconds) {
    const total = Math.round(totalSeconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Total duration, in metronome beats, of the pixels a synth will travel
// over: for every selected pixel the brightness level picks a length among
// the enabled ones (exact mirror of the backend's pick_note_length), then
// the sum is divided by the synth's tempo ratio. `lengthsBeats` must be
// already ordered the way the brightness bands map onto it (the caller
// applies the reversal). Muted pixels count too — a silence occupies the
// duration of the note it would have played.
export function zonesTotalBeats(zones, processedPixels, lengthsBeats, ratio) {
    if (!processedPixels || zones.length === 0 || lengthsBeats.length === 0) return 0;
    const n = lengthsBeats.length;
    const { width: pw, rgba } = processedPixels;
    let total = 0;

    for (const z of zones) {
        for (const r of z.runs) {
            for (let col = r.x0; col <= r.x1; col++) {
                const i = (r.y * pw + col) * 4;
                if (i + 2 >= rgba.length) continue; // torn zone edge
                const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
                const level = Math.round(luma / 255 * 127);
                const idx = Math.min(Math.floor(level * n / 128), n - 1);
                total += lengthsBeats[idx];
            }
        }
    }
    return total / (ratio || 1);
}

// Elapsed-play timer displayed next to the metronome: starts counting
// with the first synthesizer that plays and freezes when none plays
// anymore. Pause/resume semantics — later play sessions keep accumulating
// on top of the frozen time; only the reset button zeroes it.
//
// Extracted from main.js and decoupled from the DOM/musical state: the
// caller injects the display element, the reset button and the
// "is anything playing?" probe, which keeps the timer testable.

// Formats a duration as mm:ss, switching to h:mm:ss once past the hour.
export function formatChronoTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Creates a chrono bound to a display element. `isPlaying` is called to
// probe the play state on every `sync()`. `resetButton` is optional.
export function createChrono({
    display,
    resetButton,
    isPlaying,
    now = () => performance.now(),
    raf = (cb) => requestAnimationFrame(cb),
    caf = (id) => cancelAnimationFrame(id),
}) {
    let elapsedMs = 0;      // time accumulated across play sessions
    let runningSince = null; // timestamp while running, else null
    let rafId = null;        // pending requestAnimationFrame handle

    // Total time to display: everything accumulated plus the current run
    const totalMs = () =>
        elapsedMs + (runningSince !== null ? now() - runningSince : 0);

    const render = () => {
        display.textContent = formatChronoTime(totalMs());
    };

    // The rAF loop only lives while a synth plays: each frame repaints the
    // readout then reschedules itself (nothing ticks in the background at
    // rest — the frozen value stays as-is on screen).
    const tick = () => {
        render();
        rafId = raf(tick);
    };

    // Starts counting when the first synth starts playing, freezes the
    // readout when the last one stops (keeping the accumulated time for
    // the next play session). Guarded, so repeated calls while the state
    // is unchanged are no-ops.
    function sync() {
        const playing = isPlaying();
        if (playing && runningSince === null) {
            runningSince = now();
            rafId = raf(tick);
        } else if (!playing && runningSince !== null) {
            elapsedMs += now() - runningSince;
            runningSince = null;
            caf(rafId);
            rafId = null;
            render();
        }
    }

    function reset() {
        elapsedMs = 0;
        if (runningSince !== null) runningSince = now();
        render();
    }

    resetButton?.addEventListener('click', reset);
    render(); // 00:00 at startup

    return { sync, reset, totalMs, render };
}

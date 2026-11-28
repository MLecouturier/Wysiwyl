// Wall-clock calibration: maps the Rust epoch clock (the reference used by
// the `synth-pixel-upcoming` announcements) onto the local
// `performance.now()` timeline. A few round-trips at startup and periodically
// (low frequency), keeping the measurement with the smallest round-trip; the
// Rust timestamp is assumed taken at the midpoint of the exchange. There is
// no exchange per tick: `due_at_ms` is converted locally between two
// calibrations.

// Offset of one exchange: `rust_ms - local_mid`, where the Rust timestamp is
// assumed taken at the midpoint of the round-trip (t0 before the call, t1
// after it). Pure, exported for unit tests.
export function midpointOffset(t0, t1, rustMs) {
    return rustMs - (t0 + t1) / 2;
}

// Offset of the sample with the smallest round-trip in the window, or null
// when there is none. The smallest round-trip is the one least polluted by
// IPC scheduling jitter. Pure, exported for unit tests.
export function bestOffset(samples) {
    if (!samples || samples.length === 0) return null;
    let best = samples[0];
    for (const s of samples) {
        if (s.rtt < best.rtt) best = s;
    }
    return best.offset;
}

// Calibrator factory. `windowSize` keeps a short rolling window of the last
// exchanges (so a system-clock adjustment is picked up within a few
// calibrations instead of being frozen on a stale best); `intervalMs` is the
// low-frequency re-calibration period.
export function createClockSync({ intervalMs = 10000, windowSize = 5 } = {}) {
    const invoke = (...args) => window.__TAURI__.core.invoke(...args);

    let samples = [];
    let offsetMs = null;
    let timer = 0;

    // One round-trip: measures the local times around the call, keeps the
    // sample (rtt + midpoint offset) and refreshes the retained offset.
    async function sample() {
        const t0 = performance.now();
        let rustMs;
        try {
            rustMs = await invoke('now_epoch_ms');
        } catch (err) {
            console.error('Error in now_epoch_ms:', err);
            return;
        }
        const t1 = performance.now();
        if (!Number.isFinite(rustMs)) return;
        const rtt = t1 - t0;
        if (rtt < 0) return;
        samples.push({ rtt, offset: midpointOffset(t0, t1, rustMs) });
        if (samples.length > windowSize) samples.shift();
        offsetMs = bestOffset(samples);
    }

    function start() {
        sample();
        if (timer) return;
        timer = setInterval(sample, intervalMs);
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = 0;
    }

    // Rust epoch ms → local `performance.now()` ms, or null while
    // uncalibrated (the caller then falls back to the current behavior).
    function rustToLocal(rustMs) {
        if (offsetMs === null || !Number.isFinite(rustMs)) return null;
        return rustMs - offsetMs;
    }

    return {
        start,
        stop,
        sample,
        rustToLocal,
        isCalibrated: () => offsetMs !== null,
    };
}

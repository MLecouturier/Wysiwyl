// Generic mouse-wheel / trackpad stepper for hovered numeric inputs, plus
// the notch-vs-trackpad classifier shared by every wheel handler (the
// delegated stepper below and the synth volume wheel).
//
// Trackpad scrolls emit many tiny deltas: they are accumulated, and one
// step is applied per `trackpadThreshold` accumulated units. Mouse-wheel
// notches are detected separately and apply exactly one step per
// physical notch.

export const WHEEL_ACCUM_RESET_MS = 200; // scroll pause after which the accumulator resets

// --- Mouse-wheel notch vs trackpad (precise) scroll classification ---
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

let trackpadThreshold = 100; // accumulated deltas per step (config: wheel_trackpad_threshold)
let wheelLastTime = 0;
let wheelInNotchRun = false;

// Debug logging is opt-in and may run outside a browser (tests): guard it.
const wheelDebugEnabled = () =>
    typeof localStorage !== 'undefined' && localStorage.getItem('wheelDebug') === '1';

// Applies the configured trackpad sensitivity (a no-op on invalid input).
export function setTrackpadThreshold(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) trackpadThreshold = n;
    if (wheelDebugEnabled()) {
        console.debug(`wheel: effective trackpad threshold=${trackpadThreshold}`);
    }
}

export function getTrackpadThreshold() {
    return trackpadThreshold;
}

// Classifies one wheel event as a discrete notch (true) or a continuous
// trackpad scroll (false), updating the shared run state.
export function isWheelNotch(event, delta) {
    const gap = event.timeStamp - wheelLastTime;
    const isolated = gap > WHEEL_NOTCH_GAP_MS;
    const magnitude = Math.abs(delta);
    const notch =
        event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || // line/page mode: real wheel
        (magnitude >= WHEEL_NOTCH_MIN_DELTA && (isolated || wheelInNotchRun));
    if (wheelDebugEnabled()) {
        console.debug(`wheel: delta=${delta} mode=${event.deltaMode} gap=${Math.round(gap)}ms isolated=${isolated} run=${wheelInNotchRun} notch=${notch}`);
    }
    wheelLastTime = event.timeStamp;
    wheelInNotchRun = notch;
    return notch;
}

// Keeps the classifier's clock fresh across page scrolls (wheel events
// that never reach the input stepper): a trackpad swipe crossing over an
// input mid-gesture must not look like an isolated mouse notch.
export function refreshWheelClock(event) {
    wheelLastTime = event.timeStamp;
}

// Installs the delegated document-level stepper: scrolling over a hovered
// numeric input (number or range) increments/decrements it, then
// dispatches the input/change events so the existing listeners apply it.
// Delegated so dynamically created inputs (synth sliders) work too.
export function installInputStepper() {
    let wheelAccum = 0;
    let wheelTime = 0;
    let wheelTarget = null;

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
            if (Math.abs(wheelAccum) < trackpadThreshold) return; // keep scrolling
            wheelAccum -= Math.sign(wheelAccum) * trackpadThreshold;
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

    // Registered after the stepper so it runs after it and only refreshes
    // the timestamp, never the classification inputs.
    document.addEventListener('wheel', (event) => {
        if (event.ctrlKey) return; // pinch zoom is not a scroll
        refreshWheelClock(event);
    }, { passive: true });
}

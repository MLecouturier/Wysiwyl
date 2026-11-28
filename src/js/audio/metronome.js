// Metronome and its clock source: BPM controls, tick LED, sync badge
// and the master/slave clock mode selects.

import { t } from '../core/i18n.js';
import { clampBpm } from '../core/utils.js';
import { appEvents } from '../core/state.js';

// Metronome domain: the BPM controls, the tick LED and the DAW-sync /
// master-clock badge. Owns the BPM input; the caller injects the
// cross-domain hooks it needs (the zone-label refresh on a tempo change,
// the play-state probe before stopping, and the cleanup run when the
// metronome goes idle).

// Whole-number clamp to 20–300, shared with the session code
export { clampBpm };

// Current tempo as shown in the BPM input (the UI source of truth), for
// modules that need the tempo without holding the metronome instance.
export function currentBpm() {
    return Number(document.querySelector('#bpm-input')?.value) || 120;
}

export function createMetronome({ isPlaying, updateZonesLabels, onIdle }) {
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    const bpmInput = document.querySelector('#bpm-input');
    const metronomeLed = document.querySelector('#metronome-led');
    const beatRing = document.querySelector('.beat-ring');
    const denominatorSelect = document.querySelector('#time-signature-denominator');
    const syncBadge = document.querySelector('#sync-badge');
    const bpmMinus10 = document.querySelector('#bpm-minus10');
    const bpmMinus5 = document.querySelector('#bpm-minus5');
    const bpmPlus5 = document.querySelector('#bpm-plus5');
    const bpmPlus10 = document.querySelector('#bpm-plus10');
    const bpmUpBtn = document.querySelector('#bpm-up');
    const bpmDownBtn = document.querySelector('#bpm-down');
    const bpmControls = [bpmMinus10, bpmMinus5, bpmPlus5, bpmPlus10, bpmUpBtn, bpmDownBtn];

    let running = false;
    let synced = false;
    let master = false;

    const getBpm = () => clampBpm(bpmInput.value);

    // Pushes the tempo to the backend whether or not the metronome runs:
    // the manual step of a paused synth reads the backend's BPM too.
    function pushBpm(bpm) {
        return invoke('set_metronome_bpm', { bpm })
            .catch(err => console.error('Error in set_metronome_bpm:', err));
    }

    // Programmatic tempo change (config default, session restore)
    const setBpm = (value) => {
        const bpm = clampBpm(value);
        bpmInput.value = bpm;
        pushBpm(bpm);
    };

    async function applyBpm(newBpm) {
        const clamped = clampBpm(newBpm, getBpm());
        bpmInput.value = clamped;
        await pushBpm(clamped);
        updateZonesLabels();
    }

    // Starts the Rust metronome if it's not already running. The local
    // flag is resynchronized with the backend first: a failed call
    // earlier must not leave the two believing different things.
    async function ensureStarted() {
        if (running) {
            running = await invoke('is_metronome_running').catch(() => false);
            if (running) return;
        }
        await pushBpm(getBpm());
        await invoke('start_metronome');
        running = true;
    }

    // Stops the Rust metronome if no synth is playing anymore
    async function stopIfIdle() {
        if (isPlaying()) return;
        if (!running) {
            // Defensive: the backend may still run after a failed stop
            running = await invoke('is_metronome_running').catch(() => false);
            if (!running) return;
        }

        try {
            await invoke('stop_metronome');
        } catch (err) {
            console.error('Error in stop_metronome:', err);
            return;
        }
        running = false;
        onIdle?.();
    }

    function setSynced(value, bpm) {
        synced = value;
        if (value && Number.isFinite(bpm)) {
            // Display only: the backend already follows the measured tempo
            bpmInput.value = clampBpm(bpm);
        }
        bpmInput.disabled = value;
        bpmControls.forEach(btn => { btn.disabled = value; });
        // The seconds display of the zones value must follow the DAW's
        // measured BPM (a no-op recomputation in the other display modes)
        updateZonesLabels();
        refreshBadge();
    }

    // The badge reflects the current clock state: "Sync DAW" (tempo
    // controls locked) or "Clock master" (broadcasting to the outputs).
    // The data-i18n-title follows so the contextual help matches the state.
    function refreshBadge() {
        const isMaster = master && !synced;
        syncBadge.classList.toggle('master', isMaster);
        syncBadge.classList.toggle('hidden', !(synced || master));
        const key = isMaster ? 'metronome.masterBadge' : 'metronome.syncBadge';
        syncBadge.textContent = t(key);
        syncBadge.title = t(key);
        syncBadge.dataset.i18nTitle = key;
    }

    bpmMinus10.addEventListener('click', () => applyBpm(getBpm() - 10));
    bpmMinus5.addEventListener('click', () => applyBpm(getBpm() - 5));
    bpmPlus5.addEventListener('click', () => applyBpm(getBpm() + 5));
    bpmPlus10.addEventListener('click', () => applyBpm(getBpm() + 10));

    // Custom ±1 spinner arrows (replacing the native, uncolorable ones)
    bpmUpBtn.addEventListener('click', () => applyBpm(getBpm() + 1));
    bpmDownBtn.addEventListener('click', () => applyBpm(getBpm() - 1));

    // Direct keyboard input: validated on blur or on "Enter"
    bpmInput.addEventListener('change', () => applyBpm(getBpm()));

    // Keyboard support: ↑/↓ arrows to increment/decrement by 1
    bpmInput.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowUp') {
            event.preventDefault(); // prevents the native <input type="number"> behavior
            applyBpm(getBpm() + 1);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            applyBpm(getBpm() - 1);
        }
    });

    // ---- Circular beat indicator ----
    // The ring around the LED is divided into `beats_per_bar` equal portions
    // (one per beat unit of the time signature): a countdown that empties as
    // the measure elapses — the current beat is highlighted, then the
    // portions disappear one after another and the ring fills again on the
    // next downbeat. Plain SVG, no dependency. The count follows the
    // signature (3/4 → 3 portions, 7/8 → 7 portions).
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const RING_OUTER = 47;
    const RING_INNER = 31;
    let beatsPerBar = 4;

    // Point of the ring at `angle` (radians) and radius `r`, in the 0..100
    // viewBox (center 50,50). 0 rad points right; -π/2 is the top, where the
    // downbeat portion starts.
    function ringPoint(angle, radius) {
        return [50 + radius * Math.cos(angle), 50 + radius * Math.sin(angle)];
    }

    function arcTo(radius, largeArc, sweep, [x, y]) {
        return `A ${radius} ${radius} 0 ${largeArc} ${sweep} ${x.toFixed(3)} ${y.toFixed(3)}`;
    }

    // Donut portion between the angles a0 and a1: outer arc, inner arc back
    // (opposite sweep → the inner edge is a hole under the nonzero rule).
    function sectorPath(a0, a1) {
        const largeArc = a1 - a0 > Math.PI ? 1 : 0;
        const [ox0, oy0] = ringPoint(a0, RING_OUTER);
        const [ox1, oy1] = ringPoint(a1, RING_OUTER);
        const [ix1, iy1] = ringPoint(a1, RING_INNER);
        const [ix0, iy0] = ringPoint(a0, RING_INNER);
        return `M ${ox0.toFixed(3)} ${oy0.toFixed(3)} `
            + `${arcTo(RING_OUTER, largeArc, 1, [ox1, oy1])} `
            + `L ${ix1.toFixed(3)} ${iy1.toFixed(3)} `
            + `${arcTo(RING_INNER, largeArc, 0, [ix0, iy0])} Z`;
    }

    // Full annulus (a single beat per bar): two half arcs per edge.
    function fullRingPath() {
        const [ox0, oy0] = ringPoint(-Math.PI / 2, RING_OUTER);
        const [oxm, oym] = ringPoint(Math.PI / 2, RING_OUTER);
        const [ix0, iy0] = ringPoint(-Math.PI / 2, RING_INNER);
        const [ixm, iym] = ringPoint(Math.PI / 2, RING_INNER);
        return `M ${ox0.toFixed(3)} ${oy0.toFixed(3)} `
            + `A ${RING_OUTER} ${RING_OUTER} 0 1 1 ${oxm.toFixed(3)} ${oym.toFixed(3)} `
            + `A ${RING_OUTER} ${RING_OUTER} 0 1 1 ${ox0.toFixed(3)} ${oy0.toFixed(3)} Z `
            + `M ${ix0.toFixed(3)} ${iy0.toFixed(3)} `
            + `A ${RING_INNER} ${RING_INNER} 0 1 0 ${ixm.toFixed(3)} ${iym.toFixed(3)} `
            + `A ${RING_INNER} ${RING_INNER} 0 1 0 ${ix0.toFixed(3)} ${iy0.toFixed(3)} Z`;
    }

    function renderBeatRing(count) {
        if (!beatRing) return;
        const step = (2 * Math.PI) / count;
        const segments = Array.from({ length: count }, (_, i) => {
            const path = document.createElementNS(SVG_NS, 'path');
            const a0 = -Math.PI / 2 + i * step;
            path.setAttribute('d', count === 1 ? fullRingPath() : sectorPath(a0, a0 + step));
            path.setAttribute('class', i === 0 ? 'beat-segment downbeat' : 'beat-segment');
            return path;
        });
        beatRing.replaceChildren(...segments);
    }

    // Duration of one beat unit, in ms: the engine tempo counts quarter
    // notes, and one beat unit is the signature's denominator note (4/4 → a
    // quarter, 7/8 → an eighth). Paces the fade-out of the current portion so
    // it reaches zero exactly when the next beat starts.
    function beatDurationMs() {
        const denominator = Number(denominatorSelect?.value) || 4;
        return (60000 / getBpm()) * (4 / denominator);
    }

    // Countdown: the portions before the current beat are gone (they have
    // elapsed), the current beat is highlighted and fades out over its own
    // duration, and the later ones stay lit.
    function highlightBeat(beatInBar) {
        if (!beatRing) return;
        const beatMs = beatDurationMs();
        beatRing.querySelectorAll('.beat-segment').forEach((segment, i) => {
            segment.classList.toggle('gone', i < beatInBar);
            if (i === beatInBar) {
                segment.classList.add('current');
                // (Re)start the fade-out timed to the beat: setting the
                // duration then re-adding `.fading` (with a reflow between)
                // restarts it on every beat.
                segment.style.animationDuration = `${beatMs}ms`;
                segment.classList.remove('fading');
                void segment.getBoundingClientRect();
                segment.classList.add('fading');
            } else {
                segment.classList.remove('current', 'fading');
                segment.style.animationDuration = '';
            }
        });
    }

    // Sets the number of portions from the time signature (also fed by every
    // beat event, so it self-corrects live). Builds the ring at rest: every
    // portion visible, with no highlight nor fade until the first beat.
    function setBeatsPerBar(count) {
        const n = Math.max(1, Math.min(16, Math.round(Number(count) || 4)));
        if (n === beatsPerBar && beatRing?.childElementCount === n) return;
        beatsPerBar = n;
        renderBeatRing(n);
        beatRing?.querySelectorAll('.beat-segment').forEach(segment => {
            segment.classList.remove('current', 'fading', 'gone');
            segment.style.animationDuration = '';
        });
    }

    // A flash of every armed synth's play button, on the beat: the blinking
    // follows the real beat, not a free-running CSS animation.
    function pulseArmedSynths() {
        document
            .querySelectorAll('.synth-play.armed, .synth-tab-play.armed')
            .forEach(btn => {
                btn.classList.add('pulse');
                setTimeout(() => btn.classList.remove('pulse'), 120);
            });
    }

    // Listens to the beat events emitted by the Rust backend: one per beat
    // of the time signature, carrying the position in the measure.
    listen('metronome-tick', (event) => {
        const { beat_in_bar: beatInBar, beats_per_bar: beats } = event.payload ?? {};
        if (Number.isFinite(beats)) setBeatsPerBar(beats);
        if (Number.isFinite(beatInBar)) highlightBeat(beatInBar);
        metronomeLed.classList.add('active');
        setTimeout(() => metronomeLed.classList.remove('active'), 100);
        pulseArmedSynths();
    });

    // DAW sync and master clock: while an external MIDI clock (24 ppqn)
    // streams in, the metronome follows it and the tempo controls are
    // disabled — the backend pushes the measured BPM so the display keeps
    // showing the DAW's tempo. In master mode the app broadcasts its own
    // clock: the badge shows the master state, and the controls stay active.
    // Each event only carries the fields of its transition: a master-only
    // event must not reset the sync state, and vice versa.
    listen('metronome-sync', (event) => {
        const { synced: s, bpm, master: m } = event.payload ?? {};
        if (m !== undefined) master = Boolean(m);
        if (s !== undefined) setSynced(Boolean(s), Number(bpm));
        else refreshBadge();
    });

    return {
        getBpm,
        setBpm,
        getInput: () => bpmInput,
        ensureStarted,
        stopIfIdle,
        markStopped: () => { running = false; },
        isRunning: () => running,
        refreshBadge,
        setBeatsPerBar,
    };
}

// Metronome clock source (master / slave) selects: the mode and the input
// port to follow. The backend persists the choice and applies it live; the
// selects only reflect it and push changes.

const CLOCK_MODES = ['off', 'auto', 'input', 'master'];

export function createClockSource() {
    const { invoke } = window.__TAURI__.core;

    const clockModeSelect = document.querySelector('#clock-mode-select');
    const clockSourceSelect = document.querySelector('#clock-source-select');

    // Persisted source applied once the port list is populated (both arrive
    // asynchronously); null = nothing pending.
    let pendingClockSource = null;
    let clockPortsLoaded = false;

    function updateVisibility() {
        clockSourceSelect.classList.toggle('hidden', clockModeSelect.value !== 'input');
    }

    // Applies the config's clock mode/source to the selects once both are
    // known: the mode select directly, the source once the port list has
    // arrived (the stored port may have disappeared since).
    function hydrate(mode, source) {
        clockModeSelect.value = CLOCK_MODES.includes(mode) ? mode : 'auto';
        if (source) {
            pendingClockSource = source;
            applyPending();
        }
        updateVisibility();
    }

    // Reverts to Auto on both sides (the change persists, like any mode
    // change): used when the selected/saved input port no longer exists.
    function revertToAuto() {
        clockModeSelect.value = 'auto';
        updateVisibility();
        invoke('set_clock_mode', { mode: 'auto', source: null })
            .catch(err => console.error('Error in set_clock_mode:', err));
    }

    function applyPending() {
        if (pendingClockSource === null || !clockPortsLoaded) return;
        const name = pendingClockSource;
        pendingClockSource = null;
        const option = clockSourceSelect.querySelector(`option[value="${CSS.escape(name)}"]`);
        if (option) {
            clockSourceSelect.value = name;
        } else {
            // The saved input port no longer exists (device unplugged, or no
            // input port at all)
            revertToAuto();
        }
    }

    function apply() {
        const mode = clockModeSelect.value;
        updateVisibility();
        // Guard: "Source…" needs a selected port (an empty list disables the
        // option, but stay safe against a stale select)
        if (mode === 'input' && !clockSourceSelect.value) {
            clockModeSelect.value = 'auto';
            return;
        }
        invoke('set_clock_mode', {
            mode,
            source: mode === 'input' ? clockSourceSelect.value : null,
        }).catch(err => console.error('Error in set_clock_mode:', err));
    }

    // Input ports offered as the sync source (the backend opens every input
    // port for the app's lifetime). The app's own virtual port is the route
    // a DAW's MIDI clock takes. Loaded at startup and again on a hot-plug
    // (see the backend's `midi-ports-changed` event), preserving the current
    // selection while it still exists.
    function loadClockPorts() {
        const previous = clockSourceSelect.value;
        invoke('list_midi_input_ports').then(ports => {
            // Port names come from the OS: built as text nodes, never parsed
            // as HTML (an arbitrary virtual port name must not inject markup)
            clockSourceSelect.replaceChildren(...ports.map(p =>
                new Option(p.isVirtual ? t('metronome.virtualSource') : p.name, p.name)
            ));
            if (previous && ports.some(p => p.name === previous)) {
                clockSourceSelect.value = previous;
            } else if (previous && clockModeSelect.value === 'input') {
                // The followed source vanished (device unplugged): fall back
                // to Auto, as the startup path does.
                revertToAuto();
            }
            // Without any input port the "Source…" mode is meaningless
            clockModeSelect.querySelector('option[value="input"]').disabled = ports.length === 0;
            clockPortsLoaded = true;
            applyPending();
        }).catch(err => console.error('Error in list_midi_input_ports:', err));
    }
    loadClockPorts();

    clockModeSelect.addEventListener('change', apply);
    clockSourceSelect.addEventListener('change', apply);

    return { hydrate, refreshPorts: loadClockPorts };
}

// Global time signature: the frame the per-synth accent patterns are read
// against. The backend persists it and applies it live (the metronome reads
// it on every wake); changing it re-renders the synths' accent grids, whose
// number of slots follows the signature's numerator. Entered directly as a
// numerator (1–16) and a denominator (1/2/4/8/16).

const TIME_SIGNATURE_MAX_NUMERATOR = 16;

export function createTimeSignature({ onSignatureChange } = {}) {
    const { invoke } = window.__TAURI__.core;

    const numeratorInput = document.querySelector('#time-signature-numerator');
    const denominatorSelect = document.querySelector('#time-signature-denominator');

    // The signature in force, as an "n/d" string (numerator clamped to 1–16).
    function currentValue() {
        const numerator = Math.min(
            Math.max(Number(numeratorInput.value) || 1, 1), TIME_SIGNATURE_MAX_NUMERATOR);
        return `${numerator}/${denominatorSelect.value}`;
    }

    function push() {
        invoke('set_time_signature', { timeSignature: currentValue() })
            .catch(err => console.error('Error in set_time_signature:', err));
        onSignatureChange?.(currentValue());
    }

    // Applies the persisted value without echoing it back (already stored).
    function hydrate(value) {
        if (!value) return;
        const [n, d] = String(value).split('/');
        if (n) {
            numeratorInput.value = String(
                Math.min(Math.max(Number(n) || 4, 1), TIME_SIGNATURE_MAX_NUMERATOR));
        }
        if (d && denominatorSelect.querySelector(`option[value="${CSS.escape(d)}"]`)) {
            denominatorSelect.value = d;
        }
    }

    numeratorInput.addEventListener('change', push);
    denominatorSelect.addEventListener('change', push);

    return { hydrate, getValue: currentValue };
}

// Global launch quantization: the segmented Off | Beat | Bar control of the
// synth-list header. The backend owns the value (engine state, saved with
// the session); this only reflects it and pushes the user's choice. Changing
// it is a session change, so it marks the session dirty.

const LAUNCH_MODES = ['off', 'beat', 'bar'];

export function createLaunchQuantize() {
    const { invoke } = window.__TAURI__.core;

    const buttons = Array.from(document.querySelectorAll('.launch-quantize-btn'));
    let mode = 'beat';

    // Reflects a mode without pushing it back (startup, session load).
    function hydrate(value) {
        mode = LAUNCH_MODES.includes(value) ? value : 'beat';
        buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    }

    function select(next) {
        if (!LAUNCH_MODES.includes(next) || next === mode) return;
        hydrate(next);
        appEvents.emit('session-dirty');
        invoke('set_launch_quantize', { mode: next })
            .catch(err => console.error('Error in set_launch_quantize:', err));
    }

    buttons.forEach(btn => btn.addEventListener('click', () => select(btn.dataset.mode)));

    return { hydrate, getMode: () => mode };
}

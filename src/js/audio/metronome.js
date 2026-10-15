// Metronome and its clock source: BPM controls, tick LED, sync badge
// and the master/slave clock mode selects.

import { t } from '../core/i18n.js';
import { clampBpm } from '../core/utils.js';

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

    // Listens to ticks emitted by the Rust backend
    listen('metronome-tick', () => {
        metronomeLed.classList.add('active');
        setTimeout(() => metronomeLed.classList.remove('active'), 100);
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

    function applyPending() {
        if (pendingClockSource === null || !clockPortsLoaded) return;
        const name = pendingClockSource;
        pendingClockSource = null;
        const option = clockSourceSelect.querySelector(`option[value="${CSS.escape(name)}"]`);
        if (option) {
            clockSourceSelect.value = name;
        } else {
            // The saved input port no longer exists (device unplugged, or no
            // input port at all): revert to Auto on both sides, the backend
            // included (the change persists, like any mode change)
            clockModeSelect.value = 'auto';
            updateVisibility();
            invoke('set_clock_mode', { mode: 'auto', source: null })
                .catch(err => console.error('Error in set_clock_mode:', err));
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

    // Input ports offered as the sync source, populated once at startup
    // (the backend opens every input port for the app's lifetime). The
    // app's own virtual port is the route a DAW's MIDI clock takes.
    invoke('list_midi_input_ports').then(ports => {
        // Port names come from the OS: built as text nodes, never parsed
        // as HTML (an arbitrary virtual port name must not inject markup)
        clockSourceSelect.replaceChildren(...ports.map(p =>
            new Option(p.isVirtual ? t('metronome.virtualSource') : p.name, p.name)
        ));
        // Without any input port the "Source…" mode is meaningless
        clockModeSelect.querySelector('option[value="input"]').disabled = ports.length === 0;
        clockPortsLoaded = true;
        applyPending();
    }).catch(err => console.error('Error in list_midi_input_ports:', err));

    clockModeSelect.addEventListener('change', apply);
    clockSourceSelect.addEventListener('change', apply);

    return { hydrate };
}

// Global time signature: the frame the per-synth accent patterns are read
// against. The backend persists it and applies it live (the metronome reads
// it on every wake); changing it re-renders the synths' accent grids, whose
// number of slots follows the signature's numerator.

export function createTimeSignature({ onSignatureChange } = {}) {
    const { invoke } = window.__TAURI__.core;

    const select = document.querySelector('#time-signature-select');

    // Applies the persisted value (startup / session restore) without
    // echoing it back to the backend (it is already stored).
    function hydrate(value) {
        if (value && select.querySelector(`option[value="${CSS.escape(value)}"]`)) {
            select.value = value;
        }
    }

    select.addEventListener('change', () => {
        invoke('set_time_signature', { timeSignature: select.value })
            .catch(err => console.error('Error in set_time_signature:', err));
        onSignatureChange?.(select.value);
    });

    return { hydrate, getValue: () => select.value };
}

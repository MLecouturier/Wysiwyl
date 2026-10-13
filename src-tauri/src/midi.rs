use midir::{MidiInput, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::locks::MutexExt;
use crate::metronome::{self, MetronomeState};
use crate::state::{MidiState, ProgramState, SynthState};

#[cfg(unix)]
use midir::os::unix::{VirtualInput, VirtualOutput};

/// System realtime messages: the MIDI clock stream (24 pulses per
/// quarter note) and the transport messages that accompany it, sent in
/// master mode and received from a DAW in slave mode.
pub const MIDI_CLOCK: u8 = 0xF8;
pub const MIDI_START: u8 = 0xFA;
pub const MIDI_CONTINUE: u8 = 0xFB;
pub const MIDI_STOP: u8 = 0xFC;
pub const MIDI_SONG_POSITION: u8 = 0xF2;

/// Index of the app's virtual MIDI output port. A sentinel far above any
/// physical port index: it must stay well below 2^53 to survive the
/// JS/JSON round-trip unharmed, and never collide with a physical index.
#[cfg(unix)]
pub const VIRTUAL_PORT_INDEX: usize = 1_000_000;

/// Name given to both virtual endpoints (input and output): in the DAW,
/// the app appears as a MIDI source and a sync destination named "Wysiwyl".
#[cfg(unix)]
pub const VIRTUAL_PORT_NAME: &str = "Wysiwyl";

#[derive(Serialize, Clone)]
pub struct MidiPortInfo {
    pub index: usize,
    pub name: String,
    /// True for the app's own virtual port, created for DAW routing.
    #[serde(rename = "isVirtual")]
    pub is_virtual: bool,
}

/// An entry of the MIDI input port list, offered when choosing the
/// metronome's clock sync source. Unlike output ports, input ports are
/// identified by name: it is the exact string the input listeners report
/// (and the value stored in the config as the sync source).
#[derive(Serialize, Clone)]
pub struct MidiInputPortInfo {
    pub name: String,
    /// True for the app's own virtual input port, the route a DAW's MIDI
    /// clock takes into the app.
    #[serde(rename = "isVirtual")]
    pub is_virtual: bool,
}

/// An open output connection, with the stable OS identifier of the port
/// it was opened on (empty for the app's virtual port). Port indexes are
/// positional: after a hot-plug the same index may designate another
/// device, so the identifier tells a still-valid connection from a stale
/// one.
pub struct OutputConnection {
    pub conn: MidiOutputConnection,
    pub port_id: String,
}

/// Opens the connection to the given output port index, or None if the
/// port doesn't exist or can't be opened. On unix, the virtual port
/// sentinel is created on demand instead of connected.
#[cfg(unix)]
fn open_connection(port_index: usize) -> Option<OutputConnection> {
    if port_index == VIRTUAL_PORT_INDEX {
        return create_virtual_connection().map(|conn| OutputConnection {
            conn,
            port_id: String::new(),
        });
    }
    open_physical_connection(port_index)
}

/// Opens the connection to the given output port index, or None if the
/// port doesn't exist or can't be opened.
#[cfg(not(unix))]
fn open_connection(port_index: usize) -> Option<OutputConnection> {
    open_physical_connection(port_index)
}

/// Opens the connection to the given physical output port index, or None
/// if the port doesn't exist or can't be opened.
fn open_physical_connection(port_index: usize) -> Option<OutputConnection> {
    let midi_out = match MidiOutput::new("Wysiwyl") {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Unable to initialize MIDI: {e}");
            return None;
        }
    };

    let ports = midi_out.ports();
    if ports.is_empty() {
        eprintln!("No MIDI output port detected.");
        return None;
    }

    let port = match ports.get(port_index) {
        Some(p) => p,
        None => {
            eprintln!("MIDI output port {port_index} not found.");
            return None;
        }
    };

    let port_name = midi_out
        .port_name(port)
        .unwrap_or_else(|_| "unknown port".to_string());
    let port_id = port.id();

    match midi_out.connect(port, "wysiwyl-out") {
        Ok(conn) => {
            println!("Connected to MIDI port {port_index}: {port_name}");
            Some(OutputConnection { conn, port_id })
        }
        Err(e) => {
            eprintln!("Failed to connect to MIDI port {port_index} ({port_name}): {e}");
            None
        }
    }
}

/// Creates the app's own virtual MIDI output port: it shows up in every
/// DAW as a MIDI input source, so Wysiwyl can drive software instruments
/// without any hardware device.
#[cfg(unix)]
fn create_virtual_connection() -> Option<MidiOutputConnection> {
    let midi_out = match MidiOutput::new("Wysiwyl") {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Unable to initialize MIDI: {e}");
            return None;
        }
    };
    match midi_out.create_virtual(VIRTUAL_PORT_NAME) {
        Ok(conn) => {
            println!("Virtual MIDI output port '{VIRTUAL_PORT_NAME}' created");
            Some(conn)
        }
        Err(e) => {
            eprintln!("Failed to create the virtual MIDI output port: {e}");
            None
        }
    }
}

/// After a failed open, the port is not retried before this delay: a
/// missing device must not cost a full OS enumeration on every note,
/// inside the metronome tick.
const FAILED_OPEN_RETRY: Duration = Duration::from_secs(2);

impl MidiState {
    /// Runs `f` with the open connection for the given port, opening it
    /// lazily on first use. Notes are silently dropped if the port is
    /// unavailable; a failed open is retried at most every
    /// `FAILED_OPEN_RETRY`. A send error (device unplugged) drops the
    /// connection, so the next message reopens the port. `f` returns
    /// whether every send succeeded.
    fn with_connection(
        &self,
        port_index: usize,
        f: impl FnOnce(&mut MidiOutputConnection) -> bool,
    ) {
        {
            let failed = self.failed_opens.lock_safe();
            if failed
                .get(&port_index)
                .is_some_and(|at| at.elapsed() < FAILED_OPEN_RETRY)
            {
                return;
            }
        }
        let mut connections = self.connections.lock_safe();
        if let std::collections::hash_map::Entry::Vacant(entry) = connections.entry(port_index) {
            match open_connection(port_index) {
                Some(conn) => {
                    entry.insert(conn);
                    self.failed_opens.lock_safe().remove(&port_index);
                }
                None => {
                    self.failed_opens
                        .lock_safe()
                        .insert(port_index, Instant::now());
                    return;
                }
            }
        }
        if let Some(out) = connections.get_mut(&port_index) {
            if !f(&mut out.conn) {
                eprintln!("MIDI send failed on port {port_index}: connection dropped");
                connections.remove(&port_index);
            }
        }
    }

    /// Drops the output connections whose port disappeared or whose index
    /// now designates another device (hot-plug), so the next message
    /// reopens the right one. `current` maps each physical port index to
    /// its stable OS identifier. Also forgets the failed opens, so a
    /// device plugged back in is picked up right away.
    pub fn reconcile_outputs(&self, current: &HashMap<usize, String>) {
        let mut connections = self.connections.lock_safe();
        connections.retain(|index, out| {
            #[cfg(unix)]
            if *index == VIRTUAL_PORT_INDEX {
                return true;
            }
            let valid = current.get(index) == Some(&out.port_id);
            if !valid {
                println!("MIDI output port {index} changed or disappeared: connection dropped");
            }
            valid
        });
        self.failed_opens.lock_safe().clear();
    }

    /// Sends All Sound Off (CC 120) and All Notes Off (CC 123) on the 16
    /// channels of an output port: silences every note, including those the
    /// app lost track of.
    pub fn all_notes_off(&self, port_index: usize) {
        self.with_connection(port_index, |conn| {
            (0..16u8).all(|ch| {
                conn.send(&[0xB0 | ch, 120, 0]).is_ok() && conn.send(&[0xB0 | ch, 123, 0]).is_ok()
            })
        });
    }

    /// Sends a Note On message on the given output port (0x90 | channel).
    pub fn note_on(&self, port_index: usize, channel: u8, note: u8, velocity: u8) {
        self.with_connection(port_index, |conn| {
            send_note_on(conn, channel, note, velocity)
        });
    }

    /// Sends a Note Off message on the given output port (0x80 | channel).
    pub fn note_off(&self, port_index: usize, channel: u8, note: u8) {
        self.with_connection(port_index, |conn| send_note_off(conn, channel, note));
    }

    /// Sends a Channel Volume message (CC 7) on the given output port and
    /// channel. `volume` is the raw MIDI value (0–127), sent as-is.
    pub fn send_channel_volume(&self, port_index: usize, channel: u8, volume: u8) {
        self.with_connection(port_index, |conn| {
            conn.send(&[0xB0 | (channel & 0x0F), 7, volume & 0x7F])
                .is_ok()
        });
    }

    /// Sends a Bank Select (CC 0 / CC 32, the known parts only) followed
    /// by a Program Change on the given output port and channel, then
    /// records the resulting state as the channel's known program. The
    /// UI always passes the full selection, so `None` means "leave that
    /// part alone" (no CC / no PC sent).
    pub fn send_program_change(
        &self,
        port_index: usize,
        channel: u8,
        program: Option<u8>,
        bank_msb: Option<u8>,
        bank_lsb: Option<u8>,
    ) -> ProgramState {
        let channel = channel & 0x0F;
        let (program, bank_msb, bank_lsb) = (
            program.map(|v| v & 0x7F),
            bank_msb.map(|v| v & 0x7F),
            bank_lsb.map(|v| v & 0x7F),
        );
        self.with_connection(port_index, |conn| {
            let mut ok = true;
            if let Some(msb) = bank_msb {
                ok &= conn.send(&[0xB0 | channel, 0, msb]).is_ok();
            }
            if let Some(lsb) = bank_lsb {
                ok &= conn.send(&[0xB0 | channel, 32, lsb]).is_ok();
            }
            if let Some(p) = program {
                ok &= conn.send(&[0xC0 | channel, p]).is_ok();
            }
            ok
        });
        let updated = ProgramState {
            bank_msb,
            bank_lsb,
            program,
        };
        self.known_programs
            .lock_safe()
            .insert((port_index, channel), updated);
        updated
    }
}

/// Opens the first available MIDI output port eagerly, so the app is
/// usable right away. Other ports are opened lazily by the synths that
/// use them. The virtual port is created eagerly too, so a DAW can see
/// it right from launch. Not a blocking error: the app must remain
/// usable even without a MIDI device connected.
pub fn auto_connect(state: &MidiState) {
    #[cfg(unix)]
    state.with_connection(VIRTUAL_PORT_INDEX, |_| true);
    state.with_connection(0, |_| true);
}

/// Sends a Note On message (0x90 | channel, note, velocity).
pub fn send_note_on(conn: &mut MidiOutputConnection, channel: u8, note: u8, velocity: u8) -> bool {
    let status = 0x90 | (channel & 0x0F);
    // Velocity 0 would be read as a Note Off by the receiver
    conn.send(&[status, note & 0x7F, (velocity & 0x7F).max(1)])
        .is_ok()
}

/// Sends a Note Off message (0x80 | channel, note, velocity=0).
pub fn send_note_off(conn: &mut MidiOutputConnection, channel: u8, note: u8) -> bool {
    let status = 0x80 | (channel & 0x0F);
    conn.send(&[status, note & 0x7F, 0]).is_ok()
}

/// Lists the available MIDI output ports. The index of each entry is the
/// port identifier to pass to `set_synth_midi_port`. On unix the app's
/// own virtual port comes first, so a DAW user finds it without digging
/// through their hardware interfaces.
#[tauri::command]
pub fn list_midi_ports() -> Vec<MidiPortInfo> {
    scan_output_ports().0
}

/// Enumerates the output ports: the list offered to the UI, and the stable
/// OS identifier of every physical port index (for `reconcile_outputs`).
fn scan_output_ports() -> (Vec<MidiPortInfo>, HashMap<usize, String>) {
    let mut ports = Vec::new();
    let mut ids = HashMap::new();

    #[cfg(unix)]
    ports.push(MidiPortInfo {
        index: VIRTUAL_PORT_INDEX,
        name: VIRTUAL_PORT_NAME.to_string(),
        is_virtual: true,
    });

    if let Ok(midi_out) = MidiOutput::new("Wysiwyl") {
        for (index, port) in midi_out.ports().iter().enumerate() {
            ids.insert(index, port.id());
            let name = midi_out
                .port_name(port)
                .unwrap_or_else(|_| format!("Port {index}"));
            // The app's own virtual input port (a destination on macOS and
            // Linux, created for the DAW's MIDI clock) shows up in this
            // list too: connecting a synth to it would only loop our own
            // messages back. Hide it — the labeled virtual port entry
            // above is the real DAW route.
            #[cfg(unix)]
            if name == VIRTUAL_PORT_NAME {
                continue;
            }
            ports.push(MidiPortInfo {
                index,
                name,
                is_virtual: false,
            });
        }
    }
    (ports, ids)
}

/// How long the broadcast port list stays valid before the MIDI devices
/// are enumerated again (hot-plugged devices are picked up within a
/// second, while the 24 pulses-per-beat master clock stays cheap).
const BROADCAST_PORTS_TTL: Duration = Duration::from_secs(1);

/// Sends a system realtime byte (MIDI clock, Start, Stop) to the output
/// ports the synths use, plus the app's virtual port (the DAW route) —
/// used by the metronome in master mode. Ports no synth uses are left
/// alone: opening every device of the system just to clock it could grab
/// interfaces other applications need (exclusive drivers). The port list
/// is cached in `MidiState` for a second; the caller must not hold the
/// synth lock.
pub fn broadcast_realtime(app: &AppHandle, byte: u8) {
    let state = app.state::<MidiState>();
    let ports = {
        let mut cache = state.broadcast_ports.lock_safe();
        let fresh = cache
            .as_ref()
            .is_some_and(|(at, _)| at.elapsed() < BROADCAST_PORTS_TTL);
        if !fresh {
            *cache = Some((Instant::now(), clock_target_ports(app)));
        }
        cache
            .as_ref()
            .map(|(_, ports)| ports.clone())
            .unwrap_or_default()
    };
    for index in ports {
        state.with_connection(index, |conn| conn.send(&[byte]).is_ok());
    }
}

/// Output ports receiving the master clock: those of the synths, plus the
/// virtual port, deduplicated.
fn clock_target_ports(app: &AppHandle) -> Vec<usize> {
    let mut ports: Vec<usize> = app
        .state::<SynthState>()
        .synths
        .lock_safe()
        .values()
        .map(|synth| synth.config.midi_port)
        .collect();
    #[cfg(unix)]
    ports.push(VIRTUAL_PORT_INDEX);
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// Lists the available MIDI input ports, offered as the metronome's clock
/// sync source in `Input` mode. The names match exactly those the input
/// listeners report, so the config-stored source filters the right
/// port. On unix the app's own virtual input port comes last, labeled as
/// the DAW's route; the app's own virtual output port (which also shows
/// up here as a source) is hidden, as in the input listeners.
#[tauri::command]
pub fn list_midi_input_ports() -> Vec<MidiInputPortInfo> {
    let mut ports = Vec::new();
    if let Ok(midi_in) = MidiInput::new("Wysiwyl") {
        for port in midi_in.ports().iter() {
            let name = midi_in.port_name(port).unwrap_or_default();
            #[cfg(unix)]
            if name == VIRTUAL_PORT_NAME {
                continue;
            }
            if name.is_empty() {
                continue;
            }
            ports.push(MidiInputPortInfo {
                name,
                is_virtual: false,
            });
        }
    }
    #[cfg(unix)]
    ports.push(MidiInputPortInfo {
        name: VIRTUAL_PORT_NAME.to_string(),
        is_virtual: true,
    });
    ports
}

// ---------------------------------------------------------------------------
// MIDI input: learning the programs selected on the instruments
// ---------------------------------------------------------------------------
// The MIDI protocol has no way to query a device's current program, so the
// app listens to every input port and tracks Bank Select (CC 0 / CC 32)
// and Program Change messages. The learned state lives per (output port,
// channel); input and output ports being distinct endpoints, they are
// associated by name (exact match first, then "in"/"out" suffix stripping,
// then the single-port fallback).

/// Strips a trailing "in"/"input" or "out"/"output" word from a port name
/// so an input port and its output counterpart normalize to the same key.
fn normalize_port_name(name: &str) -> String {
    let lower = name.to_lowercase();
    for suffix in ["input", "in", "output", "out"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return stripped.trim_end().to_string();
        }
    }
    lower
}

/// Finds the output port index an input port name corresponds to:
/// exact name match, then normalized-name match, then the single-port
/// fallback. None means the event can't be attributed and is dropped.
fn output_port_for_input(input_name: &str) -> Option<usize> {
    let outputs = list_midi_ports();
    if let Some(p) = outputs.iter().find(|p| p.name == input_name) {
        return Some(p.index);
    }
    let want = normalize_port_name(input_name);
    let matches: Vec<usize> = outputs
        .iter()
        .filter(|p| normalize_port_name(&p.name) == want)
        .map(|p| p.index)
        .collect();
    if matches.len() == 1 {
        return Some(matches[0]);
    }
    if outputs.len() == 1 {
        return Some(outputs[0].index);
    }
    None
}

/// Opens every available MIDI input port and keeps it connected for the
/// app's lifetime, tracking Bank Select and Program Change messages into
/// `MidiState::known_programs` and notifying the frontend with
/// `midi-program` events. Not a blocking error: the app works the same
/// without any input device.
pub fn start_midi_input_listeners(app: &AppHandle, state: &MidiState) {
    connect_new_inputs(app, state);
    if state.input_connections.lock_safe().is_empty() {
        println!("No MIDI input port available (or none could be opened).");
    }
}

/// Opens a listener on every input port not listened to yet (identified by
/// its stable OS id), and drops the listeners of the ports that
/// disappeared. Called at startup and by the hot-plug watcher.
fn connect_new_inputs(app: &AppHandle, state: &MidiState) {
    // midir::MidiInput::connect consumes the input, so one instance is
    // created per port to keep listening to all of them simultaneously.
    let ports = match MidiInput::new("Wysiwyl") {
        Ok(midi_in) => midi_in
            .ports()
            .iter()
            .map(|port| {
                let name = midi_in.port_name(port).unwrap_or_default();
                (port.clone(), name)
            })
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    let mut connections = state.input_connections.lock_safe();
    // Drop the listeners of vanished ports (the virtual input, id "", stays)
    connections.retain(|(id, _)| id.is_empty() || ports.iter().any(|(p, _)| &p.id() == id));
    for (port, port_name) in ports {
        let port_id = port.id();
        if connections.iter().any(|(id, _)| id == &port_id) {
            continue;
        }
        // The app's own virtual output port is a source on macOS and Linux:
        // listening to it would only echo our own outgoing messages back.
        // The DAW's clock arrives through the dedicated virtual input
        // listener instead.
        #[cfg(unix)]
        if port_name == VIRTUAL_PORT_NAME {
            continue;
        }
        let Ok(midi_in) = MidiInput::new("Wysiwyl") else {
            continue;
        };
        let listener_app = app.clone();
        let listener_name = port_name.clone();
        let connected = midi_in.connect(
            &port,
            &port_name,
            move |_timestamp, data: &[u8], _: &mut ()| {
                handle_input_message(&listener_app, &listener_name, data);
            },
            (),
        );
        match connected {
            Ok(conn) => {
                println!("Listening to MIDI input: '{port_name}'");
                connections.push((port_id, conn));
            }
            Err(e) => eprintln!("Failed to listen to MIDI input '{port_name}': {e}"),
        }
    }
}

/// Interval of the MIDI hot-plug watcher.
const PORT_WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// Starts the MIDI hot-plug watcher: every `PORT_WATCH_INTERVAL` it
/// enumerates the ports, drops the output connections whose index now
/// designates another device (or none), and listens to newly plugged
/// input ports. Runs for the app's lifetime, outside every app lock
/// except briefly the MIDI ones.
pub fn start_port_watcher(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("wysiwyl-midi-watch".into())
        .spawn(move || {
            let mut last_outputs: Option<HashMap<usize, String>> = None;
            let mut last_inputs: Option<Vec<String>> = None;
            loop {
                std::thread::sleep(PORT_WATCH_INTERVAL);
                let state = app.state::<MidiState>();
                let (_, outputs) = scan_output_ports();
                if last_outputs.as_ref() != Some(&outputs) {
                    if last_outputs.is_some() {
                        state.reconcile_outputs(&outputs);
                        *state.broadcast_ports.lock_safe() = None;
                    }
                    last_outputs = Some(outputs);
                }
                let inputs: Vec<String> = MidiInput::new("Wysiwyl")
                    .map(|m| m.ports().iter().map(|p| p.id()).collect())
                    .unwrap_or_default();
                if last_inputs.as_ref() != Some(&inputs) {
                    if last_inputs.is_some() {
                        connect_new_inputs(&app, &state);
                    }
                    last_inputs = Some(inputs);
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("Failed to start the MIDI port watcher: {e}");
    }
}

/// Creates the app's own virtual MIDI input port, so a DAW can send its
/// MIDI clock (and program changes) straight to Wysiwyl. The port is kept
/// alive for the app's lifetime like the physical input listeners. Unix
/// only: midir's Windows backend has no virtual ports (a loopMIDI bus
/// serves the same purpose there).
#[cfg(unix)]
pub fn start_virtual_input_listener(app: &AppHandle) {
    let Ok(midi_in) = MidiInput::new("Wysiwyl") else {
        return;
    };
    let listener_app = app.clone();
    match midi_in.create_virtual(
        VIRTUAL_PORT_NAME,
        move |_timestamp, data: &[u8], _: &mut ()| {
            handle_input_message(&listener_app, VIRTUAL_PORT_NAME, data);
        },
        (),
    ) {
        Ok(conn) => {
            app.state::<MidiState>()
                .input_connections
                .lock_safe()
                .push((String::new(), conn));
            println!("Virtual MIDI input port '{VIRTUAL_PORT_NAME}' created (DAW sync)");
        }
        Err(e) => eprintln!("Failed to create the virtual MIDI input port: {e}"),
    }
}

/// Parses one incoming MIDI message, updating the known-program state and
/// emitting a `midi-program` event when it is a Bank Select or Program
/// Change, or the matching synths' volume and a `midi-volume` event when
/// it is a Channel Volume (CC 7). Our own outgoing messages may loop back
/// here (IAC/thru): updating with the same value is harmless, and nothing
/// is ever sent back in response. Single-byte system realtime messages
/// (a DAW's MIDI clock) are dispatched to the metronome's clock sync.
fn handle_input_message(app: &AppHandle, input_name: &str, data: &[u8]) {
    for message in split_midi_messages(data) {
        handle_one_message(app, input_name, &message);
    }
}

/// Splits a buffer delivered by the OS into individual MIDI messages: a
/// single callback may carry several (CoreMIDI packets, e.g. Bank Select
/// MSB + LSB + Program Change at once), with running status, and realtime
/// bytes (0xF8...) may be interleaved anywhere, even inside another
/// message (they are emitted on their own, before the message they
/// interrupt completes). SysEx and orphan data bytes are skipped.
fn split_midi_messages(data: &[u8]) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    // Message being assembled, and the running status
    let mut current: Vec<u8> = Vec::new();
    let mut running: Option<u8> = None;
    let mut in_sysex = false;
    for &byte in data {
        if byte >= 0xF8 {
            // Realtime: single byte, never interrupts running status
            out.push(vec![byte]);
            continue;
        }
        if in_sysex {
            // SysEx payload is skipped; End Of Exclusive (0xF7) closes it,
            // and any other status byte ends a truncated SysEx (handled
            // below as a regular status byte)
            if byte & 0x80 == 0 {
                continue;
            }
            in_sysex = false;
            if byte == 0xF7 {
                continue;
            }
        }
        if byte & 0x80 != 0 {
            current.clear();
            match byte {
                0xF0 => {
                    in_sysex = true;
                    running = None;
                    continue;
                }
                0xF7 => continue,
                0xF1..=0xF6 => running = None,
                _ => running = Some(byte),
            }
            current.push(byte);
        } else {
            if current.is_empty() {
                match running {
                    Some(status) => current.push(status),
                    None => continue, // orphan data byte
                }
            }
            current.push(byte);
        }
        if current.len() == midi_message_len(current[0]) {
            out.push(std::mem::take(&mut current));
        }
    }
    out
}

/// Total length (status included) of a MIDI message from its status byte.
fn midi_message_len(status: u8) -> usize {
    match status & 0xF0 {
        0x80 | 0x90 | 0xA0 | 0xB0 | 0xE0 => 3,
        0xC0 | 0xD0 => 2,
        _ => match status {
            0xF2 => 3,        // Song Position Pointer
            0xF1 | 0xF3 => 2, // MTC quarter frame, Song Select
            _ => 1,
        },
    }
}

/// Handles one complete MIDI message (see `handle_input_message`).
fn handle_one_message(app: &AppHandle, input_name: &str, data: &[u8]) {
    // System realtime messages (single byte): MIDI clock from a DAW or
    // any external device drives the metronome's tempo. A Stop message
    // (0xFC) is honored too, for an immediate fallback to the internal
    // tempo instead of the pulse timeout. The clock mode decides which
    // input is accepted (see `MetronomeState::clock_accepts`).
    if data.len() == 1 {
        let metronome = app.state::<MetronomeState>();
        match data[0] {
            MIDI_CLOCK => metronome::on_clock_pulse(&metronome, input_name),
            MIDI_START => metronome::on_clock_start(&metronome, input_name),
            MIDI_CONTINUE => metronome::on_clock_continue(&metronome, input_name),
            MIDI_STOP => metronome::on_clock_stop(&metronome, input_name),
            _ => {}
        }
        return;
    }

    // Song Position Pointer: the position the next Continue resumes from
    if data.len() == 3 && data[0] == MIDI_SONG_POSITION {
        let sixteenths = (data[1] as u16 & 0x7F) | ((data[2] as u16 & 0x7F) << 7);
        let metronome = app.state::<MetronomeState>();
        metronome::on_song_position(&metronome, input_name, sixteenths);
        return;
    }

    if data.len() < 2 {
        return;
    }
    let status = data[0];
    let channel = status & 0x0F;
    let channel_message = match status & 0xF0 {
        // Program Change: [0xC0|ch, program]
        0xC0 => Message::Program(data[1] & 0x7F),
        // Control Change: [0xB0|ch, cc, value] — banks and volume tracked
        0xB0 if data.len() >= 3 => match data[1] {
            0 | 32 => Message::Bank(data[1], data[2] & 0x7F),
            7 => Message::Volume(data[2] & 0x7F),
            _ => return,
        },
        _ => return,
    };
    let Some(port) = output_port_for_input(input_name) else {
        eprintln!(
            "MIDI in '{input_name}': program/bank/volume message on channel {} \
             dropped (no matching output port)",
            channel + 1
        );
        return;
    };

    // Channel Volume learned from the instrument: update every synth on
    // this (port, channel) — CC 7 addresses the channel — without
    // sending anything back (our own CC 7 could loop back here).
    if let Message::Volume(value) = channel_message {
        let synth_state = app.state::<SynthState>();
        synth_state
            .synths
            .lock_safe()
            .values_mut()
            .filter(|synth| synth.config.midi_port == port && synth.config.channel == channel)
            .for_each(|synth| synth.config.volume = value);
        let _ = app.emit(
            "midi-volume",
            VolumeEvent {
                port,
                channel,
                volume: value,
            },
        );
        return;
    }

    let midi_state = app.state::<MidiState>();
    let updated = {
        let mut known = midi_state.known_programs.lock_safe();
        let entry = known.entry((port, channel)).or_default();
        match channel_message {
            Message::Program(p) => entry.program = Some(p),
            Message::Bank(0, value) => entry.bank_msb = Some(value),
            Message::Bank(_, value) => entry.bank_lsb = Some(value),
            // Handled (and returned) before reaching the program tracking
            Message::Volume(_) => return,
        }
        *entry
    };
    let _ = app.emit(
        "midi-program",
        ProgramEvent {
            port,
            channel,
            program: updated,
        },
    );
}

enum Message {
    Program(u8),
    Bank(u8, u8),
    Volume(u8),
}

/// Payload of the `midi-volume` event: the learned channel volume
/// (raw MIDI value, 0–127) of one (output port, channel) pair.
#[derive(Serialize, Clone)]
pub struct VolumeEvent {
    pub port: usize,
    pub channel: u8,
    pub volume: u8,
}

/// Payload of the `midi-program` event: the learned program of one
/// (output port, channel) pair.
#[derive(Serialize, Clone)]
pub struct ProgramEvent {
    pub port: usize,
    pub channel: u8,
    pub program: ProgramState,
}

/// One entry of the known-programs map, flattened for the frontend.
#[derive(Serialize, Clone)]
pub struct KnownProgram {
    pub port: usize,
    pub channel: u8,
    pub program: ProgramState,
}

/// Returns every program learned so far, for the frontend to hydrate its
/// display at startup (events emitted before the UI is ready would
/// otherwise be missed).
#[tauri::command]
pub fn get_known_programs(state: State<'_, MidiState>) -> Vec<KnownProgram> {
    state
        .known_programs
        .lock_safe()
        .iter()
        .map(|(&(port, channel), &program)| KnownProgram {
            port,
            channel,
            program,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_buffer_carrying_several_messages_is_split() {
        // Bank Select MSB + LSB + Program Change in one CoreMIDI packet
        let data = [0xB2, 0, 1, 0xB2, 32, 5, 0xC2, 41];
        assert_eq!(
            split_midi_messages(&data),
            vec![vec![0xB2, 0, 1], vec![0xB2, 32, 5], vec![0xC2, 41]]
        );
    }

    #[test]
    fn running_status_is_honored() {
        // CC 0 then CC 32 sharing one status byte, then a Program Change
        let data = [0xB0, 0, 1, 32, 2, 0xC0, 7];
        assert_eq!(
            split_midi_messages(&data),
            vec![vec![0xB0, 0, 1], vec![0xB0, 32, 2], vec![0xC0, 7]]
        );
    }

    #[test]
    fn realtime_bytes_are_extracted_even_inside_a_message() {
        // A clock pulse interleaved inside a Control Change
        let data = [0xB0, 7, MIDI_CLOCK, 100, MIDI_START];
        assert_eq!(
            split_midi_messages(&data),
            vec![vec![MIDI_CLOCK], vec![0xB0, 7, 100], vec![MIDI_START]]
        );
    }

    #[test]
    fn sysex_song_position_and_orphan_bytes() {
        // SysEx skipped, then a Song Position Pointer (3 bytes)
        let data = [0xF0, 0x7E, 0x01, 0xF7, MIDI_SONG_POSITION, 0x10, 0x00];
        assert_eq!(
            split_midi_messages(&data),
            vec![vec![MIDI_SONG_POSITION, 0x10, 0x00]]
        );
        // Data bytes without any status are dropped, a truncated message
        // is never emitted
        assert!(split_midi_messages(&[0x10, 0x20]).is_empty());
        assert!(split_midi_messages(&[0xB0, 7]).is_empty());
        // A system common message cancels the running status
        assert_eq!(
            split_midi_messages(&[0xC0, 1, 0xF6, 2]),
            vec![vec![0xC0, 1], vec![0xF6]]
        );
    }

    #[test]
    fn port_names_normalize_across_in_and_out() {
        assert_eq!(normalize_port_name("Digitakt In"), "digitakt");
        assert_eq!(normalize_port_name("Digitakt Out"), "digitakt");
        assert_eq!(normalize_port_name("MIDI Output"), "midi");
        assert_eq!(normalize_port_name("Synth"), "synth");
    }
}

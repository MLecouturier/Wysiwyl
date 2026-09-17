use midir::{MidiInput, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Opens the connection to the given output port index, or None if the
/// port doesn't exist or can't be opened. On unix, the virtual port
/// sentinel is created on demand instead of connected.
#[cfg(unix)]
fn open_connection(port_index: usize) -> Option<MidiOutputConnection> {
    if port_index == VIRTUAL_PORT_INDEX {
        return create_virtual_connection();
    }
    open_physical_connection(port_index)
}

/// Opens the connection to the given output port index, or None if the
/// port doesn't exist or can't be opened.
#[cfg(not(unix))]
fn open_connection(port_index: usize) -> Option<MidiOutputConnection> {
    open_physical_connection(port_index)
}

/// Opens the connection to the given physical output port index, or None
/// if the port doesn't exist or can't be opened.
fn open_physical_connection(port_index: usize) -> Option<MidiOutputConnection> {
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

    match midi_out.connect(port, "wysiwyl-out") {
        Ok(conn) => {
            println!("Connected to MIDI port {port_index}: {port_name}");
            Some(conn)
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

impl MidiState {
    /// Runs `f` with the open connection for the given port, opening it
    /// lazily on first use. Notes are silently dropped if the port is
    /// unavailable.
    fn with_connection(&self, port_index: usize, f: impl FnOnce(&mut MidiOutputConnection)) {
        let mut connections = self.connections.lock().unwrap();
        if !connections.contains_key(&port_index) {
            match open_connection(port_index) {
                Some(conn) => {
                    connections.insert(port_index, conn);
                }
                None => return,
            }
        }
        if let Some(conn) = connections.get_mut(&port_index) {
            f(conn);
        }
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
    /// channel. `volume_percent` (0–100) is mapped onto the MIDI value range
    /// 0–127, with 100 % sent as the full value 127.
    pub fn send_channel_volume(&self, port_index: usize, channel: u8, volume_percent: u8) {
        let value = percent_to_midi(volume_percent);
        self.with_connection(port_index, |conn| {
            let _ = conn.send(&[0xB0 | (channel & 0x0F), 7, value & 0x7F]);
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
        self.with_connection(port_index, |conn| {
            if let Some(msb) = bank_msb {
                let _ = conn.send(&[0xB0 | (channel & 0x0F), 0, msb & 0x7F]);
            }
            if let Some(lsb) = bank_lsb {
                let _ = conn.send(&[0xB0 | (channel & 0x0F), 32, lsb & 0x7F]);
            }
            if let Some(p) = program {
                let _ = conn.send(&[0xC0 | (channel & 0x0F), p & 0x7F]);
            }
        });
        let updated = ProgramState {
            bank_msb,
            bank_lsb,
            program,
        };
        self.known_programs
            .lock()
            .unwrap()
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
    state.with_connection(VIRTUAL_PORT_INDEX, |_| {});
    state.with_connection(0, |_| {});
}

/// Sends a Note On message (0x90 | channel, note, velocity).
pub fn send_note_on(conn: &mut MidiOutputConnection, channel: u8, note: u8, velocity: u8) {
    let status = 0x90 | (channel & 0x0F);
    let _ = conn.send(&[status, note & 0x7F, velocity & 0x7F]);
}

/// Sends a Note Off message (0x80 | channel, note, velocity=0).
pub fn send_note_off(conn: &mut MidiOutputConnection, channel: u8, note: u8) {
    let status = 0x80 | (channel & 0x0F);
    let _ = conn.send(&[status, note & 0x7F, 0]);
}

/// Converts a channel volume percentage (0–100) to a MIDI CC value
/// (0–127). Rounded, so a value echoed back by the instrument converts
/// to the same percentage.
fn percent_to_midi(percent: u8) -> u8 {
    ((percent.min(100) as u16 * 127 + 50) / 100) as u8
}

/// Converts a MIDI CC value (0–127) to a channel volume percentage
/// (0–100). Inverse of `percent_to_midi`.
fn midi_to_percent(value: u8) -> u8 {
    ((value.min(127) as u16 * 100 + 63) / 127) as u8
}

/// Lists the available MIDI output ports. The index of each entry is the
/// port identifier to pass to `set_synth_midi_port`. On unix the app's
/// own virtual port comes first, so a DAW user finds it without digging
/// through their hardware interfaces.
#[tauri::command]
pub fn list_midi_ports() -> Vec<MidiPortInfo> {
    let mut ports = Vec::new();

    #[cfg(unix)]
    ports.push(MidiPortInfo {
        index: VIRTUAL_PORT_INDEX,
        name: VIRTUAL_PORT_NAME.to_string(),
        is_virtual: true,
    });

    if let Ok(midi_out) = MidiOutput::new("Wysiwyl") {
        for (index, port) in midi_out.ports().iter().enumerate() {
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
    ports
}

#[tauri::command]
pub fn is_midi_connected(state: State<'_, MidiState>) -> bool {
    !state.connections.lock().unwrap().is_empty()
}

/// How long the broadcast port list stays valid before the MIDI devices
/// are enumerated again (hot-plugged devices are picked up within a
/// second, while the 24 pulses-per-beat master clock stays cheap).
const BROADCAST_PORTS_TTL: Duration = Duration::from_secs(1);

/// Sends a system realtime byte (MIDI clock, Start, Stop) to every
/// output port, opening the connections lazily — used by the metronome
/// in master mode. The port list is cached in `MidiState` for a second:
/// enumerating the OS's MIDI devices on every pulse would be far too
/// expensive.
pub fn broadcast_realtime(state: &MidiState, byte: u8) {
    let ports = {
        let mut cache = state.broadcast_ports.lock().unwrap();
        let fresh = cache
            .as_ref()
            .is_some_and(|(at, _)| at.elapsed() < BROADCAST_PORTS_TTL);
        if !fresh {
            let ports = list_midi_ports()
                .into_iter()
                .map(|port| port.index)
                .collect::<Vec<_>>();
            *cache = Some((Instant::now(), ports));
        }
        cache.as_ref().expect("just refreshed").1.clone()
    };
    for index in ports {
        state.with_connection(index, |conn| {
            let _ = conn.send(&[byte]);
        });
    }
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
    let mut connections = state.input_connections.lock().unwrap();
    for (port, port_name) in ports {
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
                connections.push(conn);
            }
            Err(e) => eprintln!("Failed to listen to MIDI input '{port_name}': {e}"),
        }
    }
    if connections.is_empty() {
        println!("No MIDI input port available (or none could be opened).");
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
                .lock()
                .unwrap()
                .push(conn);
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
    // System realtime messages (single byte): MIDI clock from a DAW or
    // any external device drives the metronome's tempo. A Stop message
    // (0xFC) is honored too, for an immediate fallback to the internal
    // tempo instead of the pulse timeout. The clock mode decides which
    // input is accepted (see `MetronomeState::clock_accepts`).
    if data.len() == 1 {
        let metronome = app.state::<MetronomeState>();
        match data[0] {
            MIDI_CLOCK => metronome::on_clock_pulse(&metronome, input_name),
            MIDI_START | MIDI_CONTINUE => metronome::on_clock_start(&metronome, input_name),
            MIDI_STOP => metronome::on_clock_stop(&metronome, input_name),
            _ => {}
        }
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
        let percent = midi_to_percent(value);
        let synth_state = app.state::<SynthState>();
        synth_state
            .synths
            .lock()
            .unwrap()
            .values_mut()
            .filter(|synth| synth.midi_port == port && synth.channel == channel)
            .for_each(|synth| synth.volume = percent);
        let _ = app.emit(
            "midi-volume",
            VolumeEvent {
                port,
                channel,
                volume: percent,
            },
        );
        return;
    }

    let midi_state = app.state::<MidiState>();
    let updated = {
        let mut known = midi_state.known_programs.lock().unwrap();
        let entry = known.entry((port, channel)).or_default();
        match channel_message {
            Message::Program(p) => entry.program = Some(p),
            Message::Bank(cc, value) if cc == 0 => entry.bank_msb = Some(value),
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
/// (percent, 0–100) of one (output port, channel) pair.
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
        .lock()
        .unwrap()
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
    fn volume_conversions_hit_their_bounds() {
        assert_eq!(percent_to_midi(0), 0);
        assert_eq!(percent_to_midi(50), 64);
        assert_eq!(percent_to_midi(100), 127);
        // Out-of-range percentages are clamped
        assert_eq!(percent_to_midi(200), 127);
        assert_eq!(midi_to_percent(0), 0);
        assert_eq!(midi_to_percent(64), 50);
        assert_eq!(midi_to_percent(127), 100);
        assert_eq!(midi_to_percent(255), 100);
    }

    #[test]
    fn volume_round_trip_is_stable() {
        // A CC value echoed back by the instrument (IAC/thru loop) must
        // convert to the percentage that produced it, so the UI field
        // never flickers to a neighboring value.
        for percent in 0..=100u8 {
            let midi = percent_to_midi(percent);
            assert_eq!(midi_to_percent(midi), percent, "percent {percent}");
        }
    }
}

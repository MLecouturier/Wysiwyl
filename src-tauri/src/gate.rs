//! Delayed pizzicato Note Off scheduler.
//!
//! In the pizzicato articulation (`note_sustain = false`) the historical
//! behavior is to send the Note Off in the same packet as the Note On, so
//! the note has a zero-length gate and only instruments whose release sounds
//! on its own produce an audible result. When a minimum gate is configured
//! (`pizzicato_gate_ms > 0`), the Note Off is instead deferred by that much
//! so software synths whose envelope needs time to rise produce a real pluck.
//!
//! A single long-lived thread owns the deadlines: scheduling only sends a
//! message on a channel (never spawns a thread, never blocks the metronome).
//! A scheduled Note Off is cancelled when the synth's `note_generation` has
//! moved on, i.e. a newer articulation superseded it.

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use tauri::{AppHandle, Manager};

use crate::state::{MidiState, SynthState};

/// A Note Off to send once `deadline` passes, unless a newer articulation
/// (a bumped `note_generation`) supersedes it. `mono` is the monophonic
/// note to release, `poly` the (voice index, note) pairs of the sounding
/// polyphonic voices.
pub struct GateOff {
    pub synth_id: u32,
    pub generation: u32,
    pub port: usize,
    pub channel: u8,
    pub mono: Option<u8>,
    pub poly: Vec<(usize, u8)>,
    pub deadline: Instant,
}

/// Managed state holding the sender of the gate scheduler.
pub struct GateState {
    tx: Sender<GateOff>,
}

impl GateState {
    /// Starts the scheduler thread and returns the managed state. The thread
    /// runs for the app's lifetime and blocks on the channel while idle.
    pub fn start(app: AppHandle) -> Self {
        let (tx, rx) = crossbeam_channel::unbounded();
        std::thread::spawn(move || run(app, rx));
        Self { tx }
    }

    /// Queues a Note Off for the scheduler. Never blocks.
    pub fn schedule(&self, off: GateOff) {
        let _ = self.tx.send(off);
    }
}

/// Smallest wait between two scheduler wakeups, so a deadline that is already
/// due cannot spin the loop.
const MIN_WAIT: Duration = Duration::from_millis(1);

fn run(app: AppHandle, rx: Receiver<GateOff>) {
    let mut pending: Vec<GateOff> = Vec::new();
    loop {
        // Fire every gate whose deadline has passed.
        let now = Instant::now();
        let mut i = 0;
        while i < pending.len() {
            if pending[i].deadline <= now {
                fire(&app, pending.swap_remove(i));
            } else {
                i += 1;
            }
        }

        // Wait until the earliest deadline, or a new gate, whichever comes
        // first. No pending gate: block until one arrives.
        let timeout = pending
            .iter()
            .map(|g| g.deadline.saturating_duration_since(Instant::now()))
            .min()
            .map(|t| t.max(MIN_WAIT));
        match timeout {
            Some(t) => match rx.recv_timeout(t) {
                Ok(off) => pending.push(off),
                Err(RecvTimeoutError::Timeout) => {}
                // The state was dropped (app shutting down): stop the thread
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(off) => pending.push(off),
                Err(_) => return,
            },
        }
    }
}

/// Sends the captured Note Offs if the synth still articulates the same
/// generation (no newer note superseded it), then clears their flags. The
/// port and channel captured at scheduling time are used, so a port change
/// in the meantime still releases the notes where they were sent.
fn fire(app: &AppHandle, off: GateOff) {
    let synth_state = app.state::<SynthState>();
    let midi_state = app.state::<MidiState>();

    let mut synths = synth_state.synths.lock().unwrap();
    let Some(synth) = synths.get_mut(&off.synth_id) else {
        return;
    };
    if synth.playback.note_generation != off.generation {
        return;
    }

    if let Some(note) = off.mono {
        if synth.playback.note_is_on && synth.playback.note == note {
            midi_state.note_off(off.port, off.channel, note);
            synth.playback.note_is_on = false;
        }
    }
    for (index, note) in off.poly {
        let voice = &mut synth.playback.poly_voices[index];
        if voice.note_is_on && voice.note == note {
            midi_state.note_off(off.port, off.channel, note);
            voice.note_is_on = false;
        }
    }
}

//! Deferred Note Off scheduler.
//!
//! Two features release notes after a delay:
//! - the pizzicato minimum gate: in the pizzicato articulation
//!   (`note_sustain = false`) with `pizzicato_gate_ms > 0`, the Note Off is
//!   deferred by that much so software synths whose envelope needs time to
//!   rise produce a real pluck (0 keeps the historical immediate Note Off);
//! - the manual step: a note played by the step button while the synth is
//!   paused rings for its step duration, then is released.
//!
//! A single long-lived thread owns the deadlines: scheduling only sends a
//! message on a channel (never spawns a thread, never blocks the metronome).
//! A scheduled Note Off is cancelled when the synth's `note_generation` has
//! moved on, i.e. a newer articulation (or a release) superseded it. Synths
//! are targeted by their stable `uid`, so a renumbering in the meantime
//! cannot redirect a Note Off to another synth.

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use tauri::{AppHandle, Manager};

use crate::locks::MutexExt;
use crate::state::{MidiState, SynthState};

/// A Note Off to send once `deadline` passes, unless a newer articulation
/// (a bumped `note_generation`) supersedes it. `mono` is the monophonic
/// note to release, `poly` the notes of the sounding polyphonic voices
/// (each sounding pitch is owned by exactly one voice).
pub struct GateOff {
    pub synth_uid: u64,
    pub generation: u32,
    pub port: usize,
    pub channel: u8,
    pub mono: Option<u8>,
    pub poly: Vec<u8>,
    pub deadline: Instant,
    /// Manual-step cutoffs only apply while the synth is still paused: once
    /// the metronome drives it again, the playback owns its notes.
    pub skip_if_playing: bool,
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
        std::thread::Builder::new()
            .name("wysiwyl-gate".into())
            .spawn(move || run(app, rx))
            .expect("failed to spawn the gate scheduler thread");
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
/// port and channel captured at scheduling time are used, so a routing
/// change in the meantime still releases the notes where they were sent
/// (a routing change releases the notes itself and bumps the generation,
/// so this is only a safety net).
fn fire(app: &AppHandle, off: GateOff) {
    let synth_state = app.state::<SynthState>();
    let midi_state = app.state::<MidiState>();

    let mut synths = synth_state.synths.lock_safe();
    let Some(synth) = synths.values_mut().find(|s| s.uid == off.synth_uid) else {
        return;
    };
    if synth.playback.note_generation != off.generation
        || (off.skip_if_playing && synth.playback.playing)
    {
        return;
    }

    if let Some(note) = off.mono {
        if synth.playback.note_is_on && synth.playback.note == note {
            midi_state.note_off(off.port, off.channel, note);
            synth.playback.note_is_on = false;
        }
    }
    for note in off.poly {
        if let Some(voice) = synth
            .playback
            .poly_voices
            .iter_mut()
            .find(|v| v.note_is_on && v.note == note)
        {
            midi_state.note_off(off.port, off.channel, note);
            voice.note_is_on = false;
        }
    }
}

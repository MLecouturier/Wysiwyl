use crate::config::ConfigState;
use crate::error::{err, AppError};
use crate::locks::MutexExt;
use crate::metronome::remapped_cursor;
use crate::midi::VolumeEvent;
use crate::state::{
    normalize_note_lengths, normalize_tempo_ratio, ImageState, MidiState, NoteLength, ProgramState,
    ReadingDirection, Scale, Synth, SynthMode, SynthState, SynthView, Zone,
};
use crate::zone::normalize_zones;
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, State};

// --- Existing SynthConfig / SynthEngine (pure pixel-processing logic) ---
// (unchanged, assumed to remain above or below in this file)

/// Builds the standard "synth not found" error, with the id as a parameter.
fn synth_not_found(id: u32) -> AppError {
    err("synth_not_found").with_param("id", id)
}

/// Sets a custom display name for a synthesizer. An empty (or
/// whitespace-only) name clears it, falling back to the default name.
#[tauri::command]
pub fn set_synth_name(id: u32, name: String, state: State<SynthState>) -> Result<(), AppError> {
    let trimmed = name.trim().to_string();
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.name = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Creates a synthesizer from the default-synth template of the global
/// configuration, and returns its full initial state so the frontend can
/// reflect it.
#[tauri::command]
pub fn add_synth(
    config_state: State<ConfigState>,
    state: State<SynthState>,
) -> Result<SynthView, AppError> {
    let template = config_state.config.lock_safe().default_synth.clone();

    let mut next_id = state.next_id.lock_safe();
    let id = *next_id;
    *next_id = next_id.wrapping_add(1).max(1);
    drop(next_id);

    // The display number comes from its own counter (see
    // `Synth::display_number`): it survives renumbering and is never
    // reused after a removal
    let display_number = {
        let mut next = state.next_display_number.lock_safe();
        let n = *next;
        *next = next.wrapping_add(1).max(1);
        n
    };

    let mut synth = template.to_synth(id);
    synth.display_number = display_number;
    state.synths.lock_safe().insert(id, synth.clone());

    Ok(SynthView::from(&synth))
}

/// Copies `from`'s configuration onto `to`, keeping `to`'s MIDI routing
/// (`midi_port` and `channel`): the target keeps driving the same instrument
/// on the same channel, only its sound/behaviour parameters are replaced.
/// The cached pixel sequence is dropped (the reading direction and the
/// sorted-reading flag are part of the configuration). Pure over the synth
/// map, so it is unit-tested without the Tauri state.
pub fn copy_config_between(
    synths: &mut HashMap<u32, Synth>,
    from: u32,
    to: u32,
) -> Result<(), AppError> {
    let mut config = synths
        .get(&from)
        .ok_or_else(|| synth_not_found(from))?
        .config
        .clone();
    let target = synths.get_mut(&to).ok_or_else(|| synth_not_found(to))?;
    config.midi_port = target.config.midi_port;
    config.channel = target.config.channel;
    target.config = config;
    target.invalidate_sequence();
    Ok(())
}

/// Copies another synthesizer's parameters onto this one (the "Copy
/// parameters from…" menu action). The target's MIDI port and channel are
/// preserved; everything else (mode, ranges, note lengths,
/// loop, direction, scale, volume, quantize…) is taken from the source.
/// Returns the updated view so the UI can reflect it.
#[tauri::command]
pub fn copy_synth_params(
    from_id: u32,
    to_id: u32,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<SynthView, AppError> {
    let mut synths = state.synths.lock_safe();
    // The mode, articulation or enabled voices may change under the
    // target's sounding notes: release them first (the next step
    // re-articulates with the new parameters)
    synths
        .get_mut(&to_id)
        .ok_or_else(|| synth_not_found(to_id))?
        .release_notes(&midi_state);
    copy_config_between(&mut synths, from_id, to_id)?;
    let target = synths.get(&to_id).ok_or_else(|| synth_not_found(to_id))?;
    Ok(SynthView::from(target))
}

/// Removes a synthesizer, first releasing every note it is sounding (and
/// cancelling its deferred Note Offs), so a removal never leaves a stuck
/// note — whatever the caller did before.
#[tauri::command]
pub fn remove_synth(id: u32, state: State<SynthState>, midi_state: State<MidiState>) {
    if let Some(mut synth) = state.synths.lock_safe().remove(&id) {
        synth.stop_playback(&midi_state);
    }
}

/// Reassigns the synthesizers' ids 1..N following the given display order
/// (the complete list of the current ids, top to bottom of the stack), so a
/// synth's id always matches its position: external MIDI controllers will
/// address the synths by this number. `next_id` is reset to N+1 so the next
/// created synth continues the sequence.
pub fn renumber_synths(
    synths: &mut HashMap<u32, Synth>,
    next_id: &mut u32,
    order: &[u32],
) -> Result<(), AppError> {
    let count = synths.len();
    if order.len() != count
        || order.iter().collect::<HashSet<_>>().len() != count
        || order.iter().any(|id| !synths.contains_key(id))
    {
        return Err(err("synth_order_mismatch"));
    }

    let mut ordered = Vec::with_capacity(count);
    for id in order {
        ordered.push(synths.remove(id).unwrap());
    }
    for (index, mut synth) in ordered.into_iter().enumerate() {
        synth.id = index as u32 + 1;
        synths.insert(synth.id, synth);
    }
    *next_id = count as u32 + 1;
    Ok(())
}

/// Applies the display order given by the frontend (the ids of the synth
/// cards, top to bottom) and renumbers the ids 1..N accordingly. Called
/// after every change in the stack's composition or order.
#[tauri::command]
pub fn set_synth_order(order: Vec<u32>, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    let mut next_id = state.next_id.lock_safe();
    renumber_synths(&mut synths, &mut next_id, &order)
}

#[tauri::command]
pub fn reset_synth_cursor(id: u32, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playback.cursor = 0;
            synth.playback.end_pending = false;
            synth.playback.tempo_accumulator = 0.0;
            synth.playback.wakes_since_step = 0;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn start_synth(
    id: u32,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playback.playing = true;
            // The first note waits for the next master beat so playback
            // starts in phase with the metronome (see the metronome thread)
            synth.playback.start_pending = true;
            synth.playback.wakes_since_step = 0;
            // A fresh start always replays from the beginning of the sequence
            // (e.g. after manually stepping to the end while paused)
            synth.playback.end_pending = false;
            // Reassert the channel volume so the instrument matches the
            // synth's setting even if it was reconnected or reset meanwhile
            midi_state.send_channel_volume(
                synth.config.midi_port,
                synth.config.channel,
                synth.config.volume,
            );
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn stop_synth(
    id: u32,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    let synth = synths.get_mut(&id).ok_or_else(|| synth_not_found(id))?;
    synth.stop_playback(&midi_state);
    Ok(())
}

/// Kill switch: stops every synthesizer and immediately turns off all
/// sounding notes (mono + polyphonic voices), then sends All Sound Off
/// (CC 120) and All Notes Off (CC 123) on every channel of every output
/// port in use — so even a note the app lost track of (a device
/// reconnected, an earlier failed send) is silenced. The note generation
/// is bumped so pending delayed Note Offs cancel themselves.
#[tauri::command]
pub fn panic_all(state: State<SynthState>, midi_state: State<MidiState>) {
    let mut ports: Vec<usize> = Vec::new();
    {
        let mut synths = state.synths.lock_safe();
        for synth in synths.values_mut() {
            synth.stop_playback(&midi_state);
            if !ports.contains(&synth.config.midi_port) {
                ports.push(synth.config.midi_port);
            }
        }
    }
    // Outside the synth lock: 32 messages per port
    for port in ports {
        midi_state.all_notes_off(port);
    }
}

#[tauri::command]
pub fn is_synth_playing(id: u32, state: State<SynthState>) -> bool {
    state
        .synths
        .lock_safe()
        .get(&id)
        .map(|s| s.playback.playing)
        .unwrap_or(false)
}

/// Sets the synth's MIDI channel (0-15). The notes sounding on the old
/// channel are released first: once the channel changed, nothing would
/// ever turn them off.
#[tauri::command]
pub fn set_synth_channel(
    id: u32,
    channel: u8,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let clamped = channel.min(15);
    let mut synths = state.synths.lock_safe();
    let synth = synths.get_mut(&id).ok_or_else(|| synth_not_found(id))?;
    if synth.config.channel != clamped {
        synth.release_notes(&midi_state);
        synth.config.channel = clamped;
    }
    Ok(())
}

/// Sets the MIDI output port a synthesizer sends its notes to (see
/// `list_midi_ports`). The connection is opened lazily on first use.
#[tauri::command]
pub fn set_synth_midi_port(
    id: u32,
    port: usize,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    let synth = synths.get_mut(&id).ok_or_else(|| synth_not_found(id))?;
    if synth.config.midi_port != port {
        // Turn off any sounding note on the old port first, to avoid a
        // stuck note on the device it is connected to.
        synth.release_notes(&midi_state);
        synth.config.midi_port = port;
    }
    Ok(())
}

/// Sends the bank (letters A–P in the UI) and program selection of the
/// synth on its output port and channel, records it as the channel's
/// known program, and returns the resulting state for the frontend.
/// Every part is optional: the UI sends the full selection, `None` leaves
/// that part untouched on the instrument.
#[tauri::command]
pub fn set_synth_program(
    id: u32,
    program: Option<u8>,
    bank_msb: Option<u8>,
    bank_lsb: Option<u8>,
    midi: State<MidiState>,
    state: State<SynthState>,
) -> Result<ProgramState, AppError> {
    let (port, channel) = {
        let synths = state.synths.lock_safe();
        let synth = synths.get(&id).ok_or_else(|| synth_not_found(id))?;
        (synth.config.midi_port, synth.config.channel)
    };
    Ok(midi.send_program_change(port, channel, program, bank_msb, bank_lsb))
}

/// Sets the synth's channel volume as a raw MIDI value (0–127) and
/// immediately sends it as MIDI CC 7 on its output port and channel.
/// Caveat: CC 7 addresses the channel, so synths sharing the same
/// (port, channel) override each other — the last setting sent wins.
/// Because they share the physical channel volume, every synth on that
/// (port, channel) adopts the new value, and a `midi-volume` event lets
/// the frontend mirror it on all of them.
#[tauri::command]
pub fn set_synth_volume(
    id: u32,
    volume: u8,
    app: AppHandle,
    state: State<SynthState>,
    midi: State<MidiState>,
) -> Result<(), AppError> {
    let volume = volume.min(127);
    let (port, channel) = {
        let mut synths = state.synths.lock_safe();
        let (port, channel) = match synths.get(&id) {
            Some(synth) => (synth.config.midi_port, synth.config.channel),
            None => return Err(synth_not_found(id)),
        };
        // CC 7 addresses the (port, channel): every synth on that pair
        // shares the same channel volume, so update them all.
        for synth in synths.values_mut() {
            if synth.config.midi_port == port && synth.config.channel == channel {
                synth.config.volume = volume;
            }
        }
        (port, channel)
    };
    midi.send_channel_volume(port, channel, volume);
    let _ = app.emit(
        "midi-volume",
        VolumeEvent {
            port,
            channel,
            volume,
        },
    );
    Ok(())
}

/// Toggles the velocity mapping mode: relative (rescaled onto the
/// [min, max] range) or clamp (native 1–127 mapping, values outside the
/// range brought to the nearest bound).
#[tauri::command]
pub fn set_synth_velocity_relative(
    id: u32,
    enabled: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.velocity_relative = enabled;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_velocity_range(
    id: u32,
    velocity_min: u8,
    velocity_max: u8,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            // Keep a usable range: min below 127, max between min and 127
            synth.config.velocity_min = velocity_min.min(126);
            synth.config.velocity_max = velocity_max.clamp(synth.config.velocity_min, 127);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_tempo(id: u32, tempo: f64, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.tempo_ratio = normalize_tempo_ratio(tempo);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Enables the master-tempo quantize: the synth's step grid is realigned on
/// the master grid, delaying steps only so no note is ever cut. The resync
/// period (`quantize_beats`) is rounded up to a multiple of the ratio's cycle
/// so a boundary always lands on a natural step (see `metronome`).
#[tauri::command]
pub fn set_synth_quantize(
    id: u32,
    enabled: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.quantize = enabled;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Sets the resync period of the master-tempo quantize, in beats (1-8).
#[tauri::command]
pub fn set_synth_quantize_beats(
    id: u32,
    beats: u8,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.quantize_beats = beats.clamp(1, 8);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_loop(
    id: u32,
    loop_enabled: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.loop_enabled = loop_enabled;
            // Loop and back-and-forth are mutually exclusive
            if loop_enabled {
                synth.config.back_and_forth = false;
                synth.playback.end_pending = false;
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Enables the back-and-forth (ping-pong) playback: the playhead bounces
/// between the bounds of the pixel sequence. Mutually exclusive with the
/// loop.
#[tauri::command]
pub fn set_synth_back_n_forth(
    id: u32,
    enabled: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.back_and_forth = enabled;
            if enabled {
                synth.config.loop_enabled = false;
                synth.playback.end_pending = false;
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Sets the direction in which the pixel sequence is read. The playhead
/// stays on the pixel it is playing: its index is remapped into the newly
/// ordered sequence (restarts at 0 when no image is loaded or the pixel
/// cannot be found in the new sequence).
#[tauri::command]
pub fn set_synth_reading_direction(
    id: u32,
    direction: ReadingDirection,
    state: State<SynthState>,
    image_state: State<ImageState>,
) -> Result<(), AppError> {
    // Image then synths, in the mandated order (see locks.rs).
    crate::locks::with_locked_synth(&image_state, &state, id, |synth, image| {
        // The sequence order changes: remap the playhead onto the same
        // pixel so the reading continues where it is
        let mut cursor = 0;
        if let Some(img) = image {
            cursor = remapped_cursor(
                synth,
                &synth.zones,
                &synth.zones,
                synth.config.sorted_reading,
                synth.config.sorted_reading,
                synth.config.reading_direction,
                direction,
                img.width() as usize,
                img.height() as usize,
            );
        }

        synth.config.reading_direction = direction;
        synth.invalidate_sequence();
        synth.playback.cursor = cursor;
        // A stale end_pending from the old sequence would stop a playing
        // synth on its next tick
        synth.playback.end_pending = false;
    })
}

#[tauri::command]
pub fn set_synth_mode(
    id: u32,
    mode: SynthMode,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            if synth.config.mode == mode {
                return Ok(());
            }
            // Turn off all currently sounding notes before switching modes,
            // to avoid stuck notes when toggling.
            synth.release_notes(&midi_state);
            synth.config.mode = mode;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_note_lengths(
    id: u32,
    lengths: Vec<NoteLength>,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.note_lengths = normalize_note_lengths(&lengths);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_note_length_reversed(
    id: u32,
    reversed: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.note_length_reversed = reversed;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Switches the enabled note lengths between binary subdivisions (their
/// nominal values) and ternary ones (triplets: 3 in the time of 2, i.e.
/// each length is multiplied by 2/3).
#[tauri::command]
pub fn set_synth_note_length_ternary(
    id: u32,
    ternary: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.note_length_ternary = ternary;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Toggles the note articulation: sustained (each note holds its full
/// length, the Note Off arriving with the next note) or pizzicato (the
/// Note Off is sent right after the Note On, the instrument's natural
/// decay shaping the tail). Disabling the sustain immediately releases
/// any currently sounding note, so a note already holding under the
/// previous setting doesn't keep ringing until the next step.
#[tauri::command]
pub fn set_synth_note_sustain(
    id: u32,
    sustain: bool,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            if synth.config.note_sustain != sustain {
                // Either way the sounding notes are released: turning the
                // sustain off must not let a held note ring on, and turning
                // it on must not leave a gated pizzicato note (whose Note
                // Off is now cancelled) held forever. The generation bump
                // inside cancels the stale gates.
                synth.release_notes(&midi_state);
            }
            synth.config.note_sustain = sustain;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Toggles the legato tie: when on, consecutive pixels of the same pitch
/// are tied into one held note instead of being re-articulated on every
/// step. Only meaningful with the sustain on (pizzicato plucks each note)
/// and with note lengths enabled; a pitch change always re-articulates.
/// No note is released here: the change only affects the next steps.
#[tauri::command]
pub fn set_synth_note_legato(
    id: u32,
    legato: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.note_legato = legato;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Sets the MIDI note range filters: one triplet of toggles (bass, medium,
/// treble) for the monophonic note, and one per R/G/B voice in polyphonic
/// mode. All toggles off = full 0–127 range.
#[tauri::command]
pub fn set_synth_note_ranges(
    id: u32,
    mono: [bool; 3],
    voices: [[bool; 3]; 3],
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.mono_note_range = mono;
            synth.config.voice_note_ranges = voices;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Sets the scale the synth's notes are quantized to, and its tonic
/// (a pitch class 0–11, 0 = C). The scale is shared by the monophonic
/// note and every polyphonic voice. Chromatic disables quantization.
#[tauri::command]
pub fn set_synth_scale(
    id: u32,
    scale: Scale,
    root: u8,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.scale = scale;
            synth.config.scale_root = root % 12;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_hue_shift(
    id: u32,
    hue_shift: u16,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.hue_shift = hue_shift.min(360);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_channel_enabled(
    id: u32,
    channel_index: usize,
    enabled: bool,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    if channel_index > 2 {
        return Err(err("invalid_channel_index"));
    }
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.config.channel_enabled[channel_index] = enabled;
            // If disabling a channel whose voice is still sounding, turn it
            // off immediately — unless another voice also sounds that
            // pitch (a pitch shared by several voices is played once).
            if !enabled {
                let note = synth.playback.poly_voices[channel_index].note;
                let shared = synth
                    .playback
                    .poly_voices
                    .iter()
                    .enumerate()
                    .any(|(i, v)| i != channel_index && v.note_is_on && v.note == note);
                let voice = &mut synth.playback.poly_voices[channel_index];
                if voice.note_is_on && !shared {
                    midi_state.note_off(synth.config.midi_port, synth.config.channel, voice.note);
                }
                voice.note_is_on = false;
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_zones(
    id: u32,
    zones: Vec<Zone>,
    state: State<SynthState>,
    image_state: State<ImageState>,
) -> Result<(), AppError> {
    let zones = normalize_zones(zones)?;
    // Image then synths, in the mandated order (see locks.rs).
    crate::locks::with_locked_synth(&image_state, &state, id, |synth, image| {
        // Keep the playhead on the same pixel across zone edits (instead of
        // restarting at the beginning): the flat sequence index has no meaning
        // in the new sequence, but the pixel it points to usually still exists
        // — find it back in the new sequence. When it has been deselected,
        // the reading continues on the next still-selected pixel of the old
        // reading order, and only restarts at 0 when nothing of the old
        // sequence survives (zones emptied, whole selection replaced).
        let mut cursor = 0;
        if let Some(img) = image {
            cursor = remapped_cursor(
                synth,
                &synth.zones,
                &zones,
                synth.config.sorted_reading,
                synth.config.sorted_reading,
                synth.config.reading_direction,
                synth.config.reading_direction,
                img.width() as usize,
                img.height() as usize,
            );
        }

        synth.zones = zones;
        synth.invalidate_sequence();
        synth.playback.cursor = cursor;
        // A stale end_pending from the old sequence would stop a playing
        // synth on its next tick
        synth.playback.end_pending = false;
    })
}

/// Sets the manual silence zones of a synthesizer: selected pixels inside
/// these rectangles are muted by hand (rests). Unlike set_synth_zones,
/// the playback sequence is unchanged — the playhead still travels over
/// the silent pixels — so there is no cursor remapping and no end_pending
/// reset to do.
#[tauri::command]
pub fn set_synth_mute_zones(
    id: u32,
    zones: Vec<Zone>,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let zones = normalize_zones(zones)?;
    let mut synths = state.synths.lock_safe();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.mute_zones = zones;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Toggles the sorted reading of the pixel sequence: when enabled, the
/// selected pixels are ordered by their absolute position in the image
/// (in the reading direction) instead of being read zone by zone. The
/// playhead stays on the pixel it is playing.
#[tauri::command]
pub fn set_synth_sorted_reading(
    id: u32,
    enabled: bool,
    state: State<SynthState>,
    image_state: State<ImageState>,
) -> Result<(), AppError> {
    // Image then synths, in the mandated order (see locks.rs).
    crate::locks::with_locked_synth(&image_state, &state, id, |synth, image| {
        // The sequence order changes: remap the playhead onto the same pixel
        // so the reading continues where it is
        let mut cursor = 0;
        if let Some(img) = image {
            cursor = remapped_cursor(
                synth,
                &synth.zones,
                &synth.zones,
                synth.config.sorted_reading,
                enabled,
                synth.config.reading_direction,
                synth.config.reading_direction,
                img.width() as usize,
                img.height() as usize,
            );
        }

        synth.config.sorted_reading = enabled;
        synth.invalidate_sequence();
        synth.playback.cursor = cursor;
        synth.playback.end_pending = false;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Synth;

    fn state_with_ids(ids: &[u32]) -> HashMap<u32, Synth> {
        ids.iter().map(|&id| (id, Synth::new(id))).collect()
    }

    #[test]
    fn renumber_assigns_ids_in_display_order() {
        // Synths #1 and #2 deleted from a stack of 4: the remaining ids
        // are renumbered 1..N following the display order
        let mut synths = state_with_ids(&[1, 3, 4]);
        for (&id, synth) in synths.iter_mut() {
            synth.config.channel = id as u8; // mark each synth to track the moves
        }
        let mut next_id = 5;

        renumber_synths(&mut synths, &mut next_id, &[3, 1, 4]).unwrap();

        assert_eq!(synths.len(), 3);
        let mut ids: Vec<u32> = synths.keys().copied().collect();
        ids.sort(); // HashMap iteration order is arbitrary
        assert_eq!(ids, vec![1, 2, 3]);
        // The synths themselves moved with their state
        assert_eq!(synths.get(&1).unwrap().config.channel, 3);
        assert_eq!(synths.get(&2).unwrap().config.channel, 1);
        assert_eq!(synths.get(&3).unwrap().config.channel, 4);
        // The id field follows the renumbering
        assert_eq!(synths.get(&2).unwrap().id, 2);
        // The next created synth continues right after the stack
        assert_eq!(next_id, 4);
    }

    #[test]
    fn renumber_already_ordered_stack_is_a_no_op() {
        let mut synths = state_with_ids(&[1, 2]);
        let mut next_id = 3;
        renumber_synths(&mut synths, &mut next_id, &[1, 2]).unwrap();
        assert_eq!(synths.get(&1).unwrap().id, 1);
        assert_eq!(synths.get(&2).unwrap().id, 2);
        assert_eq!(next_id, 3);
    }

    #[test]
    fn renumber_rejects_incomplete_order() {
        let mut synths = state_with_ids(&[1, 2, 3]);
        let mut next_id = 4;
        assert!(renumber_synths(&mut synths, &mut next_id, &[1, 2]).is_err());
        // Nothing was mutated
        assert_eq!(synths.len(), 3);
        assert_eq!(next_id, 4);
    }

    #[test]
    fn renumber_rejects_unknown_id() {
        let mut synths = state_with_ids(&[1, 3]);
        let mut next_id = 4;
        assert!(renumber_synths(&mut synths, &mut next_id, &[1, 2]).is_err());
        assert_eq!(synths.len(), 2);
        assert_eq!(next_id, 4);
    }

    #[test]
    fn renumber_preserves_display_numbers() {
        // The display number is the synth's stable identity for the
        // default title: reordering the stack renumbers the ids but must
        // never touch it
        let mut synths = state_with_ids(&[1, 3]);
        synths.get_mut(&1).unwrap().display_number = 1;
        synths.get_mut(&3).unwrap().display_number = 3;
        let mut next_id = 4;

        renumber_synths(&mut synths, &mut next_id, &[3, 1]).unwrap();

        // Ids follow the new display order...
        assert_eq!(synths.get(&1).unwrap().id, 1);
        assert_eq!(synths.get(&2).unwrap().id, 2);
        // ...but each synth kept its original display number
        assert_eq!(synths.get(&1).unwrap().display_number, 3);
        assert_eq!(synths.get(&2).unwrap().display_number, 1);
    }

    #[test]
    fn renumber_rejects_duplicate_ids() {
        let mut synths = state_with_ids(&[1, 2]);
        let mut next_id = 3;
        assert!(renumber_synths(&mut synths, &mut next_id, &[2, 2]).is_err());
        assert_eq!(synths.len(), 2);
        assert_eq!(next_id, 3);
    }

    #[test]
    fn copy_config_between_replaces_params_but_keeps_routing() {
        let mut synths = state_with_ids(&[1, 2]);
        {
            let src = synths.get_mut(&1).unwrap();
            src.config.tempo_ratio = 0.5;
            src.config.mode = SynthMode::Polyphonic;
            src.config.volume = 64;
            src.config.hue_shift = 200;
            src.config.midi_port = 3;
            src.config.channel = 5;
        }
        {
            let dst = synths.get_mut(&2).unwrap();
            dst.config.midi_port = 9;
            dst.config.channel = 2;
            dst.playback.cached_sequence = Some(crate::state::CachedSequence {
                width: 1,
                height: 1,
                sequence: vec![],
            });
        }

        copy_config_between(&mut synths, 1, 2).unwrap();

        let dst = synths.get(&2).unwrap();
        assert_eq!(dst.config.tempo_ratio, 0.5);
        assert!(matches!(dst.config.mode, SynthMode::Polyphonic));
        assert_eq!(dst.config.volume, 64);
        assert_eq!(dst.config.hue_shift, 200);
        // Routing preserved on the target
        assert_eq!(dst.config.midi_port, 9);
        assert_eq!(dst.config.channel, 2);
        // The derived pixel sequence is dropped
        assert!(dst.playback.cached_sequence.is_none());
    }

    #[test]
    fn copy_config_between_self_is_a_no_op() {
        let mut synths = state_with_ids(&[1]);
        synths.get_mut(&1).unwrap().config.tempo_ratio = 0.75;
        copy_config_between(&mut synths, 1, 1).unwrap();
        assert_eq!(synths.get(&1).unwrap().config.tempo_ratio, 0.75);
    }

    #[test]
    fn copy_config_between_reports_missing_ids() {
        let mut synths = state_with_ids(&[1, 2]);
        assert!(copy_config_between(&mut synths, 9, 2).is_err());
        assert!(copy_config_between(&mut synths, 1, 9).is_err());
        // Nothing was mutated
        assert_eq!(synths.len(), 2);
    }
}

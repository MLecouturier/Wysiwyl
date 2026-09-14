use std::collections::{HashMap, HashSet};
use tauri::State;
use crate::config::ConfigState;
use crate::error::{err, AppError};
use crate::metronome::remapped_cursor;
use crate::state::{NoteLength, PixelZone, ProgramState, ReadingDirection, Scale, Synth, SynthMode, SynthState, ImageState, MidiState};

// --- Existing SynthConfig / SynthEngine (pure pixel-processing logic) ---
// (unchanged, assumed to remain above or below in this file)

/// Builds the standard "synth not found" error, with the id as a parameter.
fn synth_not_found(id: u32) -> AppError {
    err("synth_not_found").with_param("id", id)
}

/// Sets a custom display name for a synthesizer. An empty (or
/// whitespace-only) name clears it, falling back to the default name.
#[tauri::command]
pub fn set_synth_name(
    id: u32,
    name: String,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let trimmed = name.trim().to_string();
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.name = if trimmed.is_empty() { None } else { Some(trimmed) };
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
) -> Result<Synth, AppError> {
    let template = config_state.config.lock().unwrap().default_synth.clone();

    let mut next_id = state.next_id.lock().unwrap();
    let id = *next_id;
    *next_id += 1;
    drop(next_id);

    // The display number comes from its own counter (see
    // `Synth::display_number`): it survives renumbering and is never
    // reused after a removal
    let display_number = {
        let mut next = state.next_display_number.lock().unwrap();
        let n = *next;
        *next += 1;
        n
    };

    let mut synth = template.to_synth(id);
    synth.display_number = display_number;
    state.synths.lock().unwrap().insert(id, synth.clone());

    Ok(synth)
}

#[tauri::command]
pub fn remove_synth(id: u32, state: State<SynthState>) {
    state.synths.lock().unwrap().remove(&id);
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
    let mut synths = state.synths.lock().unwrap();
    let mut next_id = state.next_id.lock().unwrap();
    renumber_synths(&mut synths, &mut next_id, &order)
}

#[tauri::command]
pub fn reset_synth_cursor(id: u32, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.cursor = 0;
            synth.end_pending = false;
            synth.tempo_accumulator = 0.0;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn start_synth(id: u32, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playing = true;
            // A fresh start always replays from the beginning of the sequence
            // (e.g. after manually stepping to the end while paused)
            synth.end_pending = false;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playing = false;
            synth.end_pending = false;
            synth.tempo_accumulator = 0.0;

            // Immediately turn off the current mono note, if it is still sounding
            if synth.note_is_on {
                midi_state.note_off(synth.midi_port, synth.channel, synth.note);
                synth.note_is_on = false;
            }

            // Turn off any currently sounding polyphonic voices
            for voice in synth.poly_voices.iter_mut() {
                if voice.note_is_on {
                    midi_state.note_off(synth.midi_port, synth.channel, voice.note);
                    voice.note_is_on = false;
                }
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Kill switch: stops every synthesizer and immediately turns off all
/// sounding notes (mono + polyphonic voices). The note generation is
/// bumped so pending delayed Note Offs cancel themselves.
#[tauri::command]
pub fn panic_all(
    state: State<SynthState>,
    midi_state: State<MidiState>,
) {
    let mut synths = state.synths.lock().unwrap();
    for synth in synths.values_mut() {
        synth.playing = false;
        synth.end_pending = false;
        synth.tempo_accumulator = 0.0;
        synth.note_generation += 1;

        if synth.note_is_on {
            midi_state.note_off(synth.midi_port, synth.channel, synth.note);
            synth.note_is_on = false;
        }
        for voice in synth.poly_voices.iter_mut() {
            if voice.note_is_on {
                midi_state.note_off(synth.midi_port, synth.channel, voice.note);
                voice.note_is_on = false;
            }
        }
    }
}

#[tauri::command]
pub fn is_synth_playing(id: u32, state: State<SynthState>) -> bool {
    state
        .synths
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.playing)
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_synth_channel(id: u32, channel: u8, state: State<SynthState>) -> Result<(), AppError> {
    let clamped = channel.min(15);
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.channel = clamped;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            if synth.midi_port != port {
                // Turn off any sounding note on the old port first, to
                // avoid a stuck note on the device it is connected to.
                if synth.note_is_on {
                    midi_state.note_off(synth.midi_port, synth.channel, synth.note);
                    synth.note_is_on = false;
                }
                for voice in synth.poly_voices.iter_mut() {
                    if voice.note_is_on {
                        midi_state.note_off(synth.midi_port, synth.channel, voice.note);
                        voice.note_is_on = false;
                    }
                }
                synth.midi_port = port;
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
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
        let synths = state.synths.lock().unwrap();
        let synth = synths
            .get(&id)
            .ok_or_else(|| synth_not_found(id))?;
        (synth.midi_port, synth.channel)
    };
    Ok(midi.send_program_change(port, channel, program, bank_msb, bank_lsb))
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.velocity_relative = enabled;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            // Keep a usable range: min below 127, max between min and 127
            synth.velocity_min = velocity_min.min(126);
            synth.velocity_max = velocity_max.clamp(synth.velocity_min, 127);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_brightness_range(
    id: u32,
    brightness_min: u8,
    brightness_max: u8,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.brightness_min = brightness_min.min(127);
            synth.brightness_max = brightness_max.min(127);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_tempo(id: u32, tempo: f64, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.tempo_ratio = tempo.clamp(0.05, 4.0);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_loop(id: u32, loop_enabled: bool, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.loop_enabled = loop_enabled;
            // Loop and back-and-forth are mutually exclusive
            if loop_enabled {
                synth.back_and_forth = false;
                synth.end_pending = false;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.back_and_forth = enabled;
            if enabled {
                synth.loop_enabled = false;
                synth.end_pending = false;
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Sets the direction in which the pixel sequence is read. The playhead
/// restarts from the beginning of the newly ordered sequence.
#[tauri::command]
pub fn set_synth_reading_direction(
    id: u32,
    direction: ReadingDirection,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.reading_direction = direction;
            synth.cursor = 0;
            synth.play_forward = true;
            synth.end_pending = false;
            synth.tempo_accumulator = 0.0;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_mode(
    id: u32,
    mode: SynthMode,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            if synth.mode == mode {
                return Ok(());
            }
            // Turn off all currently sounding notes before switching modes,
            // to avoid stuck notes when toggling.
            if synth.note_is_on {
                midi_state.note_off(synth.midi_port, synth.channel, synth.note);
                synth.note_is_on = false;
            }
            for voice in synth.poly_voices.iter_mut() {
                if voice.note_is_on {
                    midi_state.note_off(synth.midi_port, synth.channel, voice.note);
                    voice.note_is_on = false;
                }
            }
            synth.mode = mode;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.note_lengths = lengths;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.note_length_reversed = reversed;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            if synth.note_sustain && !sustain {
                if synth.note_is_on {
                    midi_state.note_off(synth.midi_port, synth.channel, synth.note);
                    synth.note_is_on = false;
                }
                for voice in synth.poly_voices.iter_mut() {
                    if voice.note_is_on {
                        midi_state.note_off(synth.midi_port, synth.channel, voice.note);
                        voice.note_is_on = false;
                    }
                }
            }
            synth.note_sustain = sustain;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.mono_note_range = mono;
            synth.voice_note_ranges = voices;
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.scale = scale;
            synth.scale_root = root.min(11);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_hue_shift(id: u32, hue_shift: u16, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.hue_shift = hue_shift.min(360);
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
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.channel_enabled[channel_index] = enabled;
            // If disabling a channel whose voice is still sounding, turn it off immediately.
            if !enabled {
                let voice = &mut synth.poly_voices[channel_index];
                if voice.note_is_on {
                    midi_state.note_off(synth.midi_port, synth.channel, voice.note);
                    voice.note_is_on = false;
                }
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_zones(
    id: u32,
    zones: Vec<PixelZone>,
    state: State<SynthState>,
    image_state: State<ImageState>,
) -> Result<(), AppError> {
    // Lock in the metronome's order (image, then synths) to avoid an
    // AB-BA deadlock with the tick loop
    let image = image_state.processed.lock().unwrap();
    let mut synths = state.synths.lock().unwrap();
    let synth = match synths.get_mut(&id) {
        Some(s) => s,
        None => return Err(synth_not_found(id)),
    };

    // Keep the playhead on the same pixel across zone edits (instead of
    // restarting at the beginning): the flat sequence index has no meaning
    // in the new sequence, but the pixel it points to usually still exists
    // — find it back in the new sequence. When it cannot be found (zones
    // emptied, grid reshaped), the reading restarts at 0.
    let mut cursor = 0;
    if let Some(img) = image.as_ref() {
        cursor = remapped_cursor(
            synth,
            &synth.zones,
            &zones,
            synth.sorted_reading,
            synth.sorted_reading,
            img.width() as usize,
            img.height() as usize,
        );
    }

    synth.zones = zones;
    synth.cursor = cursor;
    // A stale end_pending from the old sequence would stop a playing
    // synth on its next tick
    synth.end_pending = false;
    Ok(())
}

/// Sets the manual silence zones of a synthesizer: selected pixels inside
/// these rectangles are muted by hand (rests). Unlike set_synth_zones,
/// the playback sequence is unchanged — the playhead still travels over
/// the silent pixels — so there is no cursor remapping and no end_pending
/// reset to do.
#[tauri::command]
pub fn set_synth_mute_zones(
    id: u32,
    zones: Vec<PixelZone>,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
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
    // Lock in the metronome's order (image, then synths) to avoid an
    // AB-BA deadlock with the tick loop
    let image = image_state.processed.lock().unwrap();
    let mut synths = state.synths.lock().unwrap();
    let synth = match synths.get_mut(&id) {
        Some(s) => s,
        None => return Err(synth_not_found(id)),
    };

    // The sequence order changes: remap the playhead onto the same pixel
    // so the reading continues where it is
    let mut cursor = 0;
    if let Some(img) = image.as_ref() {
        cursor = remapped_cursor(
            synth,
            &synth.zones,
            &synth.zones,
            synth.sorted_reading,
            enabled,
            img.width() as usize,
            img.height() as usize,
        );
    }

    synth.sorted_reading = enabled;
    synth.cursor = cursor;
    synth.end_pending = false;
    Ok(())
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
            synth.channel = id as u8; // mark each synth to track the moves
        }
        let mut next_id = 5;

        renumber_synths(&mut synths, &mut next_id, &[3, 1, 4]).unwrap();

        assert_eq!(synths.len(), 3);
        let mut ids: Vec<u32> = synths.keys().copied().collect();
        ids.sort(); // HashMap iteration order is arbitrary
        assert_eq!(ids, vec![1, 2, 3]);
        // The synths themselves moved with their state
        assert_eq!(synths.get(&1).unwrap().channel, 3);
        assert_eq!(synths.get(&2).unwrap().channel, 1);
        assert_eq!(synths.get(&3).unwrap().channel, 4);
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
}

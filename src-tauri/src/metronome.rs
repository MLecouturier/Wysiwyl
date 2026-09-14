use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use image::{DynamicImage, GenericImageView};

use crate::error::{err, AppError};
use crate::config::ConfigState;
use crate::state::{
    ImageState, NoteLength, PixelZone, ReadingDirection, Scale, Synth, SynthMode, SynthState, MidiState,
};

/// Computes the perceived brightness of an RGBA pixel (Rec.601 formula), 0.0–255.0.
fn pixel_luma(r: u8, g: u8, b: u8) -> f32 {
    0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32
}

/// Computes the hue of an RGB pixel using the HSL color model, in degrees (0.0–360.0).
/// For an achromatic pixel (pure gray, r=g=b), the hue is undefined; we return 0.0.
fn pixel_hue(r: u8, g: u8, b: u8) -> f32 {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    if delta.abs() < f32::EPSILON {
        return 0.0; // gray: hue undefined
    }

    let hue = if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };

    if hue < 0.0 { hue + 360.0 } else { hue }
}

/// Maps a hue (0–360°) to a MIDI note 0–127.
fn hue_to_midi_note(hue: f32) -> u8 {
    ((hue / 360.0) * 127.0).round().clamp(0.0, 127.0) as u8
}

/// Maps a color channel value (0–255) to a MIDI note 0–127.
fn channel_to_midi_note(value: u8) -> u8 {
    ((value as f32 / 255.0) * 127.0).round() as u8
}

/// Maps a brightness value (0–255) to a MIDI level 0–127 (used for
/// brightness-threshold filtering, independently of the note played).
fn luma_to_level(luma: f32) -> u8 {
    ((luma / 255.0) * 127.0).round() as u8
}

/// Computes the HSL saturation of an RGB pixel, in 0.0–255.0.
fn pixel_saturation(r: u8, g: u8, b: u8) -> f32 {
    let (r, g, b) = (r as f32, g as f32, b as f32);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    if max <= f32::EPSILON {
        0.0 // black: saturation undefined
    } else {
        delta / max * 255.0
    }
}

/// Maps a saturation value (0–255) to a MIDI velocity between
/// `velocity_min` and `velocity_max` (the more saturated the pixel, the
/// stronger the velocity: achromatic areas are played delicately, vivid
/// colors with more intensity). The bounds therefore define the velocity
/// range, not a silence threshold.
///
/// Two mappings share these bounds:
/// - relative (velocity_relative = true): the saturation is rescaled
///   onto [min, max], so the whole range is used whatever the image;
/// - clamp (velocity_relative = false): the velocity is computed on the
///   native full range 1–127, then values outside [min, max] are brought
///   to the nearest bound (a floor/ceiling filter, no compression).
fn saturation_to_velocity(
    saturation: f32,
    velocity_min: u8,
    velocity_max: u8,
    velocity_relative: bool,
) -> u8 {
    let lo = velocity_min.min(126);
    let hi = velocity_max.clamp(lo, 127);
    let v = if velocity_relative {
        // Rescale: saturation 0 → min, 255 → max
        let min = lo as f32;
        let max = hi as f32;
        min + (saturation / 255.0) * (max - min)
    } else {
        // Native full range, clamped afterwards
        1.0 + (saturation / 255.0) * 126.0
    };
    v.round().clamp(lo.max(1) as f32, hi as f32) as u8
}

/// Processes a pixel in monophonic mode: the hue (shifted by hue_shift)
/// determines a single note. `retrigger` forces a note re-articulation on
/// every pixel (used when note lengths are enabled, where each pixel is a
/// distinct note of a fixed duration, disabling the legato sustain).
/// `manual_mute` silences the pixel by hand (rest): no note is sounded,
/// exactly like a pixel outside the brightness window.
fn process_monophonic(
    synth: &mut Synth,
    midi: &MidiState,
    note_range_bounds: &[(u8, u8); 3],
    r: u8, g: u8, b: u8,
    brightness_level: u8,
    velocity: u8,
    payload: &mut serde_json::Value,
    retrigger: bool,
    manual_mute: bool,
) {
    let hue = pixel_hue(r, g, b);
    let shifted_hue = (hue + synth.hue_shift as f32) % 360.0;
    let raw_note = hue_to_midi_note(shifted_hue);
    // Rescale the hue proportionally across the enabled MIDI range filters,
    // then quantize to the synth's scale: the pitch rises gradually from
    // the low to the high bound of the allowed range as the hue increases,
    // landing only on scale degrees.
    let effective_note = effective_note_for(synth, shifted_hue / 360.0, note_range_bounds, &synth.mono_note_range);

    let in_range = !manual_mute
        && brightness_level >= synth.brightness_min
        && brightness_level <= synth.brightness_max;

    // We only (re)trigger MIDI if the note actually changes or if its
    // audible status (muted / not muted) changes. Otherwise we let the
    // current note keep sounding without interruption (legato).
    let note_changed = effective_note != synth.note || retrigger;
    let needs_off = synth.note_is_on && (note_changed || !in_range);
    let needs_on  = in_range && (!synth.note_is_on || note_changed);

    if needs_off {
        midi.note_off(synth.midi_port, synth.channel, synth.note);
        synth.note_is_on = false;
    }

    synth.note = effective_note;
    synth.active_note = in_range;

    if needs_on {
        midi.note_on(synth.midi_port, synth.channel, effective_note, velocity);
        synth.note_is_on = true;
        synth.note_generation = synth.note_generation.wrapping_add(1);
    }

    payload["note"] = serde_json::json!(effective_note);
    payload["raw_note"] = serde_json::json!(raw_note);
    payload["hue"] = serde_json::json!(hue);
    payload["muted"] = serde_json::json!(!in_range);
}

/// Processes a pixel in polyphonic mode: each enabled R/G/B channel generates
/// its own independent note, forming a chord of 1 to 3 notes. `retrigger`
/// forces a re-articulation of every enabled voice on each pixel (used when
/// note lengths are enabled, see process_monophonic). `manual_mute` silences
/// the pixel by hand (rest): no voice is sounded, exactly like a pixel
/// outside the brightness window.
fn process_polyphonic(
    synth: &mut Synth,
    midi: &MidiState,
    note_range_bounds: &[(u8, u8); 3],
    r: u8, g: u8, b: u8,
    brightness_level: u8,
    velocity: u8,
    payload: &mut serde_json::Value,
    retrigger: bool,
    manual_mute: bool,
) {
    let channel_values = [r, g, b];
    let channel_midi = synth.channel;
    let global_in_range = !manual_mute
        && brightness_level >= synth.brightness_min
        && brightness_level <= synth.brightness_max;

    let mut voices_payload = Vec::with_capacity(3);

    for i in 0..3 {
        let enabled = synth.channel_enabled[i];
        let raw_note = channel_to_midi_note(channel_values[i]);
        // Rescale the channel value proportionally across this voice's
        // enabled range filters, then quantize to the synth's scale: the
        // pitch rises gradually from the low to the high bound of the
        // allowed range as the channel value increases, landing only on
        // scale degrees.
        let effective_note = effective_note_for(synth, channel_values[i] as f32 / 255.0, note_range_bounds, &synth.voice_note_ranges[i]);
        let voice = &mut synth.poly_voices[i];

        let in_range = enabled && global_in_range;

        let note_changed = effective_note != voice.note || retrigger;
        let needs_off = voice.note_is_on && (note_changed || !in_range);
        let needs_on  = in_range && (!voice.note_is_on || note_changed);

        if needs_off {
            midi.note_off(synth.midi_port, channel_midi, voice.note);
            voice.note_is_on = false;
        }

        voice.note = effective_note;

        if needs_on {
            midi.note_on(synth.midi_port, channel_midi, effective_note, velocity);
            voice.note_is_on = true;
            synth.note_generation = synth.note_generation.wrapping_add(1);
        }

        voices_payload.push(serde_json::json!({
            "enabled": enabled,
            "note": effective_note,
            "raw_note": raw_note,
            "muted": !in_range,
        }));
    }

    // global active_note: true if at least one voice is sounding (useful for the highlight/UI)
    synth.active_note = synth.poly_voices.iter().enumerate().any(|(i, v)| v.note_is_on && synth.channel_enabled[i]);

    payload["voices"] = serde_json::json!(voices_payload);
    payload["muted"] = serde_json::json!(!global_in_range);
}

/// True when the pixel at (x, y) is covered by one of the given zones
/// (rectangles in grid cells, same convention as build_pixel_sequence).
fn pixel_in_zones(zones: &[PixelZone], x: u32, y: u32) -> bool {
    zones.iter().any(|z| x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h)
}

/// Pushes the pixels of a rectangle in a spiral order, from its
/// top-left corner toward its center: clockwise (`Spiral`, first step
/// to the right) or counterclockwise (`SpiralReverse`, first step
/// downward). The bounds shrink after each side; each loop iteration
/// must re-check them because odd-sized edges meet in the middle.
fn push_spiral_rect(sequence: &mut Vec<usize>, x0: usize, y0: usize, x1: usize, y1: usize, width: usize, clockwise: bool) {
    let (mut left, mut top, mut right, mut bottom) = (x0, y0, x1, y1);
    while left < right && top < bottom {
        if clockwise {
            for x in left..right { sequence.push(top * width + x); }
            top += 1;
            for y in top..bottom { sequence.push(y * width + right - 1); }
            right -= 1;
            if top < bottom {
                for x in (left..right).rev() { sequence.push((bottom - 1) * width + x); }
                bottom -= 1;
            }
            if left < right {
                for y in (top..bottom).rev() { sequence.push(y * width + left); }
                left += 1;
            }
        } else {
            for y in top..bottom { sequence.push(y * width + left); }
            left += 1;
            for x in left..right { sequence.push((bottom - 1) * width + x); }
            bottom -= 1;
            if left < right {
                for y in (top..bottom).rev() { sequence.push(y * width + right - 1); }
                right -= 1;
            }
            if top < bottom {
                for x in (left..right).rev() { sequence.push(top * width + x); }
                top += 1;
            }
        }
    }
}

/// Builds the flat, ordered list of pixel indices covered by the synth's
/// zones. By default each zone is read in full, one after the other in
/// drawing order, following the reading direction: line by line for the
/// horizontal directions, column by column for the vertical ones, and
/// with a spiral from the zone's top-left corner toward its center for
/// the two spiral directions. With `sorted` the pixels of all zones are
/// merged and ordered by their absolute position in the image (in the
/// reading direction) — one continuous sweep instead of per-zone blocks —
/// except for the spiral directions, where the spiral is computed
/// globally over the whole selection (bounding box spiral, filtered to
/// the selected pixels, deduplicated): a scattered selection then reads
/// in a seemingly random yet reproducible order. An empty zone list
/// yields an empty sequence (nothing selected); zones are clipped to
/// the image bounds.
pub(crate) fn build_pixel_sequence(
    zones: &[PixelZone],
    width: usize,
    height: usize,
    direction: ReadingDirection,
    sorted: bool,
) -> Vec<usize> {
    let mut sequence = Vec::new();

    // Spiral directions: per-zone spiral when unsorted, global spiral
    // over the whole selection when sorted
    if matches!(direction, ReadingDirection::Spiral | ReadingDirection::SpiralReverse) {
        let clockwise = direction == ReadingDirection::Spiral;
        if sorted {
            // Global spiral: sweep the bounding box of every zone, keeping
            // only the selected pixels (deduplicated — a pixel covered by
            // overlapping zones would otherwise break the spiral)
            let selected: HashSet<usize> = zones.iter().flat_map(|zone| {
                let x0 = (zone.x as usize).min(width);
                let y0 = (zone.y as usize).min(height);
                let x1 = (x0 + zone.w as usize).min(width);
                let y1 = (y0 + zone.h as usize).min(height);
                (y0..y1).flat_map(move |y| (x0..x1).map(move |x| y * width + x))
            }).collect();
            if selected.is_empty() {
                return sequence;
            }
            // Bounding box of the zones, clamped to the image bounds (the
            // sweep may cover unselected pixels; membership filtering
            // happens afterwards)
            let left = zones.iter().map(|z| z.x).min().unwrap_or(0) as usize;
            let right = (zones.iter().map(|z| z.x + z.w).max().unwrap_or(0) as usize).min(width);
            let top = zones.iter().map(|z| z.y).min().unwrap_or(0) as usize;
            let bottom = (zones.iter().map(|z| z.y + z.h).max().unwrap_or(0) as usize).min(height);
            let mut spiral = Vec::with_capacity(selected.len());
            push_spiral_rect(&mut spiral, left, top, right, bottom, width, clockwise);
            sequence = spiral.into_iter().filter(|p| selected.contains(p)).collect();
        } else {
            for zone in zones {
                let x0 = (zone.x as usize).min(width);
                let y0 = (zone.y as usize).min(height);
                let x1 = (x0 + zone.w as usize).min(width);
                let y1 = (y0 + zone.h as usize).min(height);
                push_spiral_rect(&mut sequence, x0, y0, x1, y1, width, clockwise);
            }
        }
        return sequence;
    }

    for zone in zones {
        let x0 = (zone.x as usize).min(width);
        let y0 = (zone.y as usize).min(height);
        let x1 = (x0 + zone.w as usize).min(width);
        let y1 = (y0 + zone.h as usize).min(height);

        match direction {
            ReadingDirection::LeftToRight => {
                for y in y0..y1 {
                    for x in x0..x1 {
                        sequence.push(y * width + x);
                    }
                }
            }
            ReadingDirection::RightToLeft => {
                for y in y0..y1 {
                    for x in (x0..x1).rev() {
                        sequence.push(y * width + x);
                    }
                }
            }
            ReadingDirection::TopToBottom => {
                for x in x0..x1 {
                    for y in y0..y1 {
                        sequence.push(y * width + x);
                    }
                }
            }
            ReadingDirection::BottomToTop => {
                for x in x0..x1 {
                    for y in (y0..y1).rev() {
                        sequence.push(y * width + x);
                    }
                }
            }
            ReadingDirection::Spiral | ReadingDirection::SpiralReverse => unreachable!("handled above"),
        }
    }

    // Sorted reading: order the pixels of every zone by their absolute
    // position in the image, following the reading direction. The pixel
    // index is y * width + x, so the (row, column) and (column, row)
    // lexicographic orders (with the appropriate direction reversed) give
    // the four sweeps directly.
    if sorted {
        match direction {
            ReadingDirection::LeftToRight => sequence.sort_unstable(),
            ReadingDirection::RightToLeft => sequence
                .sort_unstable_by_key(|&p| (p / width, std::cmp::Reverse(p % width))),
            ReadingDirection::TopToBottom => {
                sequence.sort_unstable_by_key(|&p| (p % width, p / width))
            }
            ReadingDirection::BottomToTop => sequence
                .sort_unstable_by_key(|&p| (p % width, std::cmp::Reverse(p / width))),
            ReadingDirection::Spiral | ReadingDirection::SpiralReverse => unreachable!("handled above"),
        }
    }
    sequence
}

/// Computes the sequence index of the pixel currently under the synth's
/// playhead, once its sequence has changed (zones edited, sorted reading
/// or reading direction changed): keeps the playhead on the same pixel
/// instead of restarting at the beginning. Returns 0 when the pixel is no
/// longer selected (or the old sequence was empty).
pub(crate) fn remapped_cursor(
    synth: &Synth,
    old_zones: &[PixelZone],
    new_zones: &[PixelZone],
    old_sorted: bool,
    new_sorted: bool,
    old_direction: ReadingDirection,
    new_direction: ReadingDirection,
    width: usize,
    height: usize,
) -> usize {
    let old_seq = build_pixel_sequence(old_zones, width, height, old_direction, old_sorted);
    if old_seq.is_empty() {
        return 0;
    }
    let pixel = old_seq[synth.cursor % old_seq.len()];
    let new_seq = build_pixel_sequence(new_zones, width, height, new_direction, new_sorted);
    new_seq.iter().position(|&p| p == pixel).unwrap_or(0)
}

/// Plays the pixel at the synth's current playhead position, then advances
/// the playhead by one pixel in its zone sequence (MIDI notes + UI payload),
/// exactly like a metronome tick would. Used both by the metronome thread
/// and by the manual step command; the synth does not need to be playing.
///
/// Returns `Some(length_beats)` when note lengths are enabled: the pixel
/// occupies exactly that duration (in beats of the synth's own tempo),
/// which the caller applies to the tempo accumulator. `None` means the
/// historical behavior: quarter-note steps with legato sustain.
fn step_synth_once(
    app: &AppHandle,
    synth: &mut Synth,
    image: &DynamicImage,
    midi: &MidiState,
) -> Option<f64> {
    let width = image.width() as usize;
    let height = image.height() as usize;

    // Flat sequence of pixels covered by the synth's zones, in the synth's
    // reading direction (sorted or per-zone blocks depending on
    // sorted_reading). The cursor is an index into this sequence; zones
    // partially outside the image are clipped, and an empty zone list
    // (nothing selected) leaves a paused synth stalled.
    let sequence = build_pixel_sequence(&synth.zones, width, height, synth.reading_direction, synth.sorted_reading);
    let seq_len = sequence.len();

    // Deferred end of a non-looping sequence: end_pending means the last
    // pixel was played on the previous tick and its note has now rung for
    // a full step period — stop the synth. A playing synth whose zones
    // were emptied (or fully clipped away) mid-playback stops the same
    // way: without this the tick would silently stall, leaving the
    // sounding note on forever and the UI in its playing state.
    if seq_len == 0 || (synth.end_pending && !synth.loop_enabled) {
        if synth.playing {
            synth.playing = false;
            synth.cursor = 0;
            synth.tempo_accumulator = 0.0;
            // Turn off the current mono note if it is still sounding
            if synth.note_is_on {
                midi.note_off(synth.midi_port, synth.channel, synth.note);
                synth.note_is_on = false;
            }
            // Turn off any currently sounding polyphonic voices
            for voice in synth.poly_voices.iter_mut() {
                if voice.note_is_on {
                    midi.note_off(synth.midi_port, synth.channel, voice.note);
                    voice.note_is_on = false;
                }
            }
            let _ = app.emit("synth-stopped", serde_json::json!({ "id": synth.id }));
        }
        return None;
    }

    let pos = synth.cursor % seq_len;

    // Read the pixel at the current playhead position (the payload reports
    // the absolute pixel index, not the sequence index)
    let pixel_index = sequence[pos];
    let px = pixel_index as u32;
    let x = px % width as u32;
    let y = px / width as u32;
    let pixel = image.get_pixel(x, y);
    let (r, g, b, a) = (pixel[0], pixel[1], pixel[2], pixel[3]);
    // Manually silenced pixel (rest): the playhead still travels over it,
    // it just sounds nothing
    let manual_mute = pixel_in_zones(&synth.mute_zones, x, y);
    let luma = pixel_luma(r, g, b);
    let brightness_level = luma_to_level(luma);
    let saturation = pixel_saturation(r, g, b);
        let velocity = saturation_to_velocity(
            saturation,
            synth.velocity_min,
            synth.velocity_max,
            synth.velocity_relative,
        );
    synth.velocity = velocity;

    // Note lengths: when enabled, the pixel's brightness picks a duration
    // among the enabled lengths and each pixel is played as a distinct
    // note of that fixed duration (no legato). Empty list = all quarter
    // notes, i.e. the historical legato behavior. The duration applies
    // even to muted pixels, so the rhythm structure stays consistent.
    let note_length = if synth.note_lengths.is_empty() {
        None
    } else {
        Some(pick_note_length(synth, brightness_level))
    };
    let retrigger = note_length.is_some();

    // User-configurable note-range bounds (bass, medium, treble)
    let note_range_bounds = app.state::<ConfigState>().config.lock().unwrap().note_range_bounds;

    let mut payload = serde_json::json!({
        "id": synth.id,
        "cursor": pixel_index,
        "r": r, "g": g, "b": b, "a": a,
        "brightness_level": brightness_level,
        "velocity": velocity,
        "mode": synth.mode,
    });

    match synth.mode {
        SynthMode::Monophonic => {
            process_monophonic(
                synth, midi, &note_range_bounds, r, g, b,
                brightness_level, velocity, &mut payload, retrigger, manual_mute,
            );
        }
        SynthMode::Polyphonic => {
            process_polyphonic(
                synth, midi, &note_range_bounds, r, g, b,
                brightness_level, velocity, &mut payload, retrigger, manual_mute,
            );
        }
    }

    // Pizzicato: with the sustain disabled, release the notes right
    // after their articulation — the Note Off is sent immediately after
    // the Note On, and the instrument's natural decay (its release
    // phase) shapes the tail of the note instead of it holding for the
    // full duration. The playback rhythm is unchanged: the note lengths
    // still drive when the next pixel is played. Clearing note_is_on
    // also makes every following pixel re-articulate, so a run of
    // identical pixels becomes a series of plucks rather than one
    // held note.
    if !synth.note_sustain {
        if synth.note_is_on {
            midi.note_off(synth.midi_port, synth.channel, synth.note);
            synth.note_is_on = false;
        }
        for voice in synth.poly_voices.iter_mut() {
            if voice.note_is_on {
                midi.note_off(synth.midi_port, synth.channel, voice.note);
                voice.note_is_on = false;
            }
        }
    }

    let _ = app.emit("synth-pixel-tick", payload);

    // Then advance the playhead for the next step, following the current
    // travel direction: back-and-forth reverses it at the sequence bounds,
    // loop wraps around (in the travel direction), and a one-shot sequence
    // raises end_pending so the next tick stops the synth after the final
    // note has rung for a full step.
    let mut forward = synth.play_forward;
    let at_end = forward && pos + 1 >= seq_len;
    let at_start = !forward && pos == 0;

    let next = if at_end || at_start {
        if synth.loop_enabled {
            if at_end { 0 } else { seq_len - 1 }
        } else if synth.back_and_forth {
            forward = !forward;
            if at_end {
                if seq_len > 1 { pos - 1 } else { pos }
            } else {
                if seq_len > 1 { pos + 1 } else { pos }
            }
        } else {
            pos // end of a one-shot sequence: end_pending stops on the next tick
        }
    } else if forward {
        pos + 1
    } else {
        pos - 1
    };

    synth.play_forward = forward;
    synth.cursor = next;
    synth.end_pending = (at_end || at_start) && !synth.loop_enabled && !synth.back_and_forth;

    note_length
}

/// Duration of a note length, in beats of the synth's own tempo.
fn length_beats(length: NoteLength) -> f64 {
    match length {
        NoteLength::Whole => 4.0,
        NoteLength::Half => 2.0,
        NoteLength::Quarter => 1.0,
        NoteLength::Eighth => 0.5,
        NoteLength::Sixteenth => 0.25,
    }
}

/// Maps the pixel's brightness level (0–127) to a duration among the
/// enabled note lengths: the level range is split into as many equal
/// bands as enabled lengths. By default the darkest band gets the
/// shortest length and the brightest the longest; `note_length_reversed`
/// flips the direction.
fn pick_note_length(synth: &Synth, brightness_level: u8) -> f64 {
    let mut lengths: Vec<f64> = synth
        .note_lengths
        .iter()
        .map(|&l| length_beats(l))
        .collect();
    if synth.note_length_reversed {
        lengths.sort_by(|a, b| b.partial_cmp(a).unwrap());
    } else {
        lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    }
    let n = lengths.len();
    let idx = (brightness_level as usize * n / 128).min(n - 1);
    lengths[idx]
}

/// Collects the (low, high) bounds of the enabled sub-ranges. Toggles are
/// cumulative: the allowed range is the union of the enabled sub-ranges;
/// the bounds are user-configurable (`AppConfig::note_range_bounds`).
fn active_note_ranges(bounds: &[(u8, u8); 3], toggles: &[bool; 3]) -> Vec<(u8, u8)> {
    bounds
        .iter()
        .zip(toggles.iter())
        .filter(|(_, &on)| on)
        .map(|(&(lo, hi), _)| (lo, hi))
        .collect()
}

/// Sorts the enabled sub-ranges and merges the overlapping/adjacent ones
/// so their union is walked exactly once, in ascending order. An empty
/// result means no sub-range is enabled (the full 0–127 range is used).
fn merged_note_ranges(bounds: &[(u8, u8); 3], toggles: &[bool; 3]) -> Vec<(u8, u8)> {
    let mut allowed = active_note_ranges(bounds, toggles);
    allowed.sort_unstable();
    let mut merged: Vec<(u8, u8)> = Vec::with_capacity(allowed.len());
    for &(lo, hi) in &allowed {
        match merged.last_mut() {
            Some(last) if lo as i32 <= last.1 as i32 + 1 => {
                if hi > last.1 {
                    last.1 = hi;
                }
            }
            _ => merged.push((lo, hi)),
        }
    }
    merged
}

/// Rescales a normalized value (0.0–1.0) proportionally across the enabled
/// note-range sub-ranges: the pitch rises gradually and continuously from
/// the low bound of the first enabled sub-range to the high bound of the
/// last one as the value increases. With several disjoint sub-ranges
/// enabled, the sweep walks through each of them in order, skipping the
/// gaps. With no sub-range enabled, the full MIDI range (0–127) is used.
fn rescale_into_range(normalized: f32, bounds: &[(u8, u8); 3], toggles: &[bool; 3]) -> u8 {
    let merged = merged_note_ranges(bounds, toggles);
    if merged.is_empty() {
        return (normalized.clamp(0.0, 1.0) * 127.0).round() as u8;
    }

    // Index of the note within the concatenated playable notes (inclusive bounds)
    let total: i32 = merged
        .iter()
        .map(|&(lo, hi)| hi as i32 - lo as i32 + 1)
        .sum();
    let mut index = (normalized.clamp(0.0, 1.0) * (total - 1) as f32).round() as i32;
    for &(lo, hi) in &merged {
        let span = hi as i32 - lo as i32 + 1;
        if index < span {
            return (lo as i32 + index) as u8;
        }
        index -= span;
    }
    merged[merged.len() - 1].1
}

/// Semitone offsets from the tonic of each scale, within one octave.
fn scale_intervals(scale: Scale) -> &'static [u8] {
    match scale {
        Scale::Chromatic => &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        Scale::Major => &[0, 2, 4, 5, 7, 9, 11],
        Scale::NaturalMinor => &[0, 2, 3, 5, 7, 8, 10],
        Scale::HarmonicMinor => &[0, 2, 3, 5, 7, 8, 11],
        Scale::MelodicMinor => &[0, 2, 3, 5, 7, 9, 11],
        Scale::MajorPentatonic => &[0, 2, 4, 7, 9],
        Scale::MinorPentatonic => &[0, 3, 5, 7, 10],
        Scale::Blues => &[0, 3, 5, 6, 7, 10],
        Scale::Dorian => &[0, 2, 3, 5, 7, 9, 10],
        Scale::Phrygian => &[0, 1, 3, 5, 7, 8, 10],
        Scale::Lydian => &[0, 2, 4, 6, 7, 9, 11],
        Scale::Mixolydian => &[0, 2, 4, 5, 7, 9, 10],
        Scale::Locrian => &[0, 1, 3, 5, 6, 8, 10],
        Scale::WholeTone => &[0, 2, 4, 6, 8, 10],
    }
}

/// All pitches (0–127) a synth may land on: those within its merged
/// enabled note-range sub-ranges (the full 0–127 range when none is
/// enabled) that also belong to its scale, relative to its tonic.
/// The result is sorted ascending; it can be empty when the ranges are
/// too narrow to contain any degree of the scale.
fn allowed_pitches(synth: &Synth, bounds: &[(u8, u8); 3], toggles: &[bool; 3]) -> Vec<u8> {
    let intervals = scale_intervals(synth.scale);
    let ranges = merged_note_ranges(bounds, toggles);
    let ranges = if ranges.is_empty() { vec![(0u8, 127u8)] } else { ranges };
    let mut out = Vec::new();
    for &(lo, hi) in &ranges {
        for note in lo..=hi {
            let rel = (note as i16 - synth.scale_root as i16).rem_euclid(12) as u8;
            if intervals.contains(&rel) {
                out.push(note);
            }
        }
    }
    out
}

/// Snaps a note to the nearest pitch of the allowed set (the nearest
/// scale degree within the enabled ranges). Ties go to the lower pitch.
/// A note already in the set is returned unchanged; an empty set returns
/// the note as-is (a range too narrow for the scale falls back to the
/// unquantized pitch rather than going silent).
fn snap_to_allowed(note: u8, allowed: &[u8]) -> u8 {
    match allowed.binary_search(&note) {
        Ok(_) => note,
        Err(idx) => {
            let lower = if idx > 0 { Some(allowed[idx - 1]) } else { None };
            let upper = allowed.get(idx).copied();
            match (lower, upper) {
                (Some(lo), Some(hi)) => {
                    if note - lo <= hi - note { lo } else { hi }
                }
                (Some(lo), None) => lo,
                (None, Some(hi)) => hi,
                (None, None) => note,
            }
        }
    }
}

/// Full pixel-to-pitch translation for one voice: rescales the normalized
/// hue/channel value across the enabled note-range sub-ranges, then
/// quantizes the result to the synth's scale (no-op when Chromatic —
/// the historical behavior, every semitone allowed).
fn effective_note_for(
    synth: &Synth,
    normalized: f32,
    bounds: &[(u8, u8); 3],
    toggles: &[bool; 3],
) -> u8 {
    let note = rescale_into_range(normalized, bounds, toggles);
    if synth.scale == Scale::Chromatic {
        note
    } else {
        snap_to_allowed(note, &allowed_pitches(synth, bounds, toggles))
    }
}

pub struct MetronomeState {
    pub running: Arc<AtomicBool>,
    pub bpm: Arc<AtomicU32>,
}

impl Default for MetronomeState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            bpm: Arc::new(AtomicU32::new(120)),
        }
    }
}

#[tauri::command]
pub fn set_metronome_bpm(state: tauri::State<MetronomeState>, bpm: u32) {
    let clamped = bpm.clamp(20, 300);
    state.bpm.store(clamped, Ordering::Relaxed);
}

#[tauri::command]
pub fn start_metronome(app: AppHandle, state: tauri::State<MetronomeState>) {
    if state.running.load(Ordering::Relaxed) {
            return; // already running
    }
    state.running.store(true, Ordering::Relaxed);

    let running = state.running.clone();
    let bpm = state.bpm.clone();

    thread::spawn(move || {
        let mut beat_index: u64 = 0;
        let mut sub_beat: u32 = 0; // 0..3: each beat is split into 4 wakes,
                                   // to give eighth/sixteenth note lengths
                                   // enough time resolution
        while running.load(Ordering::Relaxed) {
            let current_bpm = bpm.load(Ordering::Relaxed).max(1);
            let beat_ms = 60_000u64 / current_bpm as u64;

            if sub_beat == 0 {
                let _ = app.emit("metronome-tick", beat_index);
            }

            // --- Advancing active synths over the image ---
            let image_state = app.state::<ImageState>();
            let synth_state = app.state::<SynthState>();
            let midi_state = app.state::<MidiState>();

            if let Some(image) = image_state.processed.lock().unwrap().as_ref() {
                let mut synths = synth_state.synths.lock().unwrap();

                for synth in synths.values_mut() {
                    if !synth.playing {
                        continue;
                    }

                    // Tempo desynchronization: each quarter-beat wake adds a
                    // quarter of the synth's tempo ratio to its accumulator;
                    // the synth advances when at least one full step has
                    // accumulated (e.g. ratio 0.5 = one pixel every two beats).
                    synth.tempo_accumulator += synth.tempo_ratio * 0.25;
                    if synth.tempo_accumulator < 1.0 {
                        continue;
                    }
                    synth.tempo_accumulator -= 1.0;

                    let played_length = step_synth_once(&app, synth, image, &midi_state);
                    if let Some(length_beats) = played_length {
                        // Note lengths enabled: the played pixel occupies
                        // exactly its note's duration. Rewind the accumulator
                        // so the next pixel is due after `length_beats` beats
                        // of the synth's own tempo (i.e. length_beats / ratio
                        // metronome beats).
                        synth.tempo_accumulator = 1.0 - length_beats;
                    }
                }
            }

            sub_beat = (sub_beat + 1) % 4;
            if sub_beat == 0 {
                beat_index += 1;
            }
            thread::sleep(Duration::from_millis(beat_ms / 4));
        }
    });
}

#[tauri::command]
pub fn stop_metronome(state: tauri::State<MetronomeState>) {
    state.running.store(false, Ordering::Relaxed);
}

#[tauri::command]
pub fn is_metronome_running(state: tauri::State<MetronomeState>) -> bool {
    state.running.load(Ordering::Relaxed)
}

/// Manually advances a synth's playhead by one pixel in its zone sequence,
/// playing the resulting pixel like a metronome tick would. Only usable
/// while the synth is paused. The notes played by a manual step have a
/// fixed duration — the pixel's note length when note lengths are enabled,
/// otherwise the synth's own step period (metronome interval divided by
/// its tempo ratio) — after which a Note Off is sent.
#[tauri::command]
pub fn step_synth(
    app: AppHandle,
    id: u32,
    image_state: State<'_, ImageState>,
    synth_state: State<SynthState>,
    midi_state: State<MidiState>,
    metronome_state: State<'_, MetronomeState>,
) -> Result<(), AppError> {
    let bpm = metronome_state.bpm.load(Ordering::Relaxed).max(1) as u64;
    let interval_ms = 60_000u64 / bpm;

    let (port, channel, scheduled, generation, step_duration) = {
        let image_guard = image_state.processed.lock().unwrap();
        let image = match image_guard.as_ref() {
            Some(img) => img,
            None => return Err(err("no_processed_image")),
        };

        let mut synths = synth_state.synths.lock().unwrap();
        let synth = match synths.get_mut(&id) {
            Some(s) => s,
            None => return Err(err("synth_not_found").with_param("id", id)),
        };

        if synth.playing {
            return Err(err("synth_is_playing").with_param("id", id));
        }

        let played_length = step_synth_once(&app, synth, image, &midi_state);

        // Duration of the notes just played: the pixel's note length when
        // note lengths are enabled, otherwise the synth's regular step
        // period. Both are scaled by the tempo ratio (e.g. ratio 0.5 =
        // twice the metronome period).
        let ratio = if synth.tempo_ratio > 0.0 { synth.tempo_ratio } else { 1.0 };
        let beats = played_length.unwrap_or(1.0);
        let step_duration = ((interval_ms as f64) * beats / ratio).round().max(1.0) as u64;

        // Capture the notes that are now sounding, to schedule their Note Off
        let mut scheduled = Vec::new();
        if synth.note_is_on {
            scheduled.push(synth.note);
        }
        for voice in &synth.poly_voices {
            if voice.note_is_on {
                scheduled.push(voice.note);
            }
        }
        (synth.midi_port, synth.channel, scheduled, synth.note_generation, step_duration)
    };

    if scheduled.is_empty() {
        return Ok(());
    }

    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(step_duration));

        // Turn the captured notes off only if the synth is still paused and
        // still sounding those same articulation: a newer manual step (a
        // different note generation), a stop, or the metronome taking over
        // in the meantime cancels the cutoff.
        let synth_state = app.state::<SynthState>();
        let midi_state = app.state::<MidiState>();

        let mut synths = synth_state.synths.lock().unwrap();
        let synth = match synths.get_mut(&id) {
            Some(s) => s,
            None => return,
        };
        if synth.playing || synth.channel != channel || synth.note_generation != generation {
            return;
        }

        // The notes were sent on the captured port: even if the synth has
        // since changed ports, turn them off where they are sounding.
        if synth.note_is_on && scheduled.contains(&synth.note) {
            midi_state.note_off(port, channel, synth.note);
            synth.note_is_on = false;
        }
        for voice in synth.poly_voices.iter_mut() {
            if voice.note_is_on && scheduled.contains(&voice.note) {
                midi_state.note_off(port, channel, voice.note);
                voice.note_is_on = false;
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUNDS: [(u8, u8); 3] = [(21, 47), (48, 71), (72, 108)];

    #[test]
    fn relative_mapping_rescales_saturation_onto_the_bounds() {
        // min=40, max=90: the saturation range is compressed onto [40, 90]
        assert_eq!(saturation_to_velocity(0.0, 40, 90, true), 40);
        assert_eq!(saturation_to_velocity(255.0, 40, 90, true), 90);
        // Half saturation → halfway between the bounds
        assert_eq!(saturation_to_velocity(127.5, 40, 90, true), 65);
        // A nearly-gray pixel still lands inside the range
        assert_eq!(saturation_to_velocity(25.5, 40, 90, true), 45);
    }

    #[test]
    fn clamp_mapping_uses_the_full_range_then_clamps() {
        // min=40, max=90: native 1–127 mapping, values outside clamped
        // Weak saturation → below 40 → clamped to 40
        assert_eq!(saturation_to_velocity(0.0, 40, 90, false), 40);
        assert_eq!(saturation_to_velocity(25.5, 40, 90, false), 40); // ~14 → 40
        // In range → untouched
        assert_eq!(saturation_to_velocity(127.5, 40, 90, false), 64); // ~64
        // Strong saturation → above 90 → clamped to 90
        assert_eq!(saturation_to_velocity(255.0, 40, 90, false), 90);
        assert_eq!(saturation_to_velocity(229.5, 40, 90, false), 90); // ~114 → 90
    }

    #[test]
    fn no_range_enabled_uses_full_midi_range() {
        assert_eq!(rescale_into_range(0.0, &BOUNDS, &[false; 3]), 0);
        assert_eq!(rescale_into_range(0.5, &BOUNDS, &[false; 3]), 64);
        assert_eq!(rescale_into_range(1.0, &BOUNDS, &[false; 3]), 127);
    }

    #[test]
    fn single_range_rises_gradually_from_low_to_high() {
        // Medium only [48, 71]: hue 0° -> 48, hue 360° -> 71, no jumps
        let toggles = [false, true, false];
        assert_eq!(rescale_into_range(0.0, &BOUNDS, &toggles), 48);
        assert_eq!(rescale_into_range(1.0, &BOUNDS, &toggles), 71);
        let notes: Vec<u8> = (0..=100)
            .map(|i| rescale_into_range(i as f32 / 100.0, &BOUNDS, &toggles))
            .collect();
        for w in notes.windows(2) {
            let step = w[1] as i32 - w[0] as i32;
            assert!(step == 0 || step == 1, "expected a gradual rise, got {w:?}");
        }
    }

    #[test]
    fn two_ranges_skip_the_gap_and_stay_monotonic() {
        // Bass [21, 47] + treble [72, 108]: the sweep climbs the bass range
        // then the treble range, never landing in the 48–71 gap
        let toggles = [true, false, true];
        assert_eq!(rescale_into_range(0.0, &BOUNDS, &toggles), 21);
        assert_eq!(rescale_into_range(1.0, &BOUNDS, &toggles), 108);
        let notes: Vec<u8> = (0..=200)
            .map(|i| rescale_into_range(i as f32 / 200.0, &BOUNDS, &toggles))
            .collect();
        for w in notes.windows(2) {
            assert!(w[1] >= w[0], "expected a monotonic rise, got {w:?}");
            assert!(!(48..=71).contains(&w[1]), "note {w:?} landed in the disabled gap");
        }
    }

    #[test]
    fn overlapping_ranges_are_merged() {
        // Bass extended up to 60 overlaps the medium range: no note is
        // double-counted, the sweep stays continuous
        let bounds = [(21, 60), (48, 71), (72, 108)];
        let toggles = [true, true, false];
        assert_eq!(rescale_into_range(0.0, &bounds, &toggles), 21);
        assert_eq!(rescale_into_range(1.0, &bounds, &toggles), 71);
        assert_eq!(rescale_into_range(0.5, &bounds, &toggles), 46);
    }

    #[test]
    fn clamps_out_of_bounds_values() {
        let toggles = [true, false, false];
        assert_eq!(rescale_into_range(-1.0, &BOUNDS, &toggles), 21);
        assert_eq!(rescale_into_range(2.0, &BOUNDS, &toggles), 47);
    }

    /// A synth configured for a scale (used by the quantization tests).
    fn scaled_synth(scale: Scale, root: u8) -> Synth {
        let mut synth = Synth::new(1);
        synth.scale = scale;
        synth.scale_root = root;
        synth
    }

    #[test]
    fn snaps_to_the_nearest_degree_of_the_scale() {
        // C major, no range filter: every note lands on a scale tone
        let synth = scaled_synth(Scale::Major, 0);
        let allowed = allowed_pitches(&synth, &BOUNDS, &[false; 3]);
        // C#4 (61) is equidistant between C4 (60) and D4 (62): tie → lower
        assert_eq!(snap_to_allowed(61, &allowed), 60);
        // F#4 (66): equidistant between F4 (65) and G4 (67) → lower
        assert_eq!(snap_to_allowed(66, &allowed), 65);
        // A4 (69) is a scale tone: unchanged
        assert_eq!(snap_to_allowed(69, &allowed), 69);
        // Below the lowest degree and above the highest: clamped to the
        // nearest allowed pitch
        assert_eq!(snap_to_allowed(0, &allowed), 0);
        assert_eq!(snap_to_allowed(127, &allowed), 127);
    }

    #[test]
    fn scale_respects_the_root_and_the_enabled_ranges() {
        // A minor pentatonic, bass range [21, 47] only: allowed pitches
        // are the A-minor-pentatonic tones within [21, 47]
        let synth = scaled_synth(Scale::MinorPentatonic, 9); // A
        let allowed = allowed_pitches(&synth, &BOUNDS, &[true, false, false]);
        assert!(!allowed.is_empty());
        for &n in &allowed {
            // In the bass range…
            assert!((21..=47).contains(&n));
            // …and a minor pentatonic degree from A
            let rel = (n as i16 - 9).rem_euclid(12);
            assert!([0, 3, 5, 7, 10].contains(&rel));
        }
        // Snap stays inside the range: D4 (62) can't reach the scale tones
        // above it (all disabled ranges), so it lands on the highest
        // allowed pitch below it — 45 (A2), B not being in the scale
        assert_eq!(snap_to_allowed(62, &allowed), 45);
    }

    #[test]
    fn narrow_range_without_any_degree_falls_back_to_the_raw_note() {
        // Medium range manually narrowed to [61, 61] (a single C#4):
        // no C-major degree in it, the snap must leave the note alone
        let bounds = [(21, 47), (61, 61), (72, 108)];
        let synth = scaled_synth(Scale::Major, 0);
        let allowed = allowed_pitches(&synth, &bounds, &[false, true, false]);
        assert!(allowed.is_empty());
        assert_eq!(snap_to_allowed(61, &allowed), 61);
    }

    #[test]
    fn quantized_sweep_rises_monotonically() {
        // Full hue sweep quantized to C major pentatonic: the pitch never
        // decreases as the hue rises (snapping to a sorted set is monotonic)
        let synth = scaled_synth(Scale::MajorPentatonic, 0);
        let notes: Vec<u8> = (0..=200)
            .map(|i| effective_note_for(&synth, i as f32 / 200.0, &BOUNDS, &[false; 3]))
            .collect();
        for w in notes.windows(2) {
            assert!(w[1] >= w[0], "expected a monotonic rise, got {w:?}");
        }
        // Every landed note is a degree of the scale
        for &n in &notes {
            assert!([0, 2, 4, 7, 9].contains(&(n % 12)));
        }
    }

    #[test]
    fn chromatic_scale_leaves_the_rescaled_note_untouched() {
        // The default must reproduce the historical behavior exactly
        let synth = scaled_synth(Scale::Chromatic, 0);
        let toggles = [false, true, false];
        for i in 0..=100 {
            let normalized = i as f32 / 100.0;
            assert_eq!(
                effective_note_for(&synth, normalized, &BOUNDS, &toggles),
                rescale_into_range(normalized, &BOUNDS, &toggles),
            );
        }
    }

    #[test]
    fn sorted_reading_merges_zones_by_absolute_position() {
        // Zone B (bottom row) drawn first, zone A (top row) second
        let zones = [
            PixelZone { x: 1, y: 1, w: 3, h: 1 }, // row 1, cols 1–3
            PixelZone { x: 2, y: 0, w: 2, h: 1 }, // row 0, cols 2–3
        ];
        let (width, height) = (8usize, 2usize);

        // Zone-by-zone: B entirely, then A
        let per_zone = build_pixel_sequence(&zones, width, height, ReadingDirection::LeftToRight, false);
        assert_eq!(per_zone, vec![9, 10, 11, 2, 3]);

        // Sorted: one left→right sweep, row 0 first
        let sorted = build_pixel_sequence(&zones, width, height, ReadingDirection::LeftToRight, true);
        assert_eq!(sorted, vec![2, 3, 9, 10, 11]);

        // Right→left: rows ascending, columns descending
        let sorted_rtl = build_pixel_sequence(&zones, width, height, ReadingDirection::RightToLeft, true);
        assert_eq!(sorted_rtl, vec![3, 2, 11, 10, 9]);

        // Top→bottom: each column ascending, within a column top→bottom
        let sorted_ttb = build_pixel_sequence(&zones, width, height, ReadingDirection::TopToBottom, true);
        assert_eq!(sorted_ttb, vec![9, 2, 10, 3, 11]);
    }

    #[test]
    fn build_pixel_sequence_spiral_per_zone() {
        // A 3×3 zone: clockwise spiral from the top-left, then the same
        // zone counterclockwise (first step downward)
        let zones = [PixelZone { x: 0, y: 0, w: 3, h: 3 }];
        let (width, height) = (3usize, 3usize);

        // Clockwise: top row →, right column ↓, bottom row ←, left column ↑, center
        let cw = build_pixel_sequence(&zones, width, height, ReadingDirection::Spiral, false);
        assert_eq!(cw, vec![0, 1, 2, 5, 8, 7, 6, 3, 4]);

        // Counterclockwise: left column ↓, bottom row →, right column ↑, top row ←, center
        let ccw = build_pixel_sequence(&zones, width, height, ReadingDirection::SpiralReverse, false);
        assert_eq!(ccw, vec![0, 3, 6, 7, 8, 5, 2, 1, 4]);

        // Degenerate rectangles: a single row and a single column walk
        // each pixel exactly once, no duplicates
        let row = [PixelZone { x: 1, y: 1, w: 5, h: 1 }];
        assert_eq!(build_pixel_sequence(&row, 8, 4, ReadingDirection::Spiral, false), vec![9, 10, 11, 12, 13]);
        assert_eq!(build_pixel_sequence(&row, 8, 4, ReadingDirection::SpiralReverse, false), vec![9, 10, 11, 12, 13]);
        let col = [PixelZone { x: 2, y: 0, w: 1, h: 4 }];
        assert_eq!(build_pixel_sequence(&col, 8, 4, ReadingDirection::Spiral, false), vec![2, 10, 18, 26]);
        assert_eq!(build_pixel_sequence(&col, 8, 4, ReadingDirection::SpiralReverse, false), vec![2, 10, 18, 26]);

        // Zone by zone: the first zone's spiral entirely, then the second's
        let zones = [PixelZone { x: 0, y: 0, w: 2, h: 2 }, PixelZone { x: 3, y: 0, w: 2, h: 2 }];
        let per_zone = build_pixel_sequence(&zones, 5, 2, ReadingDirection::Spiral, false);
        assert_eq!(per_zone, vec![0, 1, 6, 5, 3, 4, 9, 8]);
    }

    #[test]
    fn build_pixel_sequence_spiral_sorted_is_global_over_the_selection() {
        // Two disjoint zones in the same bounding box: the sorted spiral
        // walks the box's spiral keeping only the selected pixels
        let zones = [
            PixelZone { x: 0, y: 0, w: 1, h: 3 }, // left column
            PixelZone { x: 2, y: 0, w: 1, h: 3 }, // right column
        ];
        let (width, height) = (3usize, 3usize);

        // Clockwise bounding-box spiral: 0,1,2,5,8,7,6,3,4 — with column 1
        // unselected, only the two selected columns remain, in spiral order
        let sorted = build_pixel_sequence(&zones, width, height, ReadingDirection::Spiral, true);
        assert_eq!(sorted, vec![0, 2, 5, 8, 6, 3]);

        // Counterclockwise: 0,3,6,7,8,5,2,1,4 filtered the same way
        let sorted_ccw = build_pixel_sequence(&zones, width, height, ReadingDirection::SpiralReverse, true);
        assert_eq!(sorted_ccw, vec![0, 3, 6, 8, 5, 2]);

        // Overlapping zones: each selected pixel appears exactly once
        // (deduplicated), unlike the linear directions which replay it
        let overlap = [
            PixelZone { x: 0, y: 0, w: 2, h: 2 },
            PixelZone { x: 1, y: 0, w: 1, h: 2 },
        ];
        let sorted_overlap = build_pixel_sequence(&overlap, width, height, ReadingDirection::Spiral, true);
        assert_eq!(sorted_overlap, vec![0, 1, 4, 3]);
    }

    #[test]
    fn remapped_cursor_keeps_the_playhead_pixel_across_sort_toggle() {
        // Two zones, one pixel each; playing the first zone's pixel
        let zones = [PixelZone { x: 5, y: 0, w: 1, h: 1 }, PixelZone { x: 1, y: 0, w: 1, h: 1 }];
        let synth = Synth::new(1); // cursor 0
        let (width, height) = (8usize, 1usize);

        // Playhead on pixel 5 (index 0 of the per-zone sequence)
        // Toggling sorted on: pixel 5 becomes index 1 of the new sequence
        let cursor = remapped_cursor(&synth, &zones, &zones, false, true, ReadingDirection::LeftToRight, ReadingDirection::LeftToRight, width, height);
        assert_eq!(cursor, 1);

        // Toggling back off: the playhead returns to index 0
        let mut synth = synth;
        synth.cursor = 1;
        let cursor = remapped_cursor(&synth, &zones, &zones, true, false, ReadingDirection::LeftToRight, ReadingDirection::LeftToRight, width, height);
        assert_eq!(cursor, 0);
    }

    #[test]
    fn remapped_cursor_keeps_the_playhead_pixel_across_direction_change() {
        // One full row zone, sorted reading; the playhead is on the
        // sequence's last pixel in left→right order
        let zones = [PixelZone { x: 0, y: 0, w: 4, h: 1 }];
        let mut synth = Synth::new(1);
        synth.cursor = 3;
        let (width, height) = (4usize, 2usize);

        // Same pixel (3) becomes index 0 when reading right→left
        let cursor = remapped_cursor(&synth, &zones, &zones, true, true, ReadingDirection::LeftToRight, ReadingDirection::RightToLeft, width, height);
        assert_eq!(cursor, 0);

        // And it is the last-but-one index when reading top→bottom of a
        // 2-row selection
        let zones = [PixelZone { x: 0, y: 0, w: 2, h: 2 }];
        let cursor = remapped_cursor(&synth, &zones, &zones, true, true, ReadingDirection::LeftToRight, ReadingDirection::TopToBottom, width, height);
        assert_eq!(cursor, 3);
    }
}
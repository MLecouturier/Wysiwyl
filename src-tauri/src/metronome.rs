use image::{DynamicImage, GenericImageView};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::ConfigState;
use crate::error::{err, AppError};
use crate::gate::{GateOff, GateState};
use crate::locks::MutexExt;
use crate::midi;
use crate::state::{
    CachedSequence, ImageState, MidiState, NoteLength, ReadingDirection, RowRun, Scale, Synth,
    SynthMode, SynthState, Zone,
};

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------
// Typed contracts for the events the backend emits, so the frontend's
// expected shape is stated in one place instead of ad-hoc json! values.

/// Payload of `synth-pixel-tick`: the state of one played pixel. Mono and
/// poly shapes coexist — `note`/`raw_note`/`hue` are set in monophonic
/// mode, `voices` in polyphonic mode, and the irrelevant optionals are
/// omitted from the JSON.
#[derive(Serialize, Clone)]
pub struct PixelTick {
    pub id: u32,
    pub cursor: usize,
    pub w: usize,
    pub h: usize,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
    pub brightness_level: u8,
    pub velocity: u8,
    pub mode: SynthMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_note: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hue: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voices: Option<Vec<VoiceTick>>,
    pub muted: bool,
}

/// One R/G/B voice of a polyphonic `PixelTick`.
#[derive(Serialize, Clone)]
pub struct VoiceTick {
    pub enabled: bool,
    pub note: u8,
    pub raw_note: u8,
    pub muted: bool,
}

/// Payload of `synth-stopped`.
#[derive(Serialize, Clone)]
pub struct SynthStopped {
    pub id: u32,
}

/// Payload of `metronome-sync`: only the fields relevant to the transition
/// are set (all optional, absent from the JSON when `None`).
#[derive(Serialize, Clone, Default)]
pub struct MetronomeSync {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master: Option<bool>,
}

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

    if hue < 0.0 {
        hue + 360.0
    } else {
        hue
    }
}

/// Maps a hue (0–360°) to a MIDI note 0–127.
fn hue_to_midi_note(hue: f32) -> u8 {
    ((hue / 360.0) * 127.0).round().clamp(0.0, 127.0) as u8
}

/// Maps a color channel value (0–255) to a MIDI note 0–127.
fn channel_to_midi_note(value: u8) -> u8 {
    ((value as f32 / 255.0) * 127.0).round() as u8
}

/// Maps a brightness value (0–255) to a MIDI level 0–127 (used for the
/// brightness→note-length mapping, independently of the note played).
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
/// like a manually silenced pixel.
#[allow(clippy::too_many_arguments)] // flat by design: the pixel context is threaded explicitly
fn process_monophonic(
    synth: &mut Synth,
    midi: &MidiState,
    note_range_bounds: &[(u8, u8); 3],
    r: u8,
    g: u8,
    b: u8,
    velocity: u8,
    payload: &mut PixelTick,
    retrigger: bool,
    manual_mute: bool,
) {
    let hue = pixel_hue(r, g, b);
    let shifted_hue = (hue + synth.config.hue_shift as f32) % 360.0;
    let raw_note = hue_to_midi_note(shifted_hue);
    // Rescale the hue proportionally across the enabled MIDI range filters,
    // then quantize to the synth's scale: the pitch rises gradually from
    // the low to the high bound of the allowed range as the hue increases,
    // landing only on scale degrees.
    let effective_note = effective_note_for(
        synth,
        shifted_hue / 360.0,
        note_range_bounds,
        &synth.config.mono_note_range,
    );

    let in_range = !manual_mute;

    // We only (re)trigger MIDI if the note actually changes or if its
    // audible status (muted / not muted) changes. Otherwise we let the
    // current note keep sounding without interruption (legato).
    let note_changed = effective_note != synth.playback.note || retrigger;
    let needs_off = synth.playback.note_is_on && (note_changed || !in_range);
    let needs_on = in_range && (!synth.playback.note_is_on || note_changed);

    if needs_off {
        midi.note_off(
            synth.config.midi_port,
            synth.config.channel,
            synth.playback.note,
        );
        synth.playback.note_is_on = false;
    }

    synth.playback.note = effective_note;
    synth.playback.active_note = in_range;

    if needs_on {
        midi.note_on(
            synth.config.midi_port,
            synth.config.channel,
            effective_note,
            velocity,
        );
        synth.playback.note_is_on = true;
        synth.playback.note_generation = synth.playback.note_generation.wrapping_add(1);
    }

    payload.note = Some(effective_note);
    payload.raw_note = Some(raw_note);
    payload.hue = Some(hue);
    payload.muted = !in_range;
}

/// Processes a pixel in polyphonic mode: each enabled R/G/B channel generates
/// its own independent note, forming a chord of 1 to 3 notes. `retrigger`
/// forces a re-articulation of every enabled voice on each pixel (used when
/// note lengths are enabled, see process_monophonic). `manual_mute` silences
/// the pixel by hand (rest): no voice is sounded, like a manually silenced
/// pixel.
#[allow(clippy::too_many_arguments)] // flat by design: the pixel context is threaded explicitly
fn process_polyphonic(
    synth: &mut Synth,
    midi: &MidiState,
    note_range_bounds: &[(u8, u8); 3],
    r: u8,
    g: u8,
    b: u8,
    velocity: u8,
    payload: &mut PixelTick,
    retrigger: bool,
    manual_mute: bool,
) {
    let channel_values = [r, g, b];
    let global_in_range = !manual_mute;

    // Pitch of each voice: rescale the channel value proportionally across
    // this voice's enabled range filters, then quantize to the synth's
    // scale (the pitch rises gradually from the low to the high bound of
    // the allowed range as the channel value increases, landing only on
    // scale degrees). `None` = the voice is silent on this pixel.
    let mut notes = [0u8; 3];
    let mut desired = [None; 3];
    for (i, &value) in channel_values.iter().enumerate() {
        notes[i] = effective_note_for(
            synth,
            value as f32 / 255.0,
            note_range_bounds,
            &synth.config.voice_note_ranges[i],
        );
        if synth.config.channel_enabled[i] && global_in_range {
            desired[i] = Some(notes[i]);
        }
    }

    let port = synth.config.midi_port;
    let channel = synth.config.channel;
    let plan = plan_poly_voices(&synth.playback.poly_voices, desired, retrigger);
    for &note in &plan.note_offs {
        midi.note_off(port, channel, note);
    }
    for &note in &plan.note_ons {
        midi.note_on(port, channel, note, velocity);
    }
    if !plan.note_ons.is_empty() {
        synth.playback.note_generation = synth.playback.note_generation.wrapping_add(1);
    }
    for (i, voice) in synth.playback.poly_voices.iter_mut().enumerate() {
        voice.note = notes[i];
        voice.note_is_on = plan.sounding[i];
    }

    let voices_payload = (0..3)
        .map(|i| VoiceTick {
            enabled: synth.config.channel_enabled[i],
            note: notes[i],
            raw_note: channel_to_midi_note(channel_values[i]),
            muted: desired[i].is_none(),
        })
        .collect();

    // global active_note: true if at least one voice is sounding (useful for the highlight/UI)
    synth.playback.active_note = synth.playback.poly_voices.iter().any(|v| v.note_is_on);

    payload.voices = Some(voices_payload);
    payload.muted = !global_in_range;
}

/// MIDI messages of one polyphonic step, and the resulting `note_is_on`
/// flag of each R/G/B voice.
#[derive(Debug, PartialEq, Eq)]
struct PolyPlan {
    note_offs: Vec<u8>,
    note_ons: Vec<u8>,
    sounding: [bool; 3],
}

/// Plans the MIDI messages of a polyphonic step from the voices' current
/// state and the pitch each one wants to sound (`None` = silent). All the
/// voices share one MIDI channel, so a pitch wanted by several voices is
/// played only once: one Note On, owned by a single voice (the one already
/// holding it when sustained, else the first). Two Note Ons of the same
/// pitch on one channel would otherwise be cut together by the first Note
/// Off, leaving the other voice believing its note still sounds.
///
/// A pitch that keeps sounding is held without re-articulation (legato),
/// unless `retrigger` forces a fresh attack (note lengths, gated
/// pizzicato). Every Note Off is sent before the Note Ons.
fn plan_poly_voices(
    voices: &[crate::state::ChannelVoice; 3],
    desired: [Option<u8>; 3],
    retrigger: bool,
) -> PolyPlan {
    let mut plan = PolyPlan {
        note_offs: Vec::new(),
        note_ons: Vec::new(),
        sounding: [false; 3],
    };
    let wanted = |note: u8| desired.contains(&Some(note));

    // Pitches currently sounding (deduplicated: legacy state may hold the
    // same pitch on two voices, a single Note Off releases both)
    let mut held: Vec<u8> = Vec::new();
    for voice in voices.iter().filter(|v| v.note_is_on) {
        if !held.contains(&voice.note) {
            held.push(voice.note);
        }
    }

    // Release what is no longer wanted, or everything on a retrigger
    for &note in &held {
        if retrigger || !wanted(note) {
            plan.note_offs.push(note);
        }
    }

    // Assign each wanted pitch to a single owner voice
    let mut assigned: Vec<u8> = Vec::new();
    // Sustained pitches first stay with the voice already holding them
    for (i, voice) in voices.iter().enumerate() {
        let Some(note) = desired[i] else { continue };
        if !retrigger && voice.note_is_on && voice.note == note && !assigned.contains(&note) {
            plan.sounding[i] = true;
            assigned.push(note);
        }
    }
    for (i, wanted_note) in desired.iter().enumerate() {
        let Some(note) = *wanted_note else { continue };
        if assigned.contains(&note) {
            continue;
        }
        plan.sounding[i] = true;
        assigned.push(note);
        // Held by another voice and not released above: it keeps sounding,
        // only its owner changes
        let still_held = held.contains(&note) && !plan.note_offs.contains(&note);
        if !still_held {
            plan.note_ons.push(note);
        }
    }
    plan
}

/// True when the pixel at (x, y) is covered by one of the given zones
/// (connected components, same convention as build_pixel_sequence).
fn pixel_in_zones(zones: &[Zone], x: u32, y: u32) -> bool {
    zones.iter().any(|z| z.contains(x, y))
}

/// The runs of a zone clipped to the image bounds (defensive: zones are
/// normally already inside the grid, the frontend clips on its side).
fn clamped_runs(zone: &Zone, width: usize, height: usize) -> Vec<RowRun> {
    if width == 0 || height == 0 {
        return Vec::new();
    }
    zone.runs
        .iter()
        .filter_map(|r| {
            let y = r.y as usize;
            if y >= height || (r.x0 as usize) >= width {
                return None;
            }
            let x1 = (r.x1 as usize).min(width - 1) as u32;
            Some(RowRun { x1, ..*r })
        })
        .collect()
}

/// Pushes the pixels of a rectangle in a spiral order, from its
/// top-left corner toward its center: clockwise (`Spiral`, first step
/// to the right) or counterclockwise (`SpiralReverse`, first step
/// downward). The bounds shrink after each side; each loop iteration
/// must re-check them because odd-sized edges meet in the middle.
fn push_spiral_rect(
    sequence: &mut Vec<usize>,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    width: usize,
    clockwise: bool,
) {
    let (mut left, mut top, mut right, mut bottom) = (x0, y0, x1, y1);
    while left < right && top < bottom {
        if clockwise {
            for x in left..right {
                sequence.push(top * width + x);
            }
            top += 1;
            for y in top..bottom {
                sequence.push(y * width + right - 1);
            }
            right -= 1;
            if top < bottom {
                for x in (left..right).rev() {
                    sequence.push((bottom - 1) * width + x);
                }
                bottom -= 1;
            }
            if left < right {
                for y in (top..bottom).rev() {
                    sequence.push(y * width + left);
                }
                left += 1;
            }
        } else {
            for y in top..bottom {
                sequence.push(y * width + left);
            }
            left += 1;
            for x in left..right {
                sequence.push((bottom - 1) * width + x);
            }
            bottom -= 1;
            if left < right {
                for y in (top..bottom).rev() {
                    sequence.push(y * width + right - 1);
                }
                right -= 1;
            }
            if top < bottom {
                for x in (left..right).rev() {
                    sequence.push(top * width + x);
                }
                top += 1;
            }
        }
    }
}

/// Builds the flat, ordered list of pixel indices covered by the synth's
/// zones (connected components). By default each component is read in
/// full, one after the other in creation order (ties broken by the
/// top-left corner), following the reading direction: run by run for
/// the horizontal directions, column by column for the vertical ones,
/// and with a spiral over the component's bounding box (filtered to its
/// exact cells) for the two spiral directions. With `sorted` the pixels
/// of all zones are merged and ordered by their absolute position in
/// the image (in the reading direction) — one continuous sweep instead
/// of per-component blocks — except for the spiral directions, where
/// the spiral is computed globally over the whole selection (bounding
/// box spiral, filtered to the selected pixels, deduplicated): a
/// scattered selection then reads in a seemingly random yet
/// reproducible order. An empty zone list yields an empty sequence
/// (nothing selected); zones are clipped to the image bounds.
pub(crate) fn build_pixel_sequence(
    zones: &[Zone],
    width: usize,
    height: usize,
    direction: ReadingDirection,
    sorted: bool,
) -> Vec<usize> {
    let mut sequence = Vec::new();

    // Canonical reading order of the components: creation order, then
    // top-left corner
    let mut ordered: Vec<&Zone> = zones.iter().collect();
    ordered.sort_by_key(|z| (z.order, z.top_left()));

    // The runs of every zone, clipped to the image (the defensive clamp
    // of the historical rectangle iteration)
    let per_zone: Vec<Vec<RowRun>> = ordered
        .iter()
        .map(|z| clamped_runs(z, width, height))
        .collect();

    // All the selected pixels of a run list, as absolute indices
    fn runs_pixels(runs: &[RowRun], width: usize) -> impl Iterator<Item = usize> + '_ {
        runs.iter().flat_map(move |r| {
            ((r.x0 as usize)..=(r.x1 as usize)).map(move |x| r.y as usize * width + x)
        })
    }

    // Column-major view of a run list: per column (ascending), the rows
    // covering it (ascending) — the transpose of the runs. Used by the
    // vertical reading directions, like the historical column-by-column
    // iteration over rectangles.
    let column_runs = |runs: &[RowRun]| -> BTreeMap<usize, Vec<usize>> {
        let mut by_col: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for r in runs {
            for x in (r.x0 as usize)..=(r.x1 as usize) {
                by_col.entry(x).or_default().push(r.y as usize);
            }
        }
        by_col
    };

    match direction {
        ReadingDirection::Spiral | ReadingDirection::SpiralReverse => {
            let clockwise = direction == ReadingDirection::Spiral;
            if sorted {
                // Global spiral: sweep the bounding box of every zone,
                // keeping only the selected pixels (deduplicated — a pixel
                // covered by overlapping zones would otherwise break the
                // spiral)
                let selected: HashSet<usize> = per_zone
                    .iter()
                    .flat_map(|runs| runs_pixels(runs, width))
                    .collect();
                if selected.is_empty() {
                    return sequence;
                }
                // Bounding box of the zones (the sweep may cover unselected
                // pixels; membership filtering happens afterwards)
                let left = per_zone
                    .iter()
                    .flat_map(|runs| runs.iter().map(|r| r.x0 as usize))
                    .min()
                    .unwrap_or(0);
                let right = per_zone
                    .iter()
                    .flat_map(|runs| runs.iter().map(|r| r.x1 as usize + 1))
                    .max()
                    .unwrap_or(0);
                let top = per_zone
                    .iter()
                    .flat_map(|runs| runs.iter().map(|r| r.y as usize))
                    .min()
                    .unwrap_or(0);
                let bottom = per_zone
                    .iter()
                    .flat_map(|runs| runs.iter().map(|r| r.y as usize + 1))
                    .max()
                    .unwrap_or(0);
                let mut spiral = Vec::with_capacity(selected.len());
                push_spiral_rect(&mut spiral, left, top, right, bottom, width, clockwise);
                sequence = spiral
                    .into_iter()
                    .filter(|p| selected.contains(p))
                    .collect();
            } else {
                // Per-component spiral over the component's bounding box,
                // filtered to its exact cells — the generalization of the
                // historical per-rectangle spiral
                for runs in &per_zone {
                    if runs.is_empty() {
                        continue;
                    }
                    let selected: HashSet<usize> = runs_pixels(runs, width).collect();
                    let left = runs.iter().map(|r| r.x0 as usize).min().unwrap();
                    let right = runs.iter().map(|r| r.x1 as usize + 1).max().unwrap();
                    let top = runs.iter().map(|r| r.y as usize).min().unwrap();
                    let bottom = runs.iter().map(|r| r.y as usize + 1).max().unwrap();
                    let mut spiral = Vec::with_capacity(selected.len());
                    push_spiral_rect(&mut spiral, left, top, right, bottom, width, clockwise);
                    sequence.extend(spiral.into_iter().filter(|p| selected.contains(p)));
                }
            }
            return sequence;
        }
        ReadingDirection::LeftToRight => {
            for runs in &per_zone {
                sequence.extend(runs_pixels(runs, width));
            }
        }
        ReadingDirection::RightToLeft => {
            for runs in &per_zone {
                for r in runs {
                    for x in ((r.x0 as usize)..=(r.x1 as usize)).rev() {
                        sequence.push(r.y as usize * width + x);
                    }
                }
            }
        }
        ReadingDirection::TopToBottom => {
            for runs in &per_zone {
                for (x, rows) in column_runs(runs) {
                    for &y in &rows {
                        sequence.push(y * width + x);
                    }
                }
            }
        }
        ReadingDirection::BottomToTop => {
            for runs in &per_zone {
                for (x, rows) in column_runs(runs) {
                    for &y in rows.iter().rev() {
                        sequence.push(y * width + x);
                    }
                }
            }
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
            ReadingDirection::RightToLeft => {
                sequence.sort_unstable_by_key(|&p| (p / width, std::cmp::Reverse(p % width)))
            }
            ReadingDirection::TopToBottom => {
                sequence.sort_unstable_by_key(|&p| (p % width, p / width))
            }
            ReadingDirection::BottomToTop => {
                sequence.sort_unstable_by_key(|&p| (p % width, std::cmp::Reverse(p / width)))
            }
            ReadingDirection::Spiral | ReadingDirection::SpiralReverse => {
                unreachable!("handled above")
            }
        }
    }
    sequence
}

/// Computes the sequence index of the pixel currently under the synth's
/// playhead, once its sequence has changed (zones edited, sorted reading
/// or reading direction changed): keeps the playhead on the same pixel
/// instead of restarting at the beginning. When that pixel is no longer
/// selected, the playhead continues on the next still-selected pixel of
/// the old reading order (in its travel direction, wrapping around), and
/// only restarts at the beginning when nothing of the old sequence
/// survives (or when either sequence is empty).
#[allow(clippy::too_many_arguments)] // flat by design: the pixel context is threaded explicitly
pub(crate) fn remapped_cursor(
    synth: &Synth,
    old_zones: &[Zone],
    new_zones: &[Zone],
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
    let new_seq = build_pixel_sequence(new_zones, width, height, new_direction, new_sorted);
    if new_seq.is_empty() {
        return 0;
    }
    // Index of every selected pixel in the new sequence: O(1) lookups
    // keep the walk below linear
    let index_of: HashMap<usize, usize> =
        new_seq.iter().enumerate().map(|(i, &p)| (p, i)).collect();
    let len = old_seq.len();
    let pos = synth.playback.cursor % len;
    // Same pixel still selected: the playhead stays exactly where it is
    if let Some(&idx) = index_of.get(&old_seq[pos]) {
        return idx;
    }
    // Playhead pixel deselected: walk the old sequence in the synth's
    // travel direction (a back-and-forth synth may be travelling
    // backwards) and land on the first still-selected pixel, wrapping
    // around like the looping playhead
    let step = if synth.playback.play_forward {
        1
    } else {
        len - 1
    };
    let mut i = (pos + step) % len;
    for _ in 0..len - 1 {
        if let Some(&idx) = index_of.get(&old_seq[i]) {
            return idx;
        }
        i = (i + step) % len;
    }
    // Nothing of the old sequence survives: start the new reading at its
    // beginning
    0
}

/// Whether the pixel's articulation must force a re-articulation (Note Off
/// of the previous note + Note On of the new one) even when the note did not
/// change. Note lengths already retrigger every pixel, unless the legato tie
/// is on (identical consecutive notes are then held as one). Pizzicato
/// without a minimum gate retriggers through its immediate Note Off clearing
/// `note_is_on`; pizzicato with a gate keeps `note_is_on` set until the
/// scheduled Note Off, so it must force the retrigger explicitly.
fn articulation_retrigger(
    note_lengths_enabled: bool,
    note_sustain: bool,
    note_legato: bool,
    gate_ms: u32,
) -> bool {
    (note_lengths_enabled && !note_legato) || (!note_sustain && gate_ms > 0)
}

/// Queues a deferred Note Off, after `delay`, for every note the synth is
/// currently sounding (see gate.rs). Cancelled automatically if a newer
/// articulation or a release bumps the note generation in the meantime.
fn schedule_note_offs(app: &AppHandle, synth: &Synth, delay: Duration, skip_if_playing: bool) {
    let mono = synth.playback.note_is_on.then_some(synth.playback.note);
    let poly: Vec<u8> = synth
        .playback
        .poly_voices
        .iter()
        .filter(|voice| voice.note_is_on)
        .map(|voice| voice.note)
        .collect();
    if mono.is_none() && poly.is_empty() {
        return;
    }
    app.state::<GateState>().schedule(GateOff {
        synth_uid: synth.uid,
        generation: synth.playback.note_generation,
        port: synth.config.midi_port,
        channel: synth.config.channel,
        mono,
        poly,
        deadline: Instant::now() + delay,
        skip_if_playing,
    });
}

/// Global configuration values read by every step, snapshotted once per
/// wake before the image and synth locks are taken: the config lock is
/// never held under them (see locks.rs), so a config save on disk can no
/// longer stall the tick.
#[derive(Clone, Copy)]
struct TickConfig {
    note_range_bounds: [(u8, u8); 3],
    gate_ms: u32,
}

impl TickConfig {
    fn read(app: &AppHandle) -> Self {
        let config = app.state::<ConfigState>();
        let config = config.config.lock_safe();
        Self {
            note_range_bounds: config.note_range_bounds,
            gate_ms: config.pizzicato_gate_ms,
        }
    }
}

/// Sequence index of the pixel under the playhead once the grid
/// dimensions changed. Zones are grid coordinates, kept (clipped) as-is
/// across a column-count change, so the playhead stays on the same (x, y)
/// cell when it still exists in the new sequence; otherwise it restarts.
fn cursor_after_resize(old: &CachedSequence, cursor: usize, new: &CachedSequence) -> usize {
    if old.sequence.is_empty() || old.width == 0 {
        return 0;
    }
    let pixel = old.sequence[cursor % old.sequence.len()];
    let (x, y) = (pixel % old.width, pixel / old.width);
    if x >= new.width || y >= new.height {
        return 0;
    }
    let target = y * new.width + x;
    new.sequence.iter().position(|&p| p == target).unwrap_or(0)
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
    tick: TickConfig,
) -> Option<f64> {
    let width = image.width() as usize;
    let height = image.height() as usize;

    // Flat sequence of pixels covered by the synth's zones, in the synth's
    // reading direction (sorted or per-zone blocks depending on
    // sorted_reading). The cursor is an index into this sequence; zones
    // partially outside the image are clipped, and an empty zone list
    // (nothing selected) leaves a paused synth stalled.
    //
    // The sequence is cached on the synth and rebuilt only when the grid
    // dimensions change: rebuilding it every tick is O(selection) and
    // dominated large selections. Zone/direction/sorted edits invalidate
    // the cache explicitly (Synth::invalidate_sequence).
    if synth
        .playback
        .cached_sequence
        .as_ref()
        .is_none_or(|c| c.width != width || c.height != height)
    {
        let sequence = build_pixel_sequence(
            &synth.zones,
            width,
            height,
            synth.config.reading_direction,
            synth.config.sorted_reading,
        );
        let rebuilt = CachedSequence {
            width,
            height,
            sequence,
        };
        // A grid resize (not an explicit invalidation, which remaps the
        // cursor itself): keep the playhead on the same cell
        if let Some(old) = synth.playback.cached_sequence.as_ref() {
            synth.playback.cursor = cursor_after_resize(old, synth.playback.cursor, &rebuilt);
        }
        synth.playback.cached_sequence = Some(rebuilt);
    }
    let sequence = &synth
        .playback
        .cached_sequence
        .as_ref()
        .expect("just built")
        .sequence;
    let seq_len = sequence.len();

    // Deferred end of a non-looping sequence: end_pending means the last
    // pixel was played on the previous tick and its note has now rung for
    // a full step period — stop the synth. A playing synth whose zones
    // were emptied (or fully clipped away) mid-playback stops the same
    // way: without this the tick would silently stall, leaving the
    // sounding note on forever and the UI in its playing state.
    if seq_len == 0 || (synth.playback.end_pending && !synth.config.loop_enabled) {
        if synth.playback.playing {
            // Stop, release the sounding notes (cancelling any pending
            // gate) and rewind for the next start
            synth.stop_playback(midi);
            synth.playback.cursor = 0;
            synth.playback.play_forward = true;
            let _ = app.emit("synth-stopped", SynthStopped { id: synth.id });
        }
        return None;
    }

    let pos = synth.playback.cursor % seq_len;

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
        synth.config.velocity_min,
        synth.config.velocity_max,
        synth.config.velocity_relative,
    );
    synth.playback.velocity = velocity;

    // Note lengths: when enabled, the pixel's brightness picks a duration
    // among the enabled lengths and each pixel is played as a distinct
    // note of that fixed duration (no legato). Empty list = all quarter
    // notes, i.e. the historical legato behavior. The duration applies
    // even to muted pixels, so the rhythm structure stays consistent.
    let note_length = if synth.config.note_lengths.is_empty() {
        None
    } else {
        Some(pick_note_length(synth, brightness_level))
    };

    // User-configurable note-range bounds (bass, medium, treble) and the
    // pizzicato minimum gate, both from the global configuration snapshot.
    let TickConfig {
        note_range_bounds,
        gate_ms,
    } = tick;

    // Pizzicato with a minimum gate keeps `note_is_on` set until the
    // scheduled Note Off, so it must force a re-articulation on every pixel:
    // otherwise a run of identical pixels would hold one note instead of
    // plucking each. With note lengths enabled the retrigger is already on,
    // unless the legato tie is on (identical notes are then held).
    let retrigger = articulation_retrigger(
        note_length.is_some(),
        synth.config.note_sustain,
        synth.config.note_legato,
        gate_ms,
    );

    // The grid dimensions travel with the cursor so the frontend and the
    // projection mirror decode the absolute pixel index against the grid
    // it was computed on — they stay in sync even when the column count
    // changes while synths are playing
    let mut payload = PixelTick {
        id: synth.id,
        cursor: pixel_index,
        w: width,
        h: height,
        r,
        g,
        b,
        a,
        brightness_level,
        velocity,
        mode: synth.config.mode,
        note: None,
        raw_note: None,
        hue: None,
        voices: None,
        muted: false,
    };

    match synth.config.mode {
        SynthMode::Monophonic => {
            process_monophonic(
                synth,
                midi,
                &note_range_bounds,
                r,
                g,
                b,
                velocity,
                &mut payload,
                retrigger,
                manual_mute,
            );
        }
        SynthMode::Polyphonic => {
            process_polyphonic(
                synth,
                midi,
                &note_range_bounds,
                r,
                g,
                b,
                velocity,
                &mut payload,
                retrigger,
                manual_mute,
            );
        }
    }

    // Pizzicato: with the sustain disabled, release the notes right after
    // their articulation. Without a minimum gate the Note Off is sent
    // immediately (historical behavior): the instrument's natural decay
    // shapes the tail, and clearing note_is_on makes every following pixel
    // re-articulate. With a minimum gate the Note Off is deferred by
    // `pizzicato_gate_ms` through the scheduler, so a software synth whose
    // envelope needs time to rise produces a real pluck; the note_is_on
    // flags stay set and the forced retrigger above turns the previous note
    // off (bumping the generation, cancelling the stale gate). The playback
    // rhythm is unchanged: note lengths still pace the pixels.
    if !synth.config.note_sustain {
        if gate_ms == 0 {
            synth.release_notes(midi);
        } else {
            schedule_note_offs(app, synth, Duration::from_millis(gate_ms as u64), false);
        }
    }

    let _ = app.emit("synth-pixel-tick", payload);

    // Then advance the playhead for the next step, following the current
    // travel direction: back-and-forth reverses it at the sequence bounds,
    // loop wraps around (in the travel direction), and a one-shot sequence
    // raises end_pending so the next tick stops the synth after the final
    // note has rung for a full step.
    let mut forward = synth.playback.play_forward;
    let at_end = forward && pos + 1 >= seq_len;
    let at_start = !forward && pos == 0;

    let next = if at_end || at_start {
        if synth.config.loop_enabled {
            if at_end {
                0
            } else {
                seq_len - 1
            }
        } else if synth.config.back_and_forth {
            forward = !forward;
            if at_end {
                if seq_len > 1 {
                    pos - 1
                } else {
                    pos
                }
            } else {
                if seq_len > 1 {
                    pos + 1
                } else {
                    pos
                }
            }
        } else {
            pos // end of a one-shot sequence: end_pending stops on the next tick
        }
    } else if forward {
        pos + 1
    } else {
        pos - 1
    };

    synth.playback.play_forward = forward;
    synth.playback.cursor = next;
    synth.playback.end_pending =
        (at_end || at_start) && !synth.config.loop_enabled && !synth.config.back_and_forth;

    note_length
}

/// Musical cycle of a per-synth tempo ratio, in master beats: the smallest
/// `q` (1-8) such that `ratio * q` is a whole number of steps, i.e. after `q`
/// master beats the synth's steps realign on the beat. The UI ratios are
/// simple fractions (1/2, 2/3, 3/4, 1, 5/4, 4/3, 3/2) whose stored decimals
/// (0.66, 1.33) are approximations, hence the tolerance. Falls back to 1 when
/// no small cycle fits (arbitrary hand-edited ratio).
fn ratio_cycle_beats(ratio: f64) -> u64 {
    for q in 1..=8u64 {
        let steps = ratio * q as f64;
        if (steps - steps.round()).abs() < 0.03 {
            return q;
        }
    }
    1
}

/// Effective master-tempo quantize period, in beats: the user's period
/// rounded up to the next multiple of the ratio's cycle, so every resync
/// boundary lands on a natural step of the synth. Without this the boundary
/// can fall mid-cycle and, since the quantize is delay-only, hold a step —
/// producing a rhythmic hole instead of a clean realignment.
fn effective_quantize_period(ratio: f64, beats: u8) -> u64 {
    let cycle = ratio_cycle_beats(ratio);
    let beats = beats.max(1) as u64;
    beats.div_ceil(cycle) * cycle
}

/// Smallest resync boundary strictly after `wake`: a multiple of
/// `beats * WAKES_PER_BEAT` wakes. `beats` is the quantize period in
/// master beats.
fn next_resync_boundary(wake: u64, beats: u64) -> u64 {
    let period = beats.max(1) * WAKES_PER_BEAT;
    (wake / period + 1) * period
}

/// Whether a due step must be held until the next resync boundary: true
/// when the boundary falls before the following step (closer than the
/// interval of the step that just completed). A step landing exactly on a
/// boundary is never held. Delay-only: a step is never advanced, so a
/// sounding note is never cut by the quantize.
fn should_hold_for_quantize(wake: u64, beats: u64, interval_wakes: u32) -> bool {
    let period = beats.max(1) * WAKES_PER_BEAT;
    if wake.is_multiple_of(period) {
        return false;
    }
    next_resync_boundary(wake, beats) - wake < interval_wakes.max(1) as u64
}

/// Duration of a note length, in beats of the synth's own tempo. When
/// `ternary` is set the length is played as a triplet (3 in the time of
/// 2), i.e. its nominal value is multiplied by 2/3.
fn length_beats(length: NoteLength, ternary: bool) -> f64 {
    let base = match length {
        NoteLength::Whole => 4.0,
        NoteLength::Half => 2.0,
        NoteLength::Quarter => 1.0,
        NoteLength::Eighth => 0.5,
        NoteLength::Sixteenth => 0.25,
    };
    if ternary {
        base * 2.0 / 3.0
    } else {
        base
    }
}

/// Maps the pixel's brightness level (0–127) to a duration among the
/// enabled note lengths: the level range is split into as many equal
/// bands as enabled lengths. By default the darkest band gets the
/// shortest length and the brightest the longest; `note_length_reversed`
/// flips the direction.
fn pick_note_length(synth: &Synth, brightness_level: u8) -> f64 {
    let mut lengths: Vec<f64> = synth
        .config
        .note_lengths
        .iter()
        .map(|&l| length_beats(l, synth.config.note_length_ternary))
        .collect();
    if synth.config.note_length_reversed {
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
    let intervals = scale_intervals(synth.config.scale);
    let ranges = merged_note_ranges(bounds, toggles);
    let ranges = if ranges.is_empty() {
        vec![(0u8, 127u8)]
    } else {
        ranges
    };
    let mut out = Vec::new();
    for &(lo, hi) in &ranges {
        for note in lo..=hi {
            let rel = (note as i16 - synth.config.scale_root as i16).rem_euclid(12) as u8;
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
            let lower = if idx > 0 {
                Some(allowed[idx - 1])
            } else {
                None
            };
            let upper = allowed.get(idx).copied();
            match (lower, upper) {
                (Some(lo), Some(hi)) => {
                    if note - lo <= hi - note {
                        lo
                    } else {
                        hi
                    }
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
    if synth.config.scale == Scale::Chromatic {
        note
    } else {
        snap_to_allowed(note, &allowed_pitches(synth, bounds, toggles))
    }
}

/// Source of the metronome's timing: the internal tempo, or a MIDI
/// clock. Persisted in the config file (snake_case) and applied at
/// startup; runtime changes go through the `set_clock_mode` command.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClockMode {
    /// Follow any incoming MIDI clock, engaging opportunistically (the
    /// historical behavior).
    Auto,
    /// Internal tempo only: incoming clock messages are ignored.
    Off,
    /// Broadcast a MIDI clock (24 ppqn) to every output port while the
    /// metronome runs, with Start/Stop transport messages on play/stop.
    Master,
    /// Follow the MIDI clock of one chosen input port only.
    Input,
}

impl ClockMode {
    /// Compact encoding for the atomic the metronome thread reads on
    /// every wake (atomics avoid lock contention with the timing loop).
    fn encode(self) -> u8 {
        match self {
            ClockMode::Auto => 0,
            ClockMode::Off => 1,
            ClockMode::Master => 2,
            ClockMode::Input => 3,
        }
    }

    fn decode(value: u8) -> Self {
        match value {
            1 => ClockMode::Off,
            2 => ClockMode::Master,
            3 => ClockMode::Input,
            _ => ClockMode::Auto,
        }
    }
}

/// DAW clock sync state: a MIDI clock (24 pulses per quarter note) streamed
/// by a DAW or any external device drives the metronome's tempo while the
/// pulses keep arriving. All fields are atomics so the MIDI input callbacks
/// (which produce the pulses) and the metronome thread (which consumes
/// them) never contend on a lock.
#[derive(Clone, Default)]
pub struct ClockState {
    /// Total number of clock pulses seen since launch (monotonic).
    pub pulses: Arc<AtomicU64>,
    /// Pulse count at the last boundary: the metronome wakes every
    /// PULSES_PER_WAKE pulses past the anchor (24 ppqn → one wake).
    /// Re-anchored by a Start/Continue message so the grid aligns with the
    /// sender's beats.
    pub anchor: Arc<AtomicU64>,
    /// Wall-clock time (ns since the Unix epoch) of the last pulse, to
    /// detect a streaming clock and a stopped one.
    pub last_pulse_ns: Arc<AtomicU64>,
    /// Smoothed pulse period (ns), an exponential moving average of the
    /// observed intervals — the tempo is derived from it.
    pub period_ns: Arc<AtomicU64>,
    /// Set by a Start/Continue message: the metronome thread adopts
    /// `start_wake` as its wake counter (the anchor is already set by the
    /// input handler so the next wake fires on the sender's next pulse).
    pub started: Arc<AtomicBool>,
    /// Wake counter (position within the beat, 0..12) of the first wake
    /// after a Start (0) or a Continue (the Song Position Pointer's).
    pub start_wake: Arc<AtomicU64>,
    /// The sender's beat phase, learned from its last Start/Continue:
    /// `phase + 1`, 0 = unknown. The pulse that makes the counter reach `n`
    /// sits at position `(n - phase) mod 24` within the sender's beat.
    pub beat_phase: Arc<AtomicU64>,
    /// Last Song Position Pointer received (in MIDI beats = sixteenth
    /// notes), `+ 1`, 0 = none pending. Consumed by the next Continue.
    pub song_position: Arc<AtomicU64>,
    /// Set by a MIDI Stop message (0xFC): the metronome thread falls back
    /// to its internal tempo immediately instead of waiting for the pulse
    /// timeout. Cleared by a pulse or a Start/Continue message.
    pub stopped: Arc<AtomicBool>,
}

/// MIDI clock pulses per beat (24 ppqn).
const PULSES_PER_BEAT: u64 = 24;

/// MIDI clock pulses per Song Position Pointer unit (a sixteenth note).
const PULSES_PER_SPP_UNIT: u64 = 6;

impl ClockState {
    /// The sender's beat phase (see `beat_phase`), if a transport message
    /// taught it.
    fn beat_origin(&self) -> Option<u64> {
        self.beat_phase.load(Ordering::Acquire).checked_sub(1)
    }

    /// Re-anchors the grid on a transport message: the next pulse is at
    /// `position` (0..24, a multiple of PULSES_PER_WAKE) within the
    /// sender's beat. The next wake fires on that pulse.
    fn anchor_transport(&self, position: u64) {
        let pulses = self.pulses.load(Ordering::Acquire);
        let position = position % PULSES_PER_BEAT;
        self.anchor
            .store(pulses.wrapping_sub(PULSES_PER_WAKE - 1), Ordering::Release);
        self.start_wake
            .store(position / PULSES_PER_WAKE, Ordering::Release);
        let phase = (pulses % PULSES_PER_BEAT + 1 + PULSES_PER_BEAT - position) % PULSES_PER_BEAT;
        self.beat_phase.store(phase + 1, Ordering::Release);
        self.started.store(true, Ordering::Release);
        self.stopped.store(false, Ordering::Relaxed);
    }
}

/// Position within the beat (0..24) of the pulse that made the counter
/// reach `count`, for a sender of the given beat phase.
fn pulse_position(count: u64, phase: u64) -> u64 {
    (count % PULSES_PER_BEAT + PULSES_PER_BEAT - phase % PULSES_PER_BEAT) % PULSES_PER_BEAT
}

/// Internal timing resolution: one "wake" is 1/12 of a beat (a
/// triplet-sixteenth note), the coarsest grid that represents both the
/// binary note lengths (1/2, 1/4, 1/8, 1/16 of a beat) and the ternary
/// ones (triplets: 1/3, 2/3, 1/6 of a beat) exactly.
const WAKES_PER_BEAT: u64 = 12;

/// MIDI clock pulses per wake (24 ppqn ÷ 12 wakes per beat).
const PULSES_PER_WAKE: u64 = 2;

/// Tolerance for the tempo accumulator comparison: a twelfth of a beat is
/// not exactly representable in f64, so without it a step could slip by
/// one wake when the sum lands just below 1.0.
const ACC_EPSILON: f64 = 1e-9;

/// A clock pulse older than this means the clock stopped: the metronome
/// falls back to its internal tempo, keeping the last synced BPM.
const CLOCK_FALLBACK: Duration = Duration::from_millis(2_000);

/// A pulse seen more recently than this means a clock is streaming and
/// the metronome should engage sync on its next wake.
const CLOCK_ENGAGE_WINDOW: Duration = Duration::from_millis(750);

/// Current wall-clock time in ns since the Unix epoch.
fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

/// Registers one MIDI clock pulse (0xF8, 24 ppqn): counts it and smooths
/// the observed interval into the period estimate. `now_ns` is the
/// wall-clock time in ns (separated so the math is testable).
fn register_pulse(clock: &ClockState, now_ns: u64) {
    let previous = clock.last_pulse_ns.swap(now_ns, Ordering::Relaxed);
    clock.pulses.fetch_add(1, Ordering::Relaxed);
    if previous == 0 {
        return; // first pulse ever: no interval to measure yet
    }
    let interval = now_ns.saturating_sub(previous);
    // Plausible intervals only (at 20–300 BPM a pulse takes 8–500 ms):
    // the first real interval seeds the average, later ones are smoothed.
    if !(4_000_000..2_000_000_000).contains(&interval) {
        return;
    }
    let previous_period = clock.period_ns.load(Ordering::Relaxed);
    let smoothed = if previous_period == 0 {
        interval
    } else {
        (previous_period * 3 + interval) / 4
    };
    clock.period_ns.store(smoothed, Ordering::Relaxed);
}

/// Handles a MIDI clock pulse (0xF8) received on any input port. In
/// `Input` mode only pulses from the selected port are accepted; `Off`
/// and `Master` modes ignore incoming clocks entirely (in master mode
/// our own broadcast could otherwise loop back through a device set to
/// thru).
pub fn on_clock_pulse(state: &MetronomeState, input_name: &str) {
    if !state.clock_accepts(input_name) {
        return;
    }
    register_pulse(&state.clock, now_ns());
    // A pulse means the sender is streaming again
    state.clock.stopped.store(false, Ordering::Relaxed);
}

/// Handles a MIDI Start (0xFA) message: the sender's song restarts, its
/// next pulse is the first of a beat — re-anchors the grid so the
/// metronome's beats align with the sender's.
pub fn on_clock_start(state: &MetronomeState, input_name: &str) {
    if !state.clock_accepts(input_name) {
        return;
    }
    state.clock.song_position.store(0, Ordering::Release);
    state.clock.anchor_transport(0);
}

/// Handles a MIDI Continue (0xFB) message: the sender resumes from the
/// position given by its last Song Position Pointer (the start of a beat
/// when none was received) — re-anchors the grid on that position.
pub fn on_clock_continue(state: &MetronomeState, input_name: &str) {
    if !state.clock_accepts(input_name) {
        return;
    }
    let spp = state
        .clock
        .song_position
        .swap(0, Ordering::AcqRel)
        .saturating_sub(1);
    state.clock.anchor_transport(spp * PULSES_PER_SPP_UNIT);
}

/// Handles a MIDI Song Position Pointer (0xF2): remembers the position
/// (in sixteenth notes) the next Continue resumes from.
pub fn on_song_position(state: &MetronomeState, input_name: &str, sixteenths: u16) {
    if !state.clock_accepts(input_name) {
        return;
    }
    state
        .clock
        .song_position
        .store(sixteenths as u64 + 1, Ordering::Release);
}

/// Handles a MIDI Stop (0xFC) message: marks the clock stopped so the
/// metronome falls back to its internal tempo immediately instead of
/// waiting for the pulse timeout.
pub fn on_clock_stop(state: &MetronomeState, input_name: &str) {
    if !state.clock_accepts(input_name) {
        return;
    }
    state.clock.stopped.store(true, Ordering::Relaxed);
}

/// Tempo measured from the clock's smoothed pulse period (24 ppqn),
/// clamped to the metronome's BPM range. 0 means "unknown yet" (no
/// measurable interval has been observed).
fn measured_bpm(clock: &ClockState) -> u32 {
    let period = clock.period_ns.load(Ordering::Relaxed);
    if period == 0 {
        return 0;
    }
    let bpm = (2_500_000_000.0 / period as f64).round() as u32; // 60e9 / (24 × period)
    bpm.clamp(20, 300)
}

pub struct MetronomeState {
    /// True while a metronome thread should be running. The thread owning
    /// the current `generation` resets it when it exits.
    pub running: Arc<AtomicBool>,
    /// Incremented by every start and every stop: a thread keeps looping
    /// only while the generation it was spawned with is still current, so
    /// a stop immediately followed by a start can never leave two threads
    /// stepping the synths (the old one sees a stale generation and exits).
    generation: Arc<AtomicU64>,
    pub bpm: Arc<AtomicU32>,
    /// MIDI clock sync state, fed by the MIDI input callbacks and consumed
    /// by the metronome thread.
    pub clock: ClockState,
    /// Current clock mode, encoded as a u8 (see `ClockMode`): read by the
    /// metronome thread on every wake and changed by the UI at any time.
    mode: Arc<AtomicU8>,
    /// Input port name the sync follows in `Input` mode (exact match with
    /// the names reported by the MIDI input listeners). Rarely read or
    /// written, so a mutex is fine here.
    source: Arc<Mutex<Option<String>>>,
}

impl Default for MetronomeState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            bpm: Arc::new(AtomicU32::new(120)),
            clock: ClockState::default(),
            mode: Arc::new(AtomicU8::new(ClockMode::Auto.encode())),
            source: Arc::new(Mutex::new(None)),
        }
    }
}

impl MetronomeState {
    /// Current clock mode.
    pub fn clock_mode(&self) -> ClockMode {
        ClockMode::decode(self.mode.load(Ordering::Relaxed))
    }

    /// Applies a clock mode, and the input port it follows in `Input`
    /// mode.
    pub fn apply_clock_mode(&self, mode: ClockMode, source: Option<String>) {
        self.mode.store(mode.encode(), Ordering::Relaxed);
        *self.source.lock_safe() = source;
    }

    /// The input port name the clock sync follows in `Input` mode.
    pub fn clock_source(&self) -> Option<String> {
        self.source.lock_safe().clone()
    }

    /// Whether an incoming clock message from `input_name` should be
    /// handled, given the current clock mode.
    fn clock_accepts(&self, input_name: &str) -> bool {
        match self.clock_mode() {
            ClockMode::Auto => true,
            ClockMode::Input => self.clock_source().is_some_and(|s| s == input_name),
            ClockMode::Off | ClockMode::Master => false,
        }
    }

    /// Claims the right to start a metronome thread: returns the new
    /// generation, or `None` when a thread is already running. Atomic, so
    /// two concurrent starts spawn a single thread.
    fn claim_start(&self) -> Option<u64> {
        self.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        Some(self.generation.fetch_add(1, Ordering::AcqRel) + 1)
    }

    /// Requests the running thread to stop (it exits at its next wake).
    fn request_stop(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.running.store(false, Ordering::Release);
    }
}

/// Clears `running` when the metronome thread exits — normally or by a
/// panic — unless a newer thread has been started meanwhile. Without it a
/// panicking thread would leave `running` stuck at true, and every later
/// `start_metronome` would return early: the metronome could never run
/// again.
struct RunningGuard {
    running: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    mine: u64,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if self.generation.load(Ordering::Acquire) == self.mine {
            self.running.store(false, Ordering::Release);
        }
    }
}

/// Duration of one wake (1/12 beat) at `bpm`, in nanoseconds — exact to
/// the nanosecond: the historical whole-millisecond division
/// (`60000 / bpm / 12`) truncated twice and ran 1.6 % fast at 120 BPM
/// (41 ms instead of 41.67 ms) and up to 4 % fast at 300 BPM.
fn wake_period_ns(bpm: u32) -> u64 {
    60_000_000_000 / (bpm.max(1) as u64 * WAKES_PER_BEAT)
}

/// Absolute-deadline pacer: wakes are scheduled on a fixed timeline
/// (`next += period`) instead of sleeping a fixed duration after the work,
/// so the processing time of a wake (locks, MIDI, events) is absorbed
/// instead of accumulating into a tempo drift. A wake that falls more than
/// `MAX_LATE_WAKES` behind (system sleep, heavy load) re-anchors on the
/// present rather than firing a burst of catch-up steps.
struct Pacer {
    next: Instant,
}

/// A pacer this many wakes late re-anchors instead of catching up.
const MAX_LATE_WAKES: u32 = 4;

impl Pacer {
    fn new() -> Self {
        Self {
            next: Instant::now(),
        }
    }

    /// Re-anchors the timeline on the present (after a clock-sync period,
    /// where the pulses drove the wakes).
    fn reset(&mut self) {
        self.next = Instant::now();
    }

    /// Advances the timeline by `period` and returns the deadline to wait
    /// for. `now` is passed in so the policy is testable.
    fn advance(&mut self, period: Duration, now: Instant) -> Instant {
        self.next += period;
        if now > self.next + period * MAX_LATE_WAKES {
            self.next = now;
        }
        self.next
    }

    /// Advances by `period` and sleeps until the new deadline.
    fn wait(&mut self, period: Duration) {
        let deadline = self.advance(period, Instant::now());
        sleep_until(deadline);
    }
}

/// Sleeps until `deadline`: a coarse OS sleep up to ~1 ms before it, then
/// a short yield loop for the remainder, so the wake lands within tens of
/// microseconds of the deadline whatever the OS timer granularity.
fn sleep_until(deadline: Instant) {
    const SPIN: Duration = Duration::from_micros(1_000);
    loop {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let remaining = deadline - now;
        if remaining > SPIN {
            thread::sleep(remaining - SPIN);
        } else {
            thread::yield_now();
        }
    }
}

/// Advances one playing synth by one wake of the master grid: start sync,
/// tempo accumulator, master-tempo quantize, and the step itself.
fn tick_synth(
    app: &AppHandle,
    synth: &mut Synth,
    image: &DynamicImage,
    midi: &MidiState,
    tick: TickConfig,
    wake: u64,
) {
    // Start sync: the very first note waits for the next master beat
    // (wake % WAKES_PER_BEAT == 0) so playback begins in phase with the
    // metronome. With quantize on it waits for the next resync boundary
    // instead, so the very first step already lands on the cycle-aligned
    // grid (no initial held step). Nothing is accumulated while waiting;
    // the wake then plays the first pixel.
    if synth.playback.start_pending {
        let period = if synth.config.quantize {
            effective_quantize_period(synth.config.tempo_ratio, synth.config.quantize_beats)
                * WAKES_PER_BEAT
        } else {
            WAKES_PER_BEAT
        };
        if !wake.is_multiple_of(period) {
            return;
        }
        synth.playback.start_pending = false;
        synth.playback.tempo_accumulator = 0.0;
        synth.playback.wakes_since_step = 0;
        if let Some(length_beats) = step_synth_once(app, synth, image, midi, tick) {
            synth.playback.tempo_accumulator = 1.0 - length_beats;
        }
        return;
    }

    // Interval of the step being completed, in wakes: incremented on
    // every wake, reset when the synth steps. Used by the quantize
    // look-ahead below.
    synth.playback.wakes_since_step = synth.playback.wakes_since_step.saturating_add(1);

    // Tempo desynchronization: each wake adds a twelfth of the synth's
    // tempo ratio to its accumulator (one beat = 12 wakes); the synth
    // advances when at least one full step has accumulated (e.g. ratio
    // 0.5 = one pixel every two beats).
    synth.playback.tempo_accumulator += synth.config.tempo_ratio / WAKES_PER_BEAT as f64;
    if synth.playback.tempo_accumulator < 1.0 - ACC_EPSILON {
        return;
    }

    // Effective quantize period, in master beats: the user's period
    // rounded up to the ratio's cycle, so a boundary always coincides with
    // a natural step of the synth (see effective_quantize_period).
    let quantize_period = if synth.config.quantize {
        effective_quantize_period(synth.config.tempo_ratio, synth.config.quantize_beats)
    } else {
        0
    };

    // Master-tempo quantize: hold a due step until the next resync
    // boundary when that boundary falls before the following step.
    // Delay-only — a step is never advanced, so a sounding note is never
    // cut. With note lengths enabled the note that just elapsed is
    // released instead of being extended until the boundary — unless the
    // legato tie is on, where the note is meant to hold.
    if synth.config.quantize
        && should_hold_for_quantize(wake, quantize_period, synth.playback.wakes_since_step)
    {
        if !synth.config.note_lengths.is_empty() && !synth.config.note_legato {
            synth.release_notes(midi);
        }
        return;
    }

    // On a resync boundary the accumulator is reset cleanly (a fresh
    // phase anchor); otherwise the step is consumed and the fractional
    // overshoot carries over to the next step.
    let on_boundary =
        synth.config.quantize && wake.is_multiple_of(quantize_period * WAKES_PER_BEAT);
    let carry = if on_boundary {
        0.0
    } else {
        synth.playback.tempo_accumulator - 1.0
    };
    synth.playback.tempo_accumulator = carry;

    if let Some(length_beats) = step_synth_once(app, synth, image, midi, tick) {
        // Note lengths enabled: the played pixel occupies exactly its
        // note's duration. Rewind the accumulator so the next pixel is due
        // after `length_beats` beats of the synth's own tempo — keeping
        // the overshoot of this step, so a ratio off the wake grid (4/3,
        // 5/4...) does not drift against the master over time.
        synth.playback.tempo_accumulator = 1.0 - length_beats + carry;
    }
    synth.playback.wakes_since_step = 0;
}

#[tauri::command]
pub fn set_metronome_bpm(state: tauri::State<MetronomeState>, bpm: u32) {
    let clamped = bpm.clamp(20, 300);
    state.bpm.store(clamped, Ordering::Relaxed);
}

/// Sets the metronome's clock mode (and its input source in `Input`
/// mode): applies it live and persists it in the config file so it is
/// restored on the next launch. `Input` without a source falls back to
/// `Auto` (same sanitization as the config file).
#[tauri::command]
pub fn set_clock_mode(
    app: AppHandle,
    metronome: State<'_, MetronomeState>,
    config: State<'_, ConfigState>,
    mode: ClockMode,
    source: Option<String>,
) {
    let (mode, source) = match mode {
        ClockMode::Input if source.as_deref().is_some_and(|s| !s.trim().is_empty()) => {
            (ClockMode::Input, source.map(|s| s.trim().to_string()))
        }
        ClockMode::Input => (ClockMode::Auto, None),
        mode => (mode, None),
    };
    metronome.apply_clock_mode(mode, source.clone());
    // Snapshot under the lock, write the file outside of it (see locks.rs)
    let snapshot = {
        let mut cfg = config.config.lock_safe();
        cfg.clock_mode = mode;
        cfg.clock_source = source;
        cfg.clone()
    };
    crate::config::save_config(&app, &snapshot);
}

#[tauri::command]
pub fn start_metronome(app: AppHandle, state: tauri::State<MetronomeState>) {
    let Some(my_generation) = state.claim_start() else {
        return; // already running
    };

    let running = state.running.clone();
    let generation = state.generation.clone();
    let bpm = state.bpm.clone();
    let clock = state.clock.clone();
    let mode = state.mode.clone();

    let spawned = thread::Builder::new()
        .name("wysiwyl-metronome".into())
        .spawn(move || {
            let _guard = RunningGuard {
                running: running.clone(),
                generation: generation.clone(),
                mine: my_generation,
            };
            run_metronome(&app, &generation, my_generation, &bpm, &clock, &mode);
        });
    if spawned.is_err() {
        // No thread: release the claim so a later start can retry
        state.running.store(false, Ordering::Release);
    }
}

/// Body of the metronome thread: loops while `my_generation` is current.
fn run_metronome(
    app: &AppHandle,
    generation: &AtomicU64,
    my_generation: u64,
    bpm: &AtomicU32,
    clock: &ClockState,
    mode: &AtomicU8,
) {
    // One "wake" is 1/12 of a beat (a triplet-sixteenth note): wakes with
    // wake % WAKES_PER_BEAT == 0 are beat boundaries, reported to the UI
    // as metronome ticks. While a MIDI clock streams (clock_mode), the
    // wakes are driven by its pulses (PULSES_PER_WAKE per wake); in master
    // mode the thread broadcasts its own pulses (24 per quarter note) on
    // the same absolute timeline; otherwise it paces itself on its BPM.
    let mut wake: u64 = 0;
    let mut clock_mode = false;
    let mut last_pulses: u64 = 0;
    let mut last_synced_bpm: u32 = 0;
    let mut pacer = Pacer::new();
    // Whether this wake is broadcasting the master clock; transport
    // messages (Start/Stop) are sent on the engage/disengage transitions,
    // including the thread's own start and exit.
    let mut was_master = false;
    let alive = || generation.load(Ordering::Acquire) == my_generation;

    while alive() {
        // --- Clock mode, read live so UI changes apply ---
        let mode = ClockMode::decode(mode.load(Ordering::Relaxed));
        let master = mode == ClockMode::Master;
        if master != was_master {
            let _ = app.emit(
                "metronome-sync",
                MetronomeSync {
                    master: Some(master),
                    ..Default::default()
                },
            );
            if master {
                // The followers start their bar on the first clock pulse
                // after the Start message, sent right below with this
                // wake's body: align our own grid on a beat too
                wake = wake.next_multiple_of(WAKES_PER_BEAT);
                midi::broadcast_realtime(app, midi::MIDI_START);
            } else {
                midi::broadcast_realtime(app, midi::MIDI_STOP);
            }
            was_master = master;
        }

        // Master clock: the first of the wake's two pulses is sent with the
        // wake body, so the pulse a follower counts as a beat coincides
        // with our own beat (the second one is sent mid-wake, below)
        if master {
            midi::broadcast_realtime(app, midi::MIDI_CLOCK);
        }

        // --- Wake body (shared by all timing sources) ---
        if wake.is_multiple_of(WAKES_PER_BEAT) {
            let _ = app.emit("metronome-tick", wake / WAKES_PER_BEAT);
        }

        // --- Advancing active synths over the image ---
        // The configuration snapshot is read before the image and synth
        // locks: the config lock is never nested under them (locks.rs).
        let tick = TickConfig::read(app);
        let image_state = app.state::<ImageState>();
        let synth_state = app.state::<SynthState>();
        let midi_state = app.state::<MidiState>();

        // Image then synths, in the mandated order (see locks.rs): this
        // loop holds both while stepping every synth.
        if let Some(image) = image_state.processed.lock_safe().as_ref() {
            let mut synths = synth_state.synths.lock_safe();
            for synth in synths.values_mut() {
                if synth.playback.playing {
                    tick_synth(app, synth, image, &midi_state, tick, wake);
                }
            }
        }

        wake += 1;

        // A mode change to Off or Master drops an active DAW sync
        if clock_mode && !matches!(mode, ClockMode::Auto | ClockMode::Input) {
            clock_mode = false;
            last_synced_bpm = 0;
            pacer.reset();
            let _ = app.emit(
                "metronome-sync",
                MetronomeSync {
                    synced: Some(false),
                    ..Default::default()
                },
            );
        }

        // --- Timing source: master broadcast, external MIDI clock, or
        // internal pacing ---
        if master {
            // 24 pulses per quarter note = PULSES_PER_WAKE per wake, on the
            // absolute timeline: one sent with the wake body (above), the
            // other halfway. The BPM is re-read on every pulse so tempo
            // changes apply live.
            let half = Duration::from_nanos(wake_period_ns(bpm.load(Ordering::Relaxed)) / 2);
            pacer.wait(half);
            midi::broadcast_realtime(app, midi::MIDI_CLOCK);
            let half = Duration::from_nanos(wake_period_ns(bpm.load(Ordering::Relaxed)) / 2);
            pacer.wait(half);
        } else if clock_mode {
            let collected = wait_for_wake_pulse(clock, &alive, &mut wake);
            if !alive() {
                break;
            }
            if !collected {
                // Clock stopped: fall back to the internal tempo, keeping
                // the last synced BPM, and wait a regular wake before the
                // next one
                clock_mode = false;
                last_synced_bpm = 0;
                let _ = app.emit(
                    "metronome-sync",
                    MetronomeSync {
                        synced: Some(false),
                        ..Default::default()
                    },
                );
                pacer.reset();
                pacer.wait(Duration::from_nanos(wake_period_ns(
                    bpm.load(Ordering::Relaxed),
                )));
            } else {
                // Tempo learned from the clock: propagate it to the
                // metronome's BPM so the UI display and an eventual internal
                // fallback both follow the DAW's project tempo.
                let measured = measured_bpm(clock);
                if measured >= 20 {
                    if measured != bpm.load(Ordering::Relaxed) {
                        bpm.store(measured, Ordering::Relaxed);
                    }
                    if measured != last_synced_bpm {
                        last_synced_bpm = measured;
                        let _ = app.emit(
                            "metronome-sync",
                            MetronomeSync {
                                synced: Some(true),
                                bpm: Some(measured),
                                ..Default::default()
                            },
                        );
                    }
                }
            }
        } else {
            pacer.wait(Duration::from_nanos(wake_period_ns(
                bpm.load(Ordering::Relaxed),
            )));

            // Opportunistic engagement (Auto and Input modes: in Input mode
            // the pulses of non-selected ports are already filtered out by
            // the input handlers): as soon as a clock streams, the next
            // wakes follow its pulses instead of the internal BPM
            let pulses = clock.pulses.load(Ordering::Relaxed);
            let streaming = matches!(mode, ClockMode::Auto | ClockMode::Input)
                && pulses > 0
                && pulses != last_pulses
                && now_ns().saturating_sub(clock.last_pulse_ns.load(Ordering::Relaxed))
                    < CLOCK_ENGAGE_WINDOW.as_nanos() as u64;
            if streaming {
                // Engage on the clock's next wake pulse rather than running
                // a step off its grid, aligned on the sender's beat when its
                // phase is known. A Start/Continue seen before the sync
                // engaged is stale as an anchor (its pulse is long gone —
                // following it would fire a burst of catch-up wakes), but
                // the phase it taught is kept.
                clock.started.store(false, Ordering::Release);
                let (anchor, mut engaged_wake) =
                    sync_engage_anchor(pulses, wake, clock.beat_origin());
                clock.anchor.store(anchor, Ordering::Release);
                if wait_for_wake_pulse(clock, &alive, &mut engaged_wake) {
                    clock_mode = true;
                    last_synced_bpm = 0; // first synced event emitted on the next wake
                    wake = engaged_wake;
                } else {
                    pacer.reset();
                }
            }
            last_pulses = pulses;
        }
    }

    // The thread only lives while a synth plays: if it stops while the
    // metronome is synced to a DAW clock, release the UI's tempo controls
    // (a later restart re-engages the sync if the clock streams again),
    // and stop broadcasting the master clock with a transport Stop so the
    // followers halt too.
    if was_master {
        let _ = app.emit(
            "metronome-sync",
            MetronomeSync {
                master: Some(false),
                ..Default::default()
            },
        );
        midi::broadcast_realtime(app, midi::MIDI_STOP);
    }
    if clock_mode {
        let _ = app.emit(
            "metronome-sync",
            MetronomeSync {
                synced: Some(false),
                ..Default::default()
            },
        );
    }
}

/// Waits until the MIDI clock reaches the next wake (PULSES_PER_WAKE
/// pulses past the anchor, 24 ppqn → one wake), then advances the anchor.
/// A Start/Continue received meanwhile re-anchors the grid on the sender's
/// position: the anchor is set by the input handler, `wake` here. Returns
/// false when the clock stopped (explicit Stop, or no pulse within
/// `CLOCK_FALLBACK`) or the metronome is being stopped.
fn wait_for_wake_pulse(clock: &ClockState, alive: &impl Fn() -> bool, wake: &mut u64) -> bool {
    let deadline = Instant::now() + CLOCK_FALLBACK;
    while Instant::now() < deadline && alive() {
        if clock.started.swap(false, Ordering::AcqRel) {
            *wake = clock.start_wake.load(Ordering::Acquire);
        }
        // Explicit Stop message: fall back without waiting for the timeout
        if clock.stopped.load(Ordering::Relaxed) {
            return false;
        }
        let anchor = clock.anchor.load(Ordering::Acquire);
        let target = anchor.wrapping_add(PULSES_PER_WAKE);
        if clock.pulses.load(Ordering::Acquire) >= target
            && clock
                .anchor
                .compare_exchange(anchor, target, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            // A transport message landing between the swap above and the
            // exchange: if it set the anchor this wake just consumed (the
            // anchor is still ours), this wake is its first one. If it
            // overwrote the anchor afterwards, the next wait handles it.
            if clock.started.load(Ordering::Acquire)
                && clock.anchor.load(Ordering::Acquire) == target
                && clock.started.swap(false, Ordering::AcqRel)
            {
                *wake = clock.start_wake.load(Ordering::Acquire);
            }
            return true;
        }
        thread::sleep(Duration::from_micros(250));
    }
    false
}

/// Phase alignment when the sync engages on a clock that is already
/// streaming. `phase` is the sender's beat phase learned from its last
/// Start / Song Position Pointer + Continue (see `ClockState::beat_phase`):
/// the next wake is anchored on the sender's next even pulse within the
/// beat, and the wake counter adopts the sender's position, so the
/// metronome's beats coincide with the sender's. Without a known phase (no
/// transport message seen) the internal phase is kept — no arbitrary jump.
/// Returns `(anchor, wake)`: the next wake runs with `wake` when the pulse
/// counter reaches `anchor + PULSES_PER_WAKE`.
fn sync_engage_anchor(pulses: u64, wake: u64, phase: Option<u64>) -> (u64, u64) {
    let Some(phase) = phase else {
        return (pulses, wake);
    };
    // Next pulse on the wake grid (even position), strictly after `pulses`
    let next = if pulse_position(pulses + 1, phase).is_multiple_of(PULSES_PER_WAKE) {
        pulses + 1
    } else {
        pulses + 2
    };
    (
        next - PULSES_PER_WAKE,
        pulse_position(next, phase) / PULSES_PER_WAKE,
    )
}

#[tauri::command]
pub fn stop_metronome(state: tauri::State<MetronomeState>) {
    state.request_stop();
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
/// its tempo ratio) — after which a Note Off is sent through the gate
/// scheduler (no thread per step).
#[tauri::command]
pub fn step_synth(
    app: AppHandle,
    id: u32,
    image_state: State<'_, ImageState>,
    synth_state: State<SynthState>,
    midi_state: State<MidiState>,
    metronome_state: State<'_, MetronomeState>,
) -> Result<(), AppError> {
    let beat_ns = wake_period_ns(metronome_state.bpm.load(Ordering::Relaxed)) * WAKES_PER_BEAT;
    // Read before the image and synth locks (see locks.rs)
    let tick = TickConfig::read(&app);

    // Image then synths, in the mandated order (see locks.rs).
    let image_guard = image_state.processed.lock_safe();
    let image = image_guard
        .as_ref()
        .ok_or_else(|| err("no_processed_image"))?;

    let mut synths = synth_state.synths.lock_safe();
    let synth = synths
        .get_mut(&id)
        .ok_or_else(|| err("synth_not_found").with_param("id", id))?;

    if synth.playback.playing {
        return Err(err("synth_is_playing").with_param("id", id));
    }

    let played_length = step_synth_once(&app, synth, image, &midi_state, tick);

    // In the sustained articulation the notes are held for their full
    // duration, so schedule their Note Off: the pixel's note length when
    // note lengths are enabled, otherwise the synth's regular step period,
    // both scaled by the tempo ratio (e.g. ratio 0.5 = twice the metronome
    // period). In pizzicato the gate scheduler (or the immediate Note Off
    // when the gate is 0) already released them.
    if synth.config.note_sustain {
        let ratio = if synth.config.tempo_ratio > 0.0 {
            synth.config.tempo_ratio
        } else {
            1.0
        };
        let beats = played_length.unwrap_or(1.0);
        let step_ns = ((beat_ns as f64) * beats / ratio).round().max(1.0) as u64;
        schedule_note_offs(&app, synth, Duration::from_nanos(step_ns), true);
    }
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
            assert!(
                !(48..=71).contains(&w[1]),
                "note {w:?} landed in the disabled gap"
            );
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
        synth.config.scale = scale;
        synth.config.scale_root = root;
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
            Zone::from_rect(0, 1, 1, 3, 1), // row 1, cols 1–3
            Zone::from_rect(1, 2, 0, 2, 1), // row 0, cols 2–3
        ];
        let (width, height) = (8usize, 2usize);

        // Zone-by-zone: B entirely, then A
        let per_zone =
            build_pixel_sequence(&zones, width, height, ReadingDirection::LeftToRight, false);
        assert_eq!(per_zone, vec![9, 10, 11, 2, 3]);

        // Sorted: one left→right sweep, row 0 first
        let sorted =
            build_pixel_sequence(&zones, width, height, ReadingDirection::LeftToRight, true);
        assert_eq!(sorted, vec![2, 3, 9, 10, 11]);

        // Right→left: rows ascending, columns descending
        let sorted_rtl =
            build_pixel_sequence(&zones, width, height, ReadingDirection::RightToLeft, true);
        assert_eq!(sorted_rtl, vec![3, 2, 11, 10, 9]);

        // Top→bottom: each column ascending, within a column top→bottom
        let sorted_ttb =
            build_pixel_sequence(&zones, width, height, ReadingDirection::TopToBottom, true);
        assert_eq!(sorted_ttb, vec![9, 2, 10, 3, 11]);
    }

    #[test]
    fn build_pixel_sequence_spiral_per_zone() {
        // A 3×3 zone: clockwise spiral from the top-left, then the same
        // zone counterclockwise (first step downward)
        let zones = [Zone::from_rect(0, 0, 0, 3, 3)];
        let (width, height) = (3usize, 3usize);

        // Clockwise: top row →, right column ↓, bottom row ←, left column ↑, center
        let cw = build_pixel_sequence(&zones, width, height, ReadingDirection::Spiral, false);
        assert_eq!(cw, vec![0, 1, 2, 5, 8, 7, 6, 3, 4]);

        // Counterclockwise: left column ↓, bottom row →, right column ↑, top row ←, center
        let ccw = build_pixel_sequence(
            &zones,
            width,
            height,
            ReadingDirection::SpiralReverse,
            false,
        );
        assert_eq!(ccw, vec![0, 3, 6, 7, 8, 5, 2, 1, 4]);

        // Degenerate rectangles: a single row and a single column walk
        // each pixel exactly once, no duplicates
        let row = [Zone::from_rect(0, 1, 1, 5, 1)];
        assert_eq!(
            build_pixel_sequence(&row, 8, 4, ReadingDirection::Spiral, false),
            vec![9, 10, 11, 12, 13]
        );
        assert_eq!(
            build_pixel_sequence(&row, 8, 4, ReadingDirection::SpiralReverse, false),
            vec![9, 10, 11, 12, 13]
        );
        let col = [Zone::from_rect(0, 2, 0, 1, 4)];
        assert_eq!(
            build_pixel_sequence(&col, 8, 4, ReadingDirection::Spiral, false),
            vec![2, 10, 18, 26]
        );
        assert_eq!(
            build_pixel_sequence(&col, 8, 4, ReadingDirection::SpiralReverse, false),
            vec![2, 10, 18, 26]
        );

        // Zone by zone: the first zone's spiral entirely, then the second's
        let zones = [
            Zone::from_rect(0, 0, 0, 2, 2),
            Zone::from_rect(1, 3, 0, 2, 2),
        ];
        let per_zone = build_pixel_sequence(&zones, 5, 2, ReadingDirection::Spiral, false);
        assert_eq!(per_zone, vec![0, 1, 6, 5, 3, 4, 9, 8]);
    }

    #[test]
    fn build_pixel_sequence_spiral_sorted_is_global_over_the_selection() {
        // Two disjoint zones in the same bounding box: the sorted spiral
        // walks the box's spiral keeping only the selected pixels
        let zones = [
            Zone::from_rect(0, 0, 0, 1, 3), // left column
            Zone::from_rect(1, 2, 0, 1, 3), // right column
        ];
        let (width, height) = (3usize, 3usize);

        // Clockwise bounding-box spiral: 0,1,2,5,8,7,6,3,4 — with column 1
        // unselected, only the two selected columns remain, in spiral order
        let sorted = build_pixel_sequence(&zones, width, height, ReadingDirection::Spiral, true);
        assert_eq!(sorted, vec![0, 2, 5, 8, 6, 3]);

        // Counterclockwise: 0,3,6,7,8,5,2,1,4 filtered the same way
        let sorted_ccw =
            build_pixel_sequence(&zones, width, height, ReadingDirection::SpiralReverse, true);
        assert_eq!(sorted_ccw, vec![0, 3, 6, 8, 5, 2]);

        // Overlapping zones: each selected pixel appears exactly once
        // (deduplicated), unlike the linear directions which replay it
        let overlap = [
            Zone::from_rect(0, 0, 0, 2, 2),
            Zone::from_rect(1, 1, 0, 1, 2),
        ];
        let sorted_overlap =
            build_pixel_sequence(&overlap, width, height, ReadingDirection::Spiral, true);
        assert_eq!(sorted_overlap, vec![0, 1, 4, 3]);
    }

    #[test]
    fn remapped_cursor_keeps_the_playhead_pixel_across_sort_toggle() {
        // Two zones, one pixel each; playing the first zone's pixel
        let zones = [
            Zone::from_rect(0, 5, 0, 1, 1),
            Zone::from_rect(1, 1, 0, 1, 1),
        ];
        let synth = Synth::new(1); // cursor 0
        let (width, height) = (8usize, 1usize);

        // Playhead on pixel 5 (index 0 of the per-zone sequence)
        // Toggling sorted on: pixel 5 becomes index 1 of the new sequence
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones,
            false,
            true,
            ReadingDirection::LeftToRight,
            ReadingDirection::LeftToRight,
            width,
            height,
        );
        assert_eq!(cursor, 1);

        // Toggling back off: the playhead returns to index 0
        let mut synth = synth;
        synth.playback.cursor = 1;
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones,
            true,
            false,
            ReadingDirection::LeftToRight,
            ReadingDirection::LeftToRight,
            width,
            height,
        );
        assert_eq!(cursor, 0);
    }

    #[test]
    fn remapped_cursor_keeps_the_playhead_pixel_across_direction_change() {
        // One full row zone, sorted reading; the playhead is on the
        // sequence's last pixel in left→right order
        let zones = [Zone::from_rect(0, 0, 0, 4, 1)];
        let mut synth = Synth::new(1);
        synth.playback.cursor = 3;
        let (width, height) = (4usize, 2usize);

        // Same pixel (3) becomes index 0 when reading right→left
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones,
            true,
            true,
            ReadingDirection::LeftToRight,
            ReadingDirection::RightToLeft,
            width,
            height,
        );
        assert_eq!(cursor, 0);

        // And it is the last-but-one index when reading top→bottom of a
        // 2-row selection
        let zones = [Zone::from_rect(0, 0, 0, 2, 2)];
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones,
            true,
            true,
            ReadingDirection::LeftToRight,
            ReadingDirection::TopToBottom,
            width,
            height,
        );
        assert_eq!(cursor, 3);
    }

    #[test]
    fn remapped_cursor_continues_on_the_next_surviving_pixel() {
        // A full row selected, playhead on its third pixel (pixel 2)
        let zones = [Zone::from_rect(0, 0, 0, 5, 1)];
        let mut synth = Synth::new(1);
        synth.playback.cursor = 2;
        let (width, height) = (5usize, 2usize);

        // The playhead's pixel is deselected: the two runs flanking it
        // remain — the reading continues on the next one in reading
        // order (pixel 3, index 2 of the new per-zone sequence)
        let zones_after = [
            Zone::from_rect(0, 0, 0, 2, 1),
            Zone::from_rect(0, 3, 0, 2, 1),
        ];
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones_after,
            false,
            false,
            ReadingDirection::LeftToRight,
            ReadingDirection::LeftToRight,
            width,
            height,
        );
        assert_eq!(cursor, 2);
    }

    #[test]
    fn remapped_cursor_wraps_when_nothing_survives_after_the_playhead() {
        // Playhead on the sequence's last pixel, which is deselected:
        // nothing survives after it, the walk wraps around and lands on
        // the first still-selected pixel (pixel 0, index 0)
        let zones = [Zone::from_rect(0, 0, 0, 4, 1)];
        let mut synth = Synth::new(1);
        synth.playback.cursor = 3;
        let (width, height) = (4usize, 2usize);

        let zones_after = [Zone::from_rect(0, 0, 0, 3, 1)];
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones_after,
            false,
            false,
            ReadingDirection::LeftToRight,
            ReadingDirection::LeftToRight,
            width,
            height,
        );
        assert_eq!(cursor, 0);
    }

    #[test]
    fn remapped_cursor_restarts_when_nothing_of_the_old_selection_survives() {
        // The whole old selection is replaced by a new zone elsewhere: no
        // old pixel survives, the new reading starts at its beginning
        let zones = [Zone::from_rect(0, 0, 0, 2, 1)];
        let mut synth = Synth::new(1);
        synth.playback.cursor = 1;
        let (width, height) = (4usize, 2usize);

        let zones_after = [Zone::from_rect(0, 2, 1, 2, 1)];
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones_after,
            false,
            false,
            ReadingDirection::LeftToRight,
            ReadingDirection::LeftToRight,
            width,
            height,
        );
        assert_eq!(cursor, 0);
    }

    #[test]
    fn remapped_cursor_follows_the_travel_direction_backwards() {
        // Back-and-forth, playhead travelling backwards: when its pixel is
        // deselected, the continuation is the previous pixel of the
        // sequence (the next one in the travel direction), not the next
        // one in reading order — here pixel 1 (index 1), never pixel 3
        // (index 2)
        let zones = [Zone::from_rect(0, 0, 0, 4, 1)];
        let mut synth = Synth::new(1);
        synth.playback.cursor = 2;
        synth.playback.play_forward = false;
        let (width, height) = (4usize, 2usize);

        let zones_after = [
            Zone::from_rect(0, 0, 0, 2, 1),
            Zone::from_rect(0, 3, 0, 1, 1),
        ];
        let cursor = remapped_cursor(
            &synth,
            &zones,
            &zones_after,
            false,
            false,
            ReadingDirection::LeftToRight,
            ReadingDirection::LeftToRight,
            width,
            height,
        );
        assert_eq!(cursor, 1);
    }

    // --- MIDI clock sync ---

    #[test]
    fn measured_bpm_converts_the_pulse_period() {
        // 24 ppqn: the pulse period is the beat duration divided by 24
        let clock = ClockState::default();
        // 120 BPM → beat 500 ms → pulse 20 833 333 ns
        clock.period_ns.store(20_833_333, Ordering::Relaxed);
        assert_eq!(measured_bpm(&clock), 120);
        // 20 BPM → beat 3 s → pulse 125 000 000 ns (the metronome's floor)
        clock.period_ns.store(125_000_000, Ordering::Relaxed);
        assert_eq!(measured_bpm(&clock), 20);
        // 300 BPM → beat 200 ms → pulse 8 333 333 ns (the ceiling)
        clock.period_ns.store(8_333_333, Ordering::Relaxed);
        assert_eq!(measured_bpm(&clock), 300);
        // Out-of-range clocks are clamped into the metronome's BPM range
        clock.period_ns.store(1_000_000_000, Ordering::Relaxed);
        assert_eq!(measured_bpm(&clock), 20);
        clock.period_ns.store(1_000_000, Ordering::Relaxed);
        assert_eq!(measured_bpm(&clock), 300);
        // No measurable interval yet: unknown
        clock.period_ns.store(0, Ordering::Relaxed);
        assert_eq!(measured_bpm(&clock), 0);
    }

    #[test]
    fn register_pulse_counts_and_smooths_the_interval() {
        let clock = ClockState::default();
        const P120: u64 = 20_833_333; // pulse period at 120 BPM

        // First pulse: counted, no interval measured yet
        register_pulse(&clock, 1_000_000_000);
        assert_eq!(clock.pulses.load(Ordering::Relaxed), 1);
        assert_eq!(clock.period_ns.load(Ordering::Relaxed), 0);

        // Second pulse: the observed interval seeds the average
        register_pulse(&clock, 1_000_000_000 + P120);
        assert_eq!(clock.pulses.load(Ordering::Relaxed), 2);
        assert_eq!(clock.period_ns.load(Ordering::Relaxed), P120);

        // A jittered pulse only shifts the average a quarter of the way
        register_pulse(&clock, 1_000_000_000 + 2 * P120 + 5_000_000);
        let smoothed = clock.period_ns.load(Ordering::Relaxed);
        assert!(smoothed > P120 && smoothed < P120 + 5_000_000);
        // ...and it converges back towards the steady period
        register_pulse(&clock, 1_000_000_000 + 3 * P120 + 5_000_000);
        register_pulse(&clock, 1_000_000_000 + 4 * P120 + 5_000_000);
        let converged = clock.period_ns.load(Ordering::Relaxed);
        assert!(converged < smoothed);

        // Implausible intervals (port glitches) are ignored, not counted
        // into the average
        let before = clock.period_ns.load(Ordering::Relaxed);
        register_pulse(&clock, 1_000_000_000 + 5 * P120 + 5_000_000 + 9_000_000_000);
        assert_eq!(clock.period_ns.load(Ordering::Relaxed), before);
        // ...but the pulse itself is still counted
        assert_eq!(clock.pulses.load(Ordering::Relaxed), 6);
    }

    #[test]
    fn clock_stop_marks_the_clock_stopped_and_a_pulse_clears_it() {
        let state = MetronomeState::default();
        state.apply_clock_mode(ClockMode::Auto, None);

        on_clock_stop(&state, "port");
        assert!(state.clock.stopped.load(Ordering::Relaxed));

        // A pulse means the sender streams again
        on_clock_pulse(&state, "port");
        assert!(!state.clock.stopped.load(Ordering::Relaxed));

        // So does a Start/Continue message
        on_clock_stop(&state, "port");
        on_clock_start(&state, "port");
        assert!(!state.clock.stopped.load(Ordering::Relaxed));
        // Start also re-anchors the grid on the next pulse
        assert!(state.clock.started.load(Ordering::Relaxed));
    }

    #[test]
    fn clock_messages_are_ignored_in_off_and_master_modes() {
        let state = MetronomeState::default();

        // Off: incoming clocks are ignored entirely
        state.apply_clock_mode(ClockMode::Off, None);
        on_clock_pulse(&state, "port");
        on_clock_start(&state, "port");
        on_clock_stop(&state, "port");
        assert_eq!(state.clock.pulses.load(Ordering::Relaxed), 0);
        assert!(!state.clock.started.load(Ordering::Relaxed));
        assert!(!state.clock.stopped.load(Ordering::Relaxed));

        // Master: same — our own broadcast must never loop back into
        // the sync state through a device set to thru
        state.apply_clock_mode(ClockMode::Master, None);
        on_clock_pulse(&state, "port");
        on_clock_stop(&state, "port");
        assert_eq!(state.clock.pulses.load(Ordering::Relaxed), 0);
        assert!(!state.clock.stopped.load(Ordering::Relaxed));
    }

    #[test]
    fn input_mode_accepts_only_the_selected_source() {
        let state = MetronomeState::default();
        state.apply_clock_mode(ClockMode::Input, Some("Wysiwyl".to_string()));

        // Another port's clock is ignored
        on_clock_pulse(&state, "other port");
        on_clock_stop(&state, "other port");
        assert_eq!(state.clock.pulses.load(Ordering::Relaxed), 0);
        assert!(!state.clock.stopped.load(Ordering::Relaxed));

        // The selected port's is followed
        on_clock_pulse(&state, "Wysiwyl");
        assert_eq!(state.clock.pulses.load(Ordering::Relaxed), 1);
        on_clock_stop(&state, "Wysiwyl");
        assert!(state.clock.stopped.load(Ordering::Relaxed));
    }

    #[test]
    fn clock_mode_round_trips_through_the_atomic() {
        let state = MetronomeState::default();
        assert_eq!(state.clock_mode(), ClockMode::Auto);
        state.apply_clock_mode(ClockMode::Master, None);
        assert_eq!(state.clock_mode(), ClockMode::Master);
        assert_eq!(state.clock_source(), None);
        state.apply_clock_mode(ClockMode::Input, Some("in".to_string()));
        assert_eq!(state.clock_mode(), ClockMode::Input);
        assert_eq!(state.clock_source().as_deref(), Some("in"));
    }

    // --- Exact-zone-model sequence tests ---

    #[test]
    fn reading_order_follows_creation_order_not_geometry() {
        // The first-created zone sits BELOW the second one: the
        // per-zone reading follows the creation order, not the rows
        let lower_first = Zone::from_rect(0, 0, 2, 2, 1); // row 2
        let upper_second = Zone::from_rect(1, 0, 0, 2, 1); // row 0
        let seq = build_pixel_sequence(
            &[lower_first, upper_second],
            4,
            3,
            ReadingDirection::LeftToRight,
            false,
        );
        // lower_first entirely (row 2), then upper_second (row 0)
        assert_eq!(seq, vec![8, 9, 0, 1]);
    }

    #[test]
    fn vertical_directions_read_an_exact_shape_column_by_column() {
        // An L-shape: rows 0-1 cols 0-1, plus row 1 col 2 — built as one
        // connected zone from raw cells (the lasso pipeline's output)
        let cells = [(0, 0), (1, 0), (0, 1), (1, 1), (2, 1)];
        let lshape = Zone::from_cells(0, &cells);
        assert_eq!(lshape.pixel_count(), 5);

        let (width, height) = (4usize, 2usize);
        // Top→bottom: column 0 (rows 0,1), column 1 (rows 0,1), column 2 (row 1)
        let ttb = build_pixel_sequence(
            std::slice::from_ref(&lshape),
            width,
            height,
            ReadingDirection::TopToBottom,
            false,
        );
        assert_eq!(ttb, vec![0, 4, 1, 5, 6]);

        // Bottom→top: same columns, rows descending
        let btt = build_pixel_sequence(
            std::slice::from_ref(&lshape),
            width,
            height,
            ReadingDirection::BottomToTop,
            false,
        );
        assert_eq!(btt, vec![4, 0, 5, 1, 6]);

        // Right→left: rows ascending, columns descending
        let rtl = build_pixel_sequence(
            &[lshape],
            width,
            height,
            ReadingDirection::RightToLeft,
            false,
        );
        assert_eq!(rtl, vec![1, 0, 6, 5, 4]);
    }

    #[test]
    fn spiral_per_component_filters_to_the_exact_cells() {
        // An L-shape in a 3x3 box: the spiral walks the component's
        // bounding box but keeps only the selected cells
        let cells = [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1)];
        let lshape = Zone::from_cells(0, &cells); // 2x2 block + (2,0)
        let cw = build_pixel_sequence(&[lshape], 3, 2, ReadingDirection::Spiral, false);
        // Clockwise spiral over rows 0-1 x cols 0-2: 0,1,2 then col 2
        // down (5 = (2,1), unselected → filtered) then bottom row back
        // (4, 3). Selected cells only: 0,1,2,4,3
        assert_eq!(cw, vec![0, 1, 2, 4, 3]);
    }

    #[test]
    fn zones_clipped_outside_the_image_are_skipped() {
        // Defensive clip: a zone entirely beyond the right edge
        let out_of_bounds = Zone::from_rect(0, 10, 0, 4, 4); // cols 10-13 on a 8-wide grid
        let seq =
            build_pixel_sequence(&[out_of_bounds], 8, 4, ReadingDirection::LeftToRight, false);
        assert!(seq.is_empty());
    }

    // --- Master-tempo quantize ---

    #[test]
    fn next_resync_boundary_is_strictly_after_the_wake() {
        // N = 4 beats → one boundary every 48 wakes (12 per beat)
        assert_eq!(next_resync_boundary(0, 4), 48);
        assert_eq!(next_resync_boundary(47, 4), 48);
        assert_eq!(next_resync_boundary(48, 4), 96);
        assert_eq!(next_resync_boundary(49, 4), 96);
        // N = 1 beat → every 12 wakes
        assert_eq!(next_resync_boundary(0, 1), 12);
        assert_eq!(next_resync_boundary(11, 1), 12);
        // Out-of-range periods are clamped to at least one beat
        assert_eq!(next_resync_boundary(3, 0), 12);
    }

    #[test]
    fn quantize_never_holds_a_step_landing_on_a_boundary() {
        // wake 48 is a boundary for N = 4: the step must fire, not be held
        assert!(!should_hold_for_quantize(48, 4, 4));
        assert!(!should_hold_for_quantize(0, 4, 1));
    }

    #[test]
    fn quantize_holds_when_the_boundary_is_closer_than_the_next_step() {
        // N = 4 → boundary at wake 48. A step due at wake 47 has an interval
        // of 4 wakes (the following step would be at 51, past the boundary):
        // hold it to 48.
        assert!(should_hold_for_quantize(47, 4, 4));
        // A step due at wake 44 (interval 4) would step again at 48, exactly
        // on the boundary: no hold.
        assert!(!should_hold_for_quantize(44, 4, 4));
        // A slower synth (interval 8) is held as soon as it is within a full
        // step of the boundary.
        assert!(should_hold_for_quantize(41, 4, 8));
        // A zero interval is treated as one wake: a step due one wake before
        // the boundary would step exactly on it, so it is not held.
        assert!(!should_hold_for_quantize(47, 4, 0));
        assert!(should_hold_for_quantize(47, 4, 2));
    }

    #[test]
    fn quantize_hold_adapts_to_the_period() {
        // N = 1 → boundary at wake 12; a step due at 11 (interval 4) is held
        assert!(should_hold_for_quantize(11, 1, 4));
        // N = 8 → boundary at wake 96; wake 20 is more than one interval (8)
        // away: no hold yet
        assert!(!should_hold_for_quantize(20, 8, 8));
        assert!(should_hold_for_quantize(89, 8, 8));
    }

    #[test]
    fn ratio_cycle_matches_the_ui_fractions() {
        // 1/2, 2/3, 3/4, 1, 5/4, 4/3, 3/2 (0.66/1.33 are their decimals)
        let cases = [
            (0.5, 2),
            (0.66, 3),
            (0.75, 4),
            (1.0, 1),
            (1.25, 4),
            (1.33, 3),
            (1.5, 2),
        ];
        for (ratio, cycle) in cases {
            assert_eq!(ratio_cycle_beats(ratio), cycle, "ratio {ratio}");
        }
        // An arbitrary ratio with no small cycle falls back to 1
        assert_eq!(ratio_cycle_beats(0.7), 1);
    }

    #[test]
    fn effective_period_rounds_up_to_the_ratio_cycle() {
        // Cycle 3 (2/3, 4/3): N = 4 rounds up to 6, N = 3 stays 3, N = 8 → 9
        assert_eq!(effective_quantize_period(2.0 / 3.0, 4), 6);
        assert_eq!(effective_quantize_period(4.0 / 3.0, 4), 6);
        assert_eq!(effective_quantize_period(0.66, 4), 6);
        assert_eq!(effective_quantize_period(2.0 / 3.0, 3), 3);
        assert_eq!(effective_quantize_period(2.0 / 3.0, 8), 9);
        // Cycle 2 (1/2, 3/2) and 4 (3/4, 5/4): N = 4 already aligns
        assert_eq!(effective_quantize_period(0.5, 4), 4);
        assert_eq!(effective_quantize_period(1.5, 4), 4);
        assert_eq!(effective_quantize_period(0.75, 4), 4);
        // Cycle 1 (ratio 1): the user's period is kept as-is
        assert_eq!(effective_quantize_period(1.0, 4), 4);
        assert_eq!(effective_quantize_period(1.0, 1), 1);
    }

    #[test]
    fn quantize_realigns_on_the_ratio_cycle_without_holes() {
        // Simulates the accumulator loop for ratio 2/3 with the user's
        // period N = 4. The effective period is rounded up to the ratio's
        // cycle (3), i.e. 6 beats, so a boundary always lands on a natural
        // step: the gaps stay uniform (18 wakes) and no step is ever held.
        let ratio = 2.0 / 3.0;
        let period = effective_quantize_period(ratio, 4);
        assert_eq!(period, 6);

        let mut acc = 0.0f64;
        let mut last_step = 0u64;
        let mut gaps = Vec::new();
        let mut wakes_since_step = 0u32;
        let mut held = false;

        // Playback starts on a boundary: the first step fires immediately at
        // wake 0 (accumulator reset), so the loop starts one wake later.
        for wake in 1..(period * WAKES_PER_BEAT * 2) {
            wakes_since_step += 1;
            acc += ratio / WAKES_PER_BEAT as f64;
            if acc < 1.0 - ACC_EPSILON {
                continue;
            }
            if should_hold_for_quantize(wake, period, wakes_since_step) {
                held = true;
                continue;
            }
            if wake.is_multiple_of(period * WAKES_PER_BEAT) {
                acc = 0.0;
            } else {
                acc -= 1.0;
            }
            gaps.push(wake - last_step);
            last_step = wake;
            wakes_since_step = 0;
        }

        assert!(!held, "an exact ratio must never hold a step");
        assert!(gaps.len() >= 4);
        assert!(
            gaps.iter().all(|&g| g == 18),
            "uniform gaps expected, got {gaps:?}"
        );

        // The raw user period (4), not cycle-aligned, would hold a step
        // mid-cycle — the hole this change removes.
        assert!(should_hold_for_quantize(36, 4, 18));
    }

    #[test]
    fn articulation_retrigger_depends_on_lengths_sustain_legato_and_gate() {
        // Note lengths always retrigger, whatever the articulation
        assert!(articulation_retrigger(true, false, false, 0));
        assert!(articulation_retrigger(true, true, false, 0));
        assert!(articulation_retrigger(true, false, false, 40));

        // Legato ties identical notes: no forced retrigger even with lengths
        assert!(!articulation_retrigger(true, true, true, 0));
        assert!(!articulation_retrigger(true, true, true, 40));

        // Sustained without note lengths: the next note holds, no retrigger
        assert!(!articulation_retrigger(false, true, false, 40));

        // Pizzicato without note lengths: a non-zero gate keeps the flags
        // set, so the retrigger must be forced; a zero gate relies on the
        // immediate Note Off clearing them
        assert!(articulation_retrigger(false, false, false, 40));
        assert!(!articulation_retrigger(false, false, false, 0));
    }

    // --- Note lengths: binary vs ternary ---

    const ALL_LENGTHS: [NoteLength; 5] = [
        NoteLength::Whole,
        NoteLength::Half,
        NoteLength::Quarter,
        NoteLength::Eighth,
        NoteLength::Sixteenth,
    ];

    #[test]
    fn length_beats_applies_the_ternary_factor() {
        assert_eq!(length_beats(NoteLength::Quarter, false), 1.0);
        assert_eq!(length_beats(NoteLength::Quarter, true), 2.0 / 3.0);
        assert_eq!(length_beats(NoteLength::Eighth, true), 1.0 / 3.0);
        assert_eq!(length_beats(NoteLength::Sixteenth, true), 1.0 / 6.0);
        assert_eq!(length_beats(NoteLength::Whole, true), 8.0 / 3.0);
    }

    #[test]
    fn every_note_length_lands_on_the_wake_grid() {
        // The 1/12-beat wake grid represents every binary length and every
        // triplet exactly: each duration is an integer number of wakes.
        for ternary in [false, true] {
            for length in ALL_LENGTHS {
                let wakes = length_beats(length, ternary) * WAKES_PER_BEAT as f64;
                assert_eq!(
                    wakes,
                    wakes.round(),
                    "{length:?} (ternary={ternary}) is off the wake grid"
                );
            }
        }
    }

    // --- Timing accuracy ---

    #[test]
    fn wake_period_is_exact_to_the_nanosecond() {
        // 120 BPM: a beat is 500 ms, a wake 41.666 ms (the historical
        // integer-ms division gave 41 ms, i.e. ~122 BPM)
        assert_eq!(wake_period_ns(120), 41_666_666);
        assert_eq!(wake_period_ns(120) * WAKES_PER_BEAT, 499_999_992);
        // 300 BPM: 200 ms beat (the old code: 16 ms wakes = 312.5 BPM)
        assert_eq!(wake_period_ns(300), 16_666_666);
        // Every tempo of the range stays within 1 µs per beat of exact
        for bpm in 20..=300u32 {
            let beat = wake_period_ns(bpm) * WAKES_PER_BEAT;
            let exact = 60_000_000_000u64 / bpm as u64;
            assert!(
                exact - beat < 1_000,
                "{bpm} BPM drifts by {} ns",
                exact - beat
            );
        }
        // Defensive: 0 BPM never divides by zero
        assert!(wake_period_ns(0) > 0);
    }

    #[test]
    fn pacer_absorbs_the_work_time_instead_of_drifting() {
        // The deadline grid is fixed: whatever time the work of a wake
        // takes (here 30 ms out of 41 ms), deadline n stays start + n·period
        let start = Instant::now();
        let mut pacer = Pacer { next: start };
        let period = Duration::from_nanos(wake_period_ns(120));
        let mut now = start;
        for n in 1..=1_000u32 {
            now += Duration::from_millis(30); // the wake's processing time
            let deadline = pacer.advance(period, now);
            assert_eq!(deadline, start + period * n);
            now = deadline; // slept until the deadline
        }
    }

    #[test]
    fn pacer_reanchors_instead_of_bursting_after_a_long_stall() {
        let start = Instant::now();
        let mut pacer = Pacer { next: start };
        let period = Duration::from_millis(40);
        // A small lateness is caught up (the grid is kept)...
        let deadline = pacer.advance(period, start + Duration::from_millis(100));
        assert_eq!(deadline, start + period);
        // ...but a stall of many wakes (system sleep) re-anchors on now,
        // instead of firing a burst of catch-up steps
        let late = start + Duration::from_secs(5);
        assert_eq!(pacer.advance(period, late), late);
        assert_eq!(pacer.advance(period, late), late + period);
    }

    // --- Accumulator ---

    /// Runs the accumulator of one synth over `wakes` master wakes (no
    /// quantize), returning the wake index of every step. `lengths` is the
    /// note length (in beats) of every step, None = quarter-note steps.
    fn simulate_steps(ratio: f64, length: Option<f64>, wakes: u64) -> Vec<u64> {
        let mut acc = 0.0f64;
        let mut steps = vec![0u64];
        if let Some(l) = length {
            acc = 1.0 - l;
        }
        for wake in 1..wakes {
            acc += ratio / WAKES_PER_BEAT as f64;
            if acc < 1.0 - ACC_EPSILON {
                continue;
            }
            let carry = acc - 1.0;
            acc = carry;
            if let Some(l) = length {
                acc = 1.0 - l + carry;
            }
            steps.push(wake);
        }
        steps
    }

    #[test]
    fn exact_ratios_stay_locked_on_the_master_grid() {
        // Over 100 master beats, every UI ratio steps exactly ratio × 100
        // times with no cumulative drift — including 2/3 and 4/3, whose
        // historical truncated decimals (0.66, 1.33) slipped a step
        for &ratio in &crate::state::TEMPO_RATIOS {
            let steps = simulate_steps(ratio, None, 100 * WAKES_PER_BEAT);
            let expected = (ratio * 100.0).ceil() as usize;
            assert_eq!(steps.len(), expected, "ratio {ratio}");
            // The k-th step lands on the k-th exact step time, rounded up
            // to the wake grid
            for (k, &wake) in steps.iter().enumerate() {
                let exact = k as f64 * WAKES_PER_BEAT as f64 / ratio;
                assert!(
                    (wake as f64 - exact) >= -1e-6 && (wake as f64 - exact) < 1.0,
                    "ratio {ratio}: step {k} at wake {wake}, exact {exact}"
                );
            }
        }
        // The truncated 0.66 drifted: after 100 beats it is a step behind
        let legacy = simulate_steps(0.66, None, 100 * WAKES_PER_BEAT);
        assert!(legacy.len() < 67);
    }

    #[test]
    fn note_lengths_keep_the_accumulator_overshoot() {
        // Ratio 4/3 with eighth notes: a pixel every 0.5 synth beats =
        // 0.375 master beats = 4.5 wakes — off the wake grid. Keeping the
        // overshoot alternates 5- and 4-wake gaps around the exact time;
        // discarding it (the historical code) made every gap 5 wakes, a
        // drift of 0.5 wake per step.
        let steps = simulate_steps(4.0 / 3.0, Some(0.5), 90 * WAKES_PER_BEAT);
        let n = steps.len() - 1;
        let exact = n as f64 * 4.5;
        let last = *steps.last().unwrap() as f64;
        assert!((last - exact).abs() < 1.0, "drift: {last} vs {exact}");
    }

    #[test]
    fn normalize_tempo_ratio_snaps_the_legacy_decimals() {
        use crate::state::normalize_tempo_ratio;
        assert_eq!(normalize_tempo_ratio(0.66), 2.0 / 3.0);
        assert_eq!(normalize_tempo_ratio(1.33), 4.0 / 3.0);
        assert_eq!(normalize_tempo_ratio(0.75), 0.75);
        assert_eq!(normalize_tempo_ratio(0.1), 0.5);
        assert_eq!(normalize_tempo_ratio(9.0), 1.5);
        assert_eq!(normalize_tempo_ratio(f64::NAN), 1.0);
        // An arbitrary hand-edited ratio far from every fraction is kept
        assert_eq!(normalize_tempo_ratio(0.9), 0.9);
    }

    // --- Polyphonic note sharing ---

    use crate::state::ChannelVoice;

    fn voices(state: [(u8, bool); 3]) -> [ChannelVoice; 3] {
        state.map(|(note, note_is_on)| ChannelVoice { note, note_is_on })
    }

    #[test]
    fn a_pitch_shared_by_two_voices_is_played_once() {
        let idle = voices([(0, false); 3]);
        let plan = plan_poly_voices(&idle, [Some(60), Some(60), Some(64)], false);
        assert_eq!(plan.note_ons, vec![60, 64]);
        assert!(plan.note_offs.is_empty());
        // Only one voice owns the shared pitch
        assert_eq!(plan.sounding, [true, false, true]);
    }

    #[test]
    fn a_held_shared_pitch_is_kept_without_reattack() {
        // R holds 60; now R and G both want 60: no message at all
        let held = voices([(60, true), (0, false), (0, false)]);
        let plan = plan_poly_voices(&held, [Some(60), Some(60), None], false);
        assert!(plan.note_ons.is_empty() && plan.note_offs.is_empty());
        assert_eq!(plan.sounding, [true, false, false]);

        // R moves away while G still wants 60: the note keeps sounding,
        // G takes it over (no Note Off, no re-attack); R's new pitch starts
        let plan = plan_poly_voices(&held, [Some(62), Some(60), None], false);
        assert_eq!(plan.note_offs, Vec::<u8>::new());
        assert_eq!(plan.note_ons, vec![62]);
        assert_eq!(plan.sounding, [true, true, false]);
    }

    #[test]
    fn retrigger_reattacks_a_shared_pitch_once() {
        let held = voices([(60, true), (0, false), (64, true)]);
        let plan = plan_poly_voices(&held, [Some(60), Some(60), Some(64)], true);
        // Every held pitch released once, every wanted pitch attacked once
        assert_eq!(plan.note_offs, vec![60, 64]);
        assert_eq!(plan.note_ons, vec![60, 64]);
        assert_eq!(plan.sounding.iter().filter(|&&s| s).count(), 2);
    }

    #[test]
    fn released_voices_send_their_note_off_once() {
        // Legacy state where two voices hold the same pitch: one Note Off
        let held = voices([(60, true), (60, true), (0, false)]);
        let plan = plan_poly_voices(&held, [None, None, None], false);
        assert_eq!(plan.note_offs, vec![60]);
        assert!(plan.note_ons.is_empty());
        assert_eq!(plan.sounding, [false; 3]);
    }

    // --- Grid resize ---

    #[test]
    fn grid_resize_keeps_the_playhead_on_its_cell() {
        let zones = [Zone::from_rect(0, 0, 0, 4, 2)];
        let old = CachedSequence {
            width: 8,
            height: 4,
            sequence: build_pixel_sequence(&zones, 8, 4, ReadingDirection::LeftToRight, false),
        };
        let new = CachedSequence {
            width: 6,
            height: 3,
            sequence: build_pixel_sequence(&zones, 6, 3, ReadingDirection::LeftToRight, false),
        };
        // Cursor 5 = cell (1, 1) in the old grid; same cell in the new one
        let cursor = cursor_after_resize(&old, 5, &new);
        assert_eq!(new.sequence[cursor], 6 + 1);
        // A cell clipped away restarts the reading
        let narrow = CachedSequence {
            width: 2,
            height: 3,
            sequence: build_pixel_sequence(&zones, 2, 3, ReadingDirection::LeftToRight, false),
        };
        assert_eq!(cursor_after_resize(&old, 3, &narrow), 0);
    }

    // --- Metronome lifecycle ---

    #[test]
    fn a_single_metronome_thread_can_run() {
        let state = MetronomeState::default();
        let first = state.claim_start().expect("first start");
        // Already running: a second start is refused
        assert!(state.claim_start().is_none());
        // Stop then immediate start: the old thread's generation is stale,
        // so it exits at its next wake instead of running alongside
        state.request_stop();
        let second = state.claim_start().expect("restart");
        assert_ne!(first, second);
        assert_ne!(state.generation.load(Ordering::Acquire), first);
        assert_eq!(state.generation.load(Ordering::Acquire), second);
    }

    #[test]
    fn running_is_cleared_when_the_thread_exits_even_by_a_panic() {
        let state = MetronomeState::default();
        let mine = state.claim_start().unwrap();
        let guard = RunningGuard {
            running: state.running.clone(),
            generation: state.generation.clone(),
            mine,
        };
        let _ = std::thread::spawn(move || {
            let _guard = guard;
            panic!("metronome thread crash");
        })
        .join();
        assert!(!state.running.load(Ordering::Acquire));
        // ...so the metronome can be started again
        assert!(state.claim_start().is_some());
    }

    #[test]
    fn an_old_thread_exiting_does_not_clear_a_newer_one() {
        let state = MetronomeState::default();
        let old = state.claim_start().unwrap();
        state.request_stop();
        let _new = state.claim_start().unwrap();
        drop(RunningGuard {
            running: state.running.clone(),
            generation: state.generation.clone(),
            mine: old,
        });
        assert!(state.running.load(Ordering::Acquire));
    }

    // --- Clock sync phase ---

    #[test]
    fn start_message_aligns_the_next_wake_on_a_beat() {
        let state = MetronomeState::default();
        for _ in 0..37 {
            register_pulse(&state.clock, 0);
        }
        on_clock_start(&state, "daw");
        // The next wake fires on the very next pulse, as wake 0 (a beat)
        let anchor = state.clock.anchor.load(Ordering::Acquire);
        assert_eq!(anchor + PULSES_PER_WAKE, 38);
        assert_eq!(state.clock.start_wake.load(Ordering::Acquire), 0);
        // The pulse reaching 38 is the beat's first: position 0
        let phase = state.clock.beat_origin().unwrap();
        assert_eq!(pulse_position(38, phase), 0);
        assert_eq!(pulse_position(38 + 24, phase), 0);
        assert_eq!(pulse_position(38 + 6, phase), 6);
    }

    #[test]
    fn song_position_then_continue_resumes_mid_beat() {
        let state = MetronomeState::default();
        for _ in 0..10 {
            register_pulse(&state.clock, 0);
        }
        // Resume from the 3rd sixteenth of a bar (position 2 × 6 = 12)
        on_song_position(&state, "daw", 2);
        on_clock_continue(&state, "daw");
        assert_eq!(state.clock.start_wake.load(Ordering::Acquire), 6);
        let phase = state.clock.beat_origin().unwrap();
        assert_eq!(pulse_position(11, phase), 12);
        // The position was consumed: a later plain Continue is a beat start
        on_clock_continue(&state, "daw");
        assert_eq!(state.clock.start_wake.load(Ordering::Acquire), 0);
    }

    #[test]
    fn sync_engage_lands_on_the_senders_wake_grid() {
        // Sender phase: pulse count 38 is a beat start (see above)
        let phase = 38 % 24;
        // Engaging at pulse count 41 (position 3): the next even position
        // is 4, at count 42 → wake 2 of the beat
        let (anchor, wake) = sync_engage_anchor(41, 999, Some(phase));
        assert_eq!(anchor + PULSES_PER_WAKE, 42);
        assert_eq!(wake, 2);
        // At count 40 (position 2): next even position 4 is two pulses away
        let (anchor, wake) = sync_engage_anchor(40, 999, Some(phase));
        assert_eq!(anchor + PULSES_PER_WAKE, 42);
        assert_eq!(wake, 2);
        // Unknown phase: the internal wake counter is kept, no jump
        assert_eq!(sync_engage_anchor(41, 7, None), (41, 7));
    }
}

#[cfg(test)]
mod timing_tests {
    use super::*;

    /// Real-time check of the pacer: 1.5 s at 300 BPM (the shortest wake,
    /// 16.7 ms) with a simulated workload of up to 8 ms per wake. The
    /// elapsed time must match the theoretical duration closely — the
    /// historical sleep-after-work loop drifted by the work time on every
    /// wake (here ~50 % slow) on top of the integer-ms truncation.
    #[test]
    fn pacer_keeps_real_time_under_load() {
        let period = Duration::from_nanos(wake_period_ns(300));
        let wakes = 90u32;
        let start = Instant::now();
        let mut pacer = Pacer { next: start };
        for i in 0..wakes {
            // Variable processing time (0..8 ms)
            let work = Duration::from_micros((i % 9) as u64 * 1_000);
            let busy = Instant::now();
            while busy.elapsed() < work {
                std::hint::spin_loop();
            }
            pacer.wait(period);
        }
        let elapsed = start.elapsed();
        let expected = period * wakes;
        let drift = elapsed.as_secs_f64() - expected.as_secs_f64();
        assert!(
            drift.abs() < 0.015,
            "expected {expected:?}, took {elapsed:?} (drift {:.1} ms)",
            drift * 1000.0
        );
    }
}

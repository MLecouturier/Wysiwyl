use image::DynamicImage;
use midir::MidiOutputConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// Mode used to translate pixels into notes.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SynthMode {
    Monophonic,
    Polyphonic,
}

/// Selection zone model: exact connected components of grid cells
/// (see the `zone` module). A synth's selection is a list of disjoint
/// connected zones; empty = nothing selected.
pub use crate::zone::{RowRun, Zone};

/// Musical note length a pixel can be played as, in the synth's own beats:
/// Whole = 4 beats, Half = 2, Quarter = 1, Eighth = 0.5, Sixteenth = 0.25.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum NoteLength {
    Whole,
    Half,
    Quarter,
    Eighth,
    Sixteenth,
}

/// Direction in which the playhead travels over the pixel sequence. The
/// sequence is built accordingly: line by line for the horizontal
/// directions, column by column for the vertical ones, and a spiral
/// (clockwise or counterclockwise, from the zone's top-left corner
/// toward its center) for the two spiral directions.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ReadingDirection {
    LeftToRight,
    RightToLeft,
    TopToBottom,
    BottomToTop,
    Spiral,
    SpiralReverse,
}

/// Musical scale the derived notes are quantized to: each raw note is
/// snapped to the nearest degree of the scale that stays within the
/// enabled note ranges. Chromatic (the default) means no quantization
/// at all — every semitone is allowed, i.e. the historical behavior.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Scale {
    #[default]
    Chromatic,
    Major,
    NaturalMinor,
    HarmonicMinor,
    MelodicMinor,
    MajorPentatonic,
    MinorPentatonic,
    Blues,
    Dorian,
    Phrygian,
    Lydian,
    Mixolydian,
    Locrian,
    WholeTone,
}

/// Sound currently selected on a MIDI channel, as heard on the MIDI input
/// or sent by the app itself. Banks are optional: we only know them when
/// a Bank Select has actually been received (a device's power-on bank
/// can't be queried over MIDI).
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug, Default)]
pub struct ProgramState {
    pub bank_msb: Option<u8>, // CC 0
    pub bank_lsb: Option<u8>, // CC 32
    pub program: Option<u8>,  // Program Change, 0–127
}

impl ProgramState {
    /// True once a Program Change has been learned or sent (banks alone
    /// don't identify a sound).
    pub fn is_known(&self) -> bool {
        self.program.is_some()
    }
}

/// State of an individual voice in polyphonic mode (one per R/G/B channel).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct ChannelVoice {
    pub note: u8,
    pub note_is_on: bool,
}

impl ChannelVoice {
    pub fn new() -> Self {
        Self {
            note: 0,
            note_is_on: false,
        }
    }
}

pub struct ImageState {
    pub original: Mutex<Option<DynamicImage>>,
    pub processed: Mutex<Option<DynamicImage>>,
}

impl Default for ImageState {
    fn default() -> Self {
        Self {
            original: Mutex::new(None),
            processed: Mutex::new(None),
        }
    }
}

/// State of an individual synthesizer.
#[derive(Clone, Serialize)]
pub struct Synth {
    pub id: u32,
    /// Number shown in the default title ("Synth #n"). Attributed once
    /// at creation from a dedicated counter, never changed nor reused:
    /// unlike the id (renumbered with the stack's display order), it is
    /// stable for the synth's whole lifetime, so the user never sees a
    /// synth's default name change under a reorder or a removal.
    pub display_number: u32,
    pub name: Option<String>, // custom display name; None = default "Synth #id"
    pub playing: bool,
    pub cursor: usize,    // index into the zone pixel sequence (0..sequence length)
    pub note: u8,         // fixed MIDI note for now: A4 = 69
    pub channel: u8,      // MIDI channel 0-15
    pub midi_port: usize, // MIDI output port index (see list_midi_ports)
    pub zones: Vec<Zone>,      // connected zones to play (empty = nothing selected)
    pub mute_zones: Vec<Zone>, // manually silenced pixels (rests): the playhead still
    // travels over them but no note is sounded (empty = none)
    pub loop_enabled: bool,   // loop playback or stop at end of range
    pub back_and_forth: bool, // bounce back and forth between the sequence
    // bounds (mutually exclusive with the loop)
    pub reading_direction: ReadingDirection, // order in which the sequence is built
    pub sorted_reading: bool,                // read the pixels by their absolute position in
    // the image instead of zone by zone
    pub play_forward: bool, // current travel direction through the sequence
    // (flipped by the back-and-forth mode)
    pub end_pending: bool, // end of a non-looping sequence reached: stop on the next tick
    // (gives the final note a full step duration)
    pub tempo_ratio: f64, // playback speed relative to the metronome (1.0 = metronome tempo)
    pub tempo_accumulator: f64, // fractional-tick accumulator: a synth with tempo < 1.0
    // only advances once enough metronome ticks have accumulated
    pub brightness_min: u8, // minimum brightness threshold (0–127)
    pub brightness_max: u8, // maximum brightness threshold (0–127)
    pub active_note: bool,  // false if the current pixel is out of range (muted)
    pub note_is_on: bool,   // true if a MIDI note is currently sounding (sustain)
    pub velocity: u8,       // current MIDI velocity, derived from the pixel's brightness (1–127)
    pub velocity_min: u8,   // floor of the velocity range (0–126): brightness is
    // mapped between this value and velocity_max
    pub velocity_max: u8,        // ceiling of the velocity range (1–127)
    pub velocity_relative: bool, // true: saturation rescaled onto [min, max];
    // false: native 1–127 mapping, clamped to [min, max]
    pub volume: u8, // channel volume in percent (0–100), sent as MIDI CC 7;
    // 100 is mapped to the full CC value 127

    // --- Pixel-to-note translation modes ---
    pub mode: SynthMode,
    pub hue_shift: u16, // hue shift in degrees (0–360), monophonic mode
    pub channel_enabled: [bool; 3], // R, G, B enabled/disabled, polyphonic mode
    pub poly_voices: [ChannelVoice; 3], // independent MIDI state per R, G, B channel

    // --- Brightness-driven note lengths ---
    pub note_lengths: Vec<NoteLength>, // enabled lengths; empty = all quarter notes
    pub note_length_reversed: bool,    // flip the brightness→length mapping direction
    pub note_sustain: bool,            // true: notes hold their full length (the Note
    // Off arrives with the next note); false:
    // pizzicato — the Note Off is sent right
    // after the Note On and the instrument's
    // natural decay (release phase) shapes the tail
    pub note_generation: u32, // bumped on each note articulation, so stale
    // delayed Note Offs can cancel themselves

    // --- MIDI note range filters ---
    pub mono_note_range: [bool; 3], // bass, medium, treble enabled for the
    // monophonic note (all off = full 0–127)
    pub voice_note_ranges: [[bool; 3]; 3], // same, per R/G/B voice, polyphonic mode

    // --- Scale quantization ---
    pub scale: Scale,   // scale the derived notes are snapped to (Chromatic = none)
    pub scale_root: u8, // scale tonic as a pitch class 0–11 (0 = C)
}

impl Synth {
    pub fn new(id: u32) -> Self {
        Self {
            id,
            // Fallback: callers that build a synth without an explicit
            // number (template, session restore) set it right after
            display_number: id,
            name: None,
            playing: false,
            cursor: 0,
            note: 69, // A4
            channel: 0,
            midi_port: 0,
            zones: Vec::new(),      // empty = nothing selected
            mute_zones: Vec::new(), // empty = no manually silenced pixel
            loop_enabled: true,     // loop enabled by default
            back_and_forth: false,
            reading_direction: ReadingDirection::LeftToRight,
            sorted_reading: false,
            play_forward: true,
            end_pending: false,
            tempo_ratio: 1.0,
            tempo_accumulator: 0.0,
            brightness_min: 0,
            brightness_max: 127,
            active_note: true,
            note_is_on: false,
            velocity: 100,
            velocity_min: 0,
            velocity_max: 127,
            velocity_relative: true,
            volume: 100,

            mode: SynthMode::Monophonic,
            hue_shift: 0,
            channel_enabled: [true, true, true],
            poly_voices: [
                ChannelVoice::new(),
                ChannelVoice::new(),
                ChannelVoice::new(),
            ],

            note_lengths: vec![NoteLength::Quarter],
            note_length_reversed: false,
            note_sustain: false,
            note_generation: 0,

            mono_note_range: [false, false, false],
            voice_note_ranges: [[false, false, false]; 3],

            scale: Scale::Chromatic,
            scale_root: 0,
        }
    }
}

/// Registry of all synthesizers created by the user.
pub struct SynthState {
    pub synths: Mutex<HashMap<u32, Synth>>,
    pub next_id: Mutex<u32>,
    /// Source of the display numbers (see `Synth::display_number`):
    /// monotonic, never decremented — a removed synth's number is
    /// permanently retired, so names never shift or get reused.
    pub next_display_number: Mutex<u32>,
}

impl Default for SynthState {
    fn default() -> Self {
        Self {
            synths: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            next_display_number: Mutex::new(1),
        }
    }
}

/// Open MIDI output connections, one per output port index. The first
/// available port is opened automatically at startup; the other ports are
/// opened lazily, on first use by a synthesizer.
pub struct MidiState {
    pub connections: Mutex<HashMap<usize, MidiOutputConnection>>,
    /// Last known program per (output port, channel), learned from the
    /// MIDI input or set by the app itself. Survives synth removal: it is
    /// channel state, not synth state.
    pub known_programs: Mutex<HashMap<(usize, u8), ProgramState>>,
    /// Open MIDI input connections (one per input port), kept alive for
    /// the app's lifetime so Program Change / Bank Select messages sent
    /// by the instruments keep being tracked.
    pub input_connections: Mutex<Vec<midir::MidiInputConnection<()>>>,
    /// Cache of the output-port indices used by the master clock
    /// broadcast, with the instant it was built: refreshed at most once
    /// per second (see `midi::broadcast_realtime`).
    pub broadcast_ports: Mutex<Option<(std::time::Instant, Vec<usize>)>>,
}

impl Default for MidiState {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            known_programs: Mutex::new(HashMap::new()),
            input_connections: Mutex::new(Vec::new()),
            broadcast_ports: Mutex::new(None),
        }
    }
}

// Zone-geometry tests live in the `zone` module; the renumber tests
// live in `synth.rs` next to `renumber_synths`.

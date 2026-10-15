use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::locks::MutexExt;

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

/// Common time signatures offered by the metronome. A signature defines the
/// accent grid: the bar is split into `numerator` beat units (the
/// denominator note), one accent slot each. Every entry here holds a whole
/// number of engine wakes per bar, so the grid stays exact (see
/// `metronome::wakes_per_unit`).
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug, Default)]
pub enum TimeSignature {
    #[default]
    #[serde(rename = "4/4")]
    FourFour,
    #[serde(rename = "3/4")]
    ThreeFour,
    #[serde(rename = "2/4")]
    TwoFour,
    #[serde(rename = "6/8")]
    SixEight,
    #[serde(rename = "5/4")]
    FiveFour,
    #[serde(rename = "7/8")]
    SevenEight,
    #[serde(rename = "9/8")]
    NineEight,
    #[serde(rename = "12/8")]
    TwelveEight,
    #[serde(rename = "5/8")]
    FiveEight,
    #[serde(rename = "2/2")]
    TwoTwo,
}

impl TimeSignature {
    /// Beats per bar (the numerator): the number of accent slots.
    pub fn numerator(self) -> usize {
        match self {
            TimeSignature::FourFour => 4,
            TimeSignature::ThreeFour => 3,
            TimeSignature::TwoFour => 2,
            TimeSignature::SixEight => 6,
            TimeSignature::FiveFour => 5,
            TimeSignature::SevenEight => 7,
            TimeSignature::NineEight => 9,
            TimeSignature::TwelveEight => 12,
            TimeSignature::FiveEight => 5,
            TimeSignature::TwoTwo => 2,
        }
    }

    /// Note value of one beat unit (the denominator).
    pub fn denominator(self) -> usize {
        match self {
            TimeSignature::FourFour
            | TimeSignature::ThreeFour
            | TimeSignature::TwoFour
            | TimeSignature::FiveFour => 4,
            TimeSignature::SixEight
            | TimeSignature::SevenEight
            | TimeSignature::NineEight
            | TimeSignature::TwelveEight
            | TimeSignature::FiveEight => 8,
            TimeSignature::TwoTwo => 2,
        }
    }

    /// Default accent pattern: the downbeat is strong, the secondary pulses
    /// (every third beat in a compound meter, every other beat otherwise)
    /// normal, and the remaining beats weak. Padded to 16 slots; the entries
    /// past `numerator` are unused.
    pub fn default_accent_pattern(self) -> [AccentLevel; 16] {
        let mut pattern = [AccentLevel::Off; 16];
        let group = if self.denominator() == 8 && self.numerator().is_multiple_of(3) {
            3
        } else {
            2
        };
        for (i, slot) in pattern.iter_mut().enumerate().take(self.numerator()) {
            *slot = if i == 0 {
                AccentLevel::Strong
            } else if i % group == 0 {
                AccentLevel::Normal
            } else {
                AccentLevel::Weak
            };
        }
        pattern
    }
}

/// Discrete accent level of one slot of a measure: a per-beat velocity
/// scaling chosen by the user. The percentage each level maps to is global
/// and hand-editable (`AppConfig::accent_levels`), so a level can be
/// retuned without touching the synths.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccentLevel {
    /// No accent: the pixel's natural velocity is used unchanged.
    Off,
    /// Soft (attenuated) beat.
    Weak,
    /// Neutral intermediate level.
    #[default]
    Normal,
    /// Strong (accented) beat.
    Strong,
}

/// Global velocity multipliers (in percent) of the four accent levels,
/// hand-editable in the config file. The accent multiplies a pixel's
/// saturation-derived velocity by the percentage of the level sitting on
/// its beat; the result is clamped to 1–127. 100 = neutral.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(default)]
pub struct AccentLevels {
    pub off: u8,
    pub weak: u8,
    pub normal: u8,
    pub strong: u8,
}

impl Default for AccentLevels {
    fn default() -> Self {
        Self {
            off: 100,
            weak: 70,
            normal: 85,
            strong: 110,
        }
    }
}

impl AccentLevels {
    /// Velocity multiplier (percent) of a level.
    pub fn percent(self, level: AccentLevel) -> u8 {
        match level {
            AccentLevel::Off => self.off,
            AccentLevel::Weak => self.weak,
            AccentLevel::Normal => self.normal,
            AccentLevel::Strong => self.strong,
        }
    }
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

impl Default for ChannelVoice {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ImageState {
    pub original: Mutex<Option<DynamicImage>>,
    pub processed: Mutex<Option<DynamicImage>>,
    /// Bumped (under the `original` lock) every time the original image is
    /// replaced. The image commands run concurrently off the main thread:
    /// a grid render started on an older original must not install its
    /// result over the new one (see `apply_image_adjustments`).
    pub generation: AtomicU64,
}

impl Default for ImageState {
    fn default() -> Self {
        Self {
            original: Mutex::new(None),
            processed: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

impl ImageState {
    /// Replaces the original image and clears the processed grid (it no
    /// longer matches: the frontend re-renders it right after). Bumps the
    /// generation so an in-flight render of the previous original is
    /// discarded.
    pub fn replace_original(&self, img: DynamicImage) {
        {
            let mut original = self.original.lock_safe();
            *original = Some(img);
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
        *self.processed.lock_safe() = None;
    }
}

/// Cached flat pixel sequence (absolute image indexes) built from a
/// synth's zones. Rebuilt lazily by the metronome thread only when the
/// grid dimensions no longer match, and explicitly invalidated whenever
/// the zones or the reading options change (see `Synth::invalidate_sequence`).
#[derive(Clone)]
pub struct CachedSequence {
    pub width: usize,
    pub height: usize,
    pub sequence: Vec<usize>,
}

/// Source of [`Synth::uid`]: process-wide, monotonic, never reused.
static NEXT_SYNTH_UID: AtomicU64 = AtomicU64::new(1);

/// State of an individual synthesizer. Internal state: the UI receives a
/// [`SynthView`] (configuration flattened) rather than this struct.
#[derive(Clone)]
pub struct Synth {
    pub id: u32,
    /// Internal identity, unique for the process lifetime and never
    /// renumbered (unlike `id`, which follows the display order). Deferred
    /// work captured against a synth — the pizzicato gates and the manual
    /// step cutoffs — targets this uid, so a reorder in the meantime can
    /// never redirect it to another synth.
    pub uid: u64,
    /// Number shown in the default title ("Synth #n"). Attributed once
    /// at creation from a dedicated counter, never changed nor reused:
    /// unlike the id (renumbered with the stack's display order), it is
    /// stable for the synth's whole lifetime, so the user never sees a
    /// synth's default name change under a reorder or a removal.
    pub display_number: u32,
    pub name: Option<String>, // custom display name; None = default "Synth #id"
    pub zones: Vec<Zone>,     // connected zones to play (empty = nothing selected)
    pub mute_zones: Vec<Zone>, // manually silenced pixels (rests): the playhead still
    // travels over them but no note is sounded (empty = none)
    /// Configuration, serialized with the session and the config file.
    pub config: SynthConfig,
    /// Volatile playback state: rebuilt while playing, never serialized.
    pub playback: Playback,
}

impl Synth {
    pub fn new(id: u32) -> Self {
        Self {
            id,
            uid: NEXT_SYNTH_UID.fetch_add(1, Ordering::Relaxed),
            // Fallback: callers that build a synth without an explicit
            // number (template, session restore) set it right after
            display_number: id,
            name: None,
            zones: Vec::new(),      // empty = nothing selected
            mute_zones: Vec::new(), // empty = no manually silenced pixel
            config: SynthConfig::default(),
            playback: Playback::default(),
        }
    }

    /// Drops the cached pixel sequence: the zones, the reading direction,
    /// the sorted reading or the grid must have changed. The metronome
    /// rebuilds it on the next tick.
    pub fn invalidate_sequence(&mut self) {
        self.playback.cached_sequence = None;
    }

    /// Turns off every sounding note of the synth (monophonic note and
    /// polyphonic voices) on its current port and channel, clears their
    /// flags, and bumps the note generation so any deferred Note Off
    /// (pizzicato gate, manual step cutoff) scheduled for them is
    /// cancelled. The single release path of the crate: every place that
    /// changes the routing, the mode, or drops a synth goes through it, so
    /// no note is ever left hanging.
    pub fn release_notes(&mut self, midi: &MidiState) {
        let (port, channel) = (self.config.midi_port, self.config.channel);
        if self.playback.note_is_on {
            midi.note_off(port, channel, self.playback.note);
            self.playback.note_is_on = false;
        }
        for voice in self.playback.poly_voices.iter_mut() {
            if voice.note_is_on {
                midi.note_off(port, channel, voice.note);
                voice.note_is_on = false;
            }
        }
        self.playback.note_generation = self.playback.note_generation.wrapping_add(1);
    }

    /// Stops the playback (playhead state reset) and releases its notes.
    pub fn stop_playback(&mut self, midi: &MidiState) {
        self.playback.playing = false;
        self.playback.end_pending = false;
        self.playback.tempo_accumulator = 0.0;
        self.playback.start_pending = false;
        self.playback.wakes_since_step = 0;
        self.release_notes(midi);
    }
}

/// Bounds of the per-synth tempo ratio offered by the UI (1/2 to 3/2 of the
/// global metronome tempo). Kept in sync with the `.synth-tempo` options.
pub const TEMPO_RATIO_MIN: f64 = 0.5;
pub const TEMPO_RATIO_MAX: f64 = 1.5;

/// The exact ratios offered by the `.synth-tempo` select. Older sessions
/// and config files stored 2/3 and 4/3 as the truncated decimals 0.66 and
/// 1.33, which put the synth slightly off the master grid (a 0.66 synth
/// needs 19 wakes per step instead of 18): they are snapped back here.
pub const TEMPO_RATIOS: [f64; 7] = [0.5, 2.0 / 3.0, 0.75, 1.0, 1.25, 4.0 / 3.0, 1.5];

/// Clamps a tempo ratio to the UI range and snaps it to the exact UI
/// fraction it approximates (within 0.02). An arbitrary hand-edited ratio
/// away from every fraction is kept as-is. A non-finite value (never sent
/// through JSON, defensive) falls back to 1.
pub fn normalize_tempo_ratio(ratio: f64) -> f64 {
    if !ratio.is_finite() {
        return 1.0;
    }
    let clamped = ratio.clamp(TEMPO_RATIO_MIN, TEMPO_RATIO_MAX);
    TEMPO_RATIOS
        .iter()
        .copied()
        .find(|exact| (exact - clamped).abs() < 0.02)
        .unwrap_or(clamped)
}

/// Per-synth configuration: every field saved in a session's synth entry
/// and offered as the config file's default synth template. Serializable,
/// and sanitized when applied (see [`SynthConfig::to_synth`]).
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct SynthConfig {
    pub tempo_ratio: f64, // playback speed relative to the metronome (1.0 = metronome tempo)
    pub channel: u8,      // MIDI channel 0-15
    pub midi_port: usize, // MIDI output port index (see list_midi_ports)
    pub mode: SynthMode,  // pixel-to-note translation mode
    pub loop_enabled: bool, // loop playback or stop at end of range
    pub back_and_forth: bool, // bounce back and forth (mutually exclusive with the loop)
    pub reading_direction: ReadingDirection, // order in which the sequence is built
    pub sorted_reading: bool, // read the pixels by absolute position, not zone by zone
    pub velocity_min: u8, // floor of the velocity range (0-126)
    pub velocity_max: u8, // ceiling of the velocity range (1-127)
    pub velocity_relative: bool, // true: saturation rescaled onto [min, max]
    pub volume: u8,       // channel volume as a raw MIDI value, sent as CC 7
    pub hue_shift: u16,   // hue shift in degrees (0-360), monophonic mode
    pub channel_enabled: [bool; 3], // R, G, B enabled/disabled, polyphonic mode
    pub note_lengths: Vec<NoteLength>, // enabled lengths; empty = all quarter notes
    pub note_length_reversed: bool, // flip the brightness->length mapping direction
    pub note_length_ternary: bool, // true: lengths are triplets (3 in the time of 2)
    pub note_sustain: bool, // true: notes hold their full length; false: pizzicato
    pub note_legato: bool, // true: tie identical consecutive notes (no re-attack)
    pub mono_note_range: [bool; 3], // bass/medium/treble for the monophonic note
    pub voice_note_ranges: [[bool; 3]; 3], // same, per R/G/B voice, polyphonic mode
    pub scale: Scale,     // scale the derived notes are snapped to (Chromatic = none)
    pub scale_root: u8,   // scale tonic as a pitch class 0-11 (0 = C)
    pub quantize: bool,   // realign the step grid on the master beats (delay-only)
    pub quantize_beats: u8, // resync period in master beats (1-8) when quantize is on
    /// Silence pattern: 16 steps applied to a zone by clicking a pixel
    /// while the pattern mode is armed (true = silence/rest, false =
    /// play). The steps follow the synth's reading order, so the rhythm
    /// lines up with the pixels the synth plays.
    pub silence_pattern: [bool; 16],
    /// Repeat the silence pattern across the whole zone (tiling, wrapping
    /// around the clicked pixel) instead of placing it once.
    pub silence_pattern_repeat: bool,
    /// Accent the played pixels by their position in the measure: when on,
    /// the velocity of each pixel is scaled by the accent level of the beat
    /// it starts on (see `accent_pattern` and the global `accent_levels`).
    pub accent_enabled: bool,
    /// One accent level per beat unit of the bar, read in the global time
    /// signature's order (slot 0 = downbeat). Padded to 16; the entries past
    /// the signature's numerator are unused. Defaults to the 4/4 hierarchy.
    #[serde(default = "default_accent_pattern")]
    pub accent_pattern: [AccentLevel; 16],
}

/// Default silence pattern: every step is a silence (rest) except the four
/// quarter-note downbeats — steps 1, 5, 9 and 13 (indices 0, 4, 8, 12) are
/// played — giving a four-on-the-floor pulse out of the box.
pub fn default_silence_pattern() -> [bool; 16] {
    let mut steps = [true; 16];
    for i in (0..16).step_by(4) {
        steps[i] = false;
    }
    steps
}

/// Default accent pattern (the 4/4 hierarchy): used when a config file or a
/// session predates the accent fields.
fn default_accent_pattern() -> [AccentLevel; 16] {
    TimeSignature::FourFour.default_accent_pattern()
}

impl Default for SynthConfig {
    fn default() -> Self {
        Self {
            tempo_ratio: 1.0,
            channel: 0,
            midi_port: 0,
            mode: SynthMode::Monophonic,
            loop_enabled: true,
            back_and_forth: false,
            reading_direction: ReadingDirection::LeftToRight,
            sorted_reading: false,
            velocity_min: 0,
            velocity_max: 127,
            velocity_relative: true,
            volume: 127,
            hue_shift: 0,
            channel_enabled: [true, true, true],
            note_lengths: vec![NoteLength::Quarter],
            note_length_reversed: false,
            note_length_ternary: false,
            note_sustain: false,
            note_legato: false,
            mono_note_range: [false, false, false],
            voice_note_ranges: [[false, false, false]; 3],
            scale: Scale::Chromatic,
            scale_root: 0,
            quantize: false,
            quantize_beats: 4,
            silence_pattern: default_silence_pattern(),
            silence_pattern_repeat: false,
            accent_enabled: false,
            accent_pattern: TimeSignature::FourFour.default_accent_pattern(),
        }
    }
}

impl SynthConfig {
    /// Builds a synth with this configuration applied, sanitizing the
    /// hand-editable values (config file / session) as the old template did.
    pub fn to_synth(&self, id: u32) -> Synth {
        let mut synth = Synth::new(id);
        synth.config = self.sanitized();
        synth
    }

    /// A copy with every hand-editable value (config file / session)
    /// brought into the range the commands themselves enforce, so a synth
    /// restored from a file never holds a value the UI could not set.
    pub fn sanitized(&self) -> Self {
        let mut config = self.clone();
        config.loop_enabled = self.loop_enabled && !self.back_and_forth;
        config.tempo_ratio = normalize_tempo_ratio(self.tempo_ratio);
        config.channel = self.channel.min(15);
        config.volume = self.volume.min(127);
        config.velocity_min = self.velocity_min.min(126);
        config.velocity_max = self.velocity_max.clamp(config.velocity_min, 127);
        config.hue_shift = self.hue_shift.min(360);
        config.note_lengths = normalize_note_lengths(&self.note_lengths);
        config.scale_root = self.scale_root.min(11);
        config.quantize_beats = self.quantize_beats.clamp(1, 8);
        config
    }

    /// The configuration of an existing synth.
    pub fn from_synth(synth: &Synth) -> Self {
        synth.config.clone()
    }
}

/// Deduplicates the enabled note lengths (keeping their first
/// occurrence), and replaces an empty list by a single quarter note: the
/// UI always keeps at least one length enabled, and an empty list must
/// mean the same thing live and after a save/reload.
pub fn normalize_note_lengths(lengths: &[NoteLength]) -> Vec<NoteLength> {
    let mut out: Vec<NoteLength> = Vec::with_capacity(lengths.len());
    for &length in lengths {
        if !out.contains(&length) {
            out.push(length);
        }
    }
    if out.is_empty() {
        out.push(NoteLength::Quarter);
    }
    out
}

/// Volatile playback state of a synth: rebuilt while playing, derived from
/// the configuration and the image, and never serialized.
#[derive(Clone)]
pub struct Playback {
    pub playing: bool,                           // currently playing
    pub cursor: usize,                           // index into the zone pixel sequence
    pub note: u8,                                // current fixed MIDI note (monophonic)
    pub play_forward: bool,                      // travel direction (flipped by back-and-forth)
    pub end_pending: bool,                       // end of a non-looping sequence reached
    pub tempo_accumulator: f64,                  // beats accumulated toward the next step
    pub active_note: bool, // false if the current pixel is out of range (muted)
    pub note_is_on: bool,  // true if a MIDI note is currently sounding
    pub velocity: u8,      // current MIDI velocity (1-127)
    pub poly_voices: [ChannelVoice; 3], // independent MIDI state per R/G/B channel
    pub note_generation: u32, // bumped on each articulation (stale Note Off guard)
    pub cached_sequence: Option<CachedSequence>, // derived pixel sequence cache
    pub start_pending: bool, // first note waits for the next master beat (start sync)
    pub wakes_since_step: u32, // wakes (1/12 beat) elapsed since the last step
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            playing: false,
            cursor: 0,
            note: 69, // A4
            play_forward: true,
            end_pending: false,
            tempo_accumulator: 0.0,
            active_note: true,
            note_is_on: false,
            velocity: 100,
            poly_voices: [
                ChannelVoice::new(),
                ChannelVoice::new(),
                ChannelVoice::new(),
            ],
            note_generation: 0,
            cached_sequence: None,
            start_pending: false,
            wakes_since_step: 0,
        }
    }
}

/// Serializable view of a synth for the UI: identity, selection and the
/// configuration flattened — the same shape as a session's synth entry.
/// `Synth` itself is internal state and is never sent as-is.
#[derive(Serialize)]
pub struct SynthView {
    pub id: u32,
    pub display_number: u32,
    pub name: Option<String>,
    pub zones: Vec<Zone>,
    pub mute_zones: Vec<Zone>,
    #[serde(flatten)]
    pub config: SynthConfig,
}

impl From<&Synth> for SynthView {
    fn from(synth: &Synth) -> Self {
        Self {
            id: synth.id,
            display_number: synth.display_number,
            name: synth.name.clone(),
            zones: synth.zones.clone(),
            mute_zones: synth.mute_zones.clone(),
            config: synth.config.clone(),
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
    pub connections: Mutex<HashMap<usize, crate::midi::OutputConnection>>,
    /// Instant of the last failed open per port index: the port is not
    /// retried on every note while it is missing (see `with_connection`).
    pub failed_opens: Mutex<HashMap<usize, std::time::Instant>>,
    /// Last known program per (output port, channel), learned from the
    /// MIDI input or set by the app itself. Survives synth removal: it is
    /// channel state, not synth state.
    pub known_programs: Mutex<HashMap<(usize, u8), ProgramState>>,
    /// Open MIDI input connections (one per input port), kept alive for
    /// the app's lifetime so Program Change / Bank Select messages sent
    /// by the instruments keep being tracked.
    /// Each with the stable OS id of its port ("" for the app's virtual
    /// input), so the hot-plug watcher only opens the new ports.
    pub input_connections: Mutex<Vec<(String, midir::MidiInputConnection<()>)>>,
    /// Cache of the output-port indices used by the master clock
    /// broadcast, with the instant it was built: refreshed at most once
    /// per second (see `midi::broadcast_realtime`).
    pub broadcast_ports: Mutex<Option<(std::time::Instant, Vec<usize>)>>,
}

impl Default for MidiState {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            failed_opens: Mutex::new(HashMap::new()),
            known_programs: Mutex::new(HashMap::new()),
            input_connections: Mutex::new(Vec::new()),
            broadcast_ports: Mutex::new(None),
        }
    }
}

// Zone-geometry tests live in the `zone` module; the renumber tests
// live in `synth.rs` next to `renumber_synths`.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synth_view_flattens_config_and_omits_playback() {
        // The UI payload (SynthView) must keep the historical flat shape:
        // config fields at the top level, no playback/derived state.
        let mut synth = Synth::new(1);
        synth.playback.cached_sequence = Some(CachedSequence {
            width: 2,
            height: 1,
            sequence: vec![0, 1],
        });
        let json = serde_json::to_value(SynthView::from(&synth)).unwrap();
        assert!(json.get("config").is_none()); // flattened, not nested
        assert!(json.get("tempo_ratio").is_some());
        assert!(json.get("playback").is_none());
        assert!(json.get("cached_sequence").is_none());
        assert!(json.get("zones").is_some());
    }

    #[test]
    fn invalidate_sequence_clears_the_cache() {
        let mut synth = Synth::new(1);
        synth.playback.cached_sequence = Some(CachedSequence {
            width: 2,
            height: 1,
            sequence: vec![],
        });
        synth.invalidate_sequence();
        assert!(synth.playback.cached_sequence.is_none());
    }

    #[test]
    fn to_synth_clamps_tempo_ratio_to_the_ui_range() {
        // Hand-edited sessions/config files may hold a stale ratio; it is
        // clamped to the values the `.synth-tempo` select offers.
        let low = SynthConfig {
            tempo_ratio: 0.05,
            ..Default::default()
        };
        assert_eq!(low.to_synth(1).config.tempo_ratio, TEMPO_RATIO_MIN);
        let high = SynthConfig {
            tempo_ratio: 4.0,
            ..Default::default()
        };
        assert_eq!(high.to_synth(1).config.tempo_ratio, TEMPO_RATIO_MAX);
        let in_range = SynthConfig {
            tempo_ratio: 0.75,
            ..Default::default()
        };
        assert_eq!(in_range.to_synth(1).config.tempo_ratio, 0.75);
    }

    #[test]
    fn default_accent_pattern_marks_the_downbeat_strong() {
        let p = TimeSignature::FourFour.default_accent_pattern();
        assert_eq!(p[0], AccentLevel::Strong);
        assert_eq!(p[1], AccentLevel::Weak);
        assert_eq!(p[2], AccentLevel::Normal);
        assert_eq!(p[3], AccentLevel::Weak);
        // Slots past the numerator stay off
        assert_eq!(p[4], AccentLevel::Off);
        // A compound meter groups by three
        let s = TimeSignature::SixEight.default_accent_pattern();
        assert_eq!(s[0], AccentLevel::Strong);
        assert_eq!(s[3], AccentLevel::Normal);
        assert_eq!(s[6], AccentLevel::Off);
    }

    #[test]
    fn accent_levels_map_each_level_to_its_percentage() {
        let levels = AccentLevels {
            off: 100,
            weak: 60,
            normal: 80,
            strong: 120,
        };
        assert_eq!(levels.percent(AccentLevel::Off), 100);
        assert_eq!(levels.percent(AccentLevel::Weak), 60);
        assert_eq!(levels.percent(AccentLevel::Normal), 80);
        assert_eq!(levels.percent(AccentLevel::Strong), 120);
    }

    #[test]
    fn missing_accent_fields_default_to_the_four_four_hierarchy() {
        // A session / config written before the accent fields existed
        let config: SynthConfig = serde_json::from_str("{}").unwrap();
        assert!(!config.accent_enabled);
        assert_eq!(
            config.accent_pattern,
            TimeSignature::FourFour.default_accent_pattern()
        );
    }
}

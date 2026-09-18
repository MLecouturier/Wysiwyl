use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::error::{err, AppError};
use crate::metronome::{ClockMode, MetronomeState};
use crate::state::{NoteLength, ReadingDirection, Scale, Synth, SynthMode};

/// Default bounds of the three note-range filters, in MIDI note numbers.
pub const DEFAULT_NOTE_RANGE_BOUNDS: [(u8, u8); 3] = [(21, 47), (48, 71), (72, 108)];

/// Default palette offered for the synthesizers.
fn default_synth_colors() -> Vec<String> {
    [
        "#ff2f2f", "#ff8c00", "#ffc300", "#b6f000", "#00e884", "#00d5b8", "#432fff", "#7d2fd4",
        "#b42fd4", "#ea2bd9", "#ff2f92", "#ff2f5d",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// All scales, in canonical order — the default `enabled_scales`.
fn default_enabled_scales() -> Vec<Scale> {
    vec![
        Scale::Chromatic,
        Scale::Major,
        Scale::NaturalMinor,
        Scale::HarmonicMinor,
        Scale::MelodicMinor,
        Scale::MajorPentatonic,
        Scale::MinorPentatonic,
        Scale::Blues,
        Scale::Dorian,
        Scale::Phrygian,
        Scale::Lydian,
        Scale::Mixolydian,
        Scale::Locrian,
        Scale::WholeTone,
    ]
}

fn is_valid_hex_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// Global application configuration, persisted as JSON in the app config
/// directory. Missing or corrupt fields fall back to their default.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    /// Longest side allowed for imported images; larger originals are
    /// downscaled on import. 0 = unlimited.
    pub max_image_size: u32,
    /// Metronome tempo used at startup.
    pub default_bpm: u32,
    /// Clock source of the metronome (see `ClockMode`): `auto` follows any
    /// incoming MIDI clock, `off` runs on the internal tempo only, `input`
    /// follows the clock of one chosen input port, `master` broadcasts a
    /// MIDI clock to every output port while playing.
    pub clock_mode: ClockMode,
    /// Input port name the clock sync follows when `clock_mode` is
    /// `input`. Stored as reported by the MIDI input listeners.
    pub clock_source: Option<String>,
    /// Template applied to every newly created synthesizer.
    pub default_synth: SynthTemplate,
    /// Bounds (low, high), in MIDI note numbers, of the three note-range
    /// filters (bass, medium, treble). Hand-edited values are sanitized on
    /// load: swapped if inverted, clamped to 0–127.
    pub note_range_bounds: [(u8, u8); 3],
    /// Colors offered for the synthesizers, "#rrggbb" hex strings. Invalid
    /// entries are dropped on load; an empty list falls back to the default
    /// palette.
    pub synth_colors: Vec<String>,
    /// Scales offered in the per-synth scale selects. Hand-edited entries
    /// are deduplicated on load and Chromatic is always enabled (it is the
    /// "no quantization" default, a synth can never lose access to it).
    /// The selects show the enabled scales in their canonical order.
    pub enabled_scales: Vec<Scale>,
    /// Accumulated scroll deltas needed for one increment when a
    /// continuous scroll device (trackpad, free-spin wheel) hovers a
    /// value input (BPM, sliders, synth volume). Higher = less
    /// sensitive. A discrete mouse-wheel notch always applies exactly
    /// one increment, whatever this value. Hand-edited values are
    /// clamped to 1–2000 on load.
    pub wheel_trackpad_threshold: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            max_image_size: 2048,
            default_bpm: 120,
            clock_mode: ClockMode::Auto,
            clock_source: None,
            default_synth: SynthTemplate::default(),
            note_range_bounds: DEFAULT_NOTE_RANGE_BOUNDS,
            synth_colors: default_synth_colors(),
            enabled_scales: default_enabled_scales(),
            wheel_trackpad_threshold: 100,
        }
    }
}

impl AppConfig {
    /// Clamps hand-edited values into shape.
    fn sanitize(&mut self) {
        // Clock mode: "input" is meaningless without a source port, and a
        // source is meaningless in any other mode
        if matches!(self.clock_mode, ClockMode::Input)
            && !self
                .clock_source
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
        {
            self.clock_mode = ClockMode::Auto;
        }
        if !matches!(self.clock_mode, ClockMode::Input) {
            self.clock_source = None;
        } else {
            self.clock_source = self.clock_source.as_deref().map(|s| s.trim().to_string());
        }
        for (lo, hi) in self.note_range_bounds.iter_mut() {
            let l = (*lo).min(*hi);
            let h = (*lo).max(*hi);
            *lo = l.min(127);
            *hi = h.min(127);
        }
        self.synth_colors.retain(|c| is_valid_hex_color(c));
        if self.synth_colors.is_empty() {
            self.synth_colors = default_synth_colors();
        }
        // Scale enablement: deduplicate, and always keep Chromatic (the
        // "no quantification" default)
        let mut seen: Vec<Scale> = Vec::new();
        for scale in self.enabled_scales.drain(..) {
            if !seen.contains(&scale) {
                seen.push(scale);
            }
        }
        if !seen.contains(&Scale::Chromatic) {
            seen.insert(0, Scale::Chromatic);
        }
        self.enabled_scales = seen;
        // Trackpad scroll feel: keep the threshold in a usable range
        self.wheel_trackpad_threshold = self.wheel_trackpad_threshold.clamp(1, 2000);
    }
}

/// Settings of a synthesizer that can be saved as the default template.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct SynthTemplate {
    pub tempo_ratio: f64,
    pub channel: u8,
    pub midi_port: usize,
    pub mode: SynthMode,
    pub loop_enabled: bool,
    pub back_and_forth: bool,
    pub reading_direction: ReadingDirection,
    pub sorted_reading: bool,
    pub brightness_min: u8,
    pub brightness_max: u8,
    pub velocity_min: u8,
    pub velocity_max: u8,
    pub velocity_relative: bool,
    pub volume: u8,
    pub hue_shift: u16,
    pub channel_enabled: [bool; 3],
    pub note_lengths: Vec<NoteLength>,
    pub note_length_reversed: bool,
    pub note_sustain: bool,
    pub mono_note_range: [bool; 3],
    pub voice_note_ranges: [[bool; 3]; 3],
    pub scale: Scale,
    pub scale_root: u8,
}

impl Default for SynthTemplate {
    fn default() -> Self {
        // Mirrors the defaults of Synth::new
        Self::from_synth(&Synth::new(0))
    }
}

impl SynthTemplate {
    /// Extracts the template-relevant settings from an existing synth.
    pub fn from_synth(synth: &Synth) -> Self {
        Self {
            tempo_ratio: synth.tempo_ratio,
            channel: synth.channel,
            midi_port: synth.midi_port,
            mode: synth.mode,
            loop_enabled: synth.loop_enabled,
            back_and_forth: synth.back_and_forth,
            reading_direction: synth.reading_direction,
            sorted_reading: synth.sorted_reading,
            brightness_min: synth.brightness_min,
            brightness_max: synth.brightness_max,
            velocity_min: synth.velocity_min,
            velocity_max: synth.velocity_max,
            velocity_relative: synth.velocity_relative,
            volume: synth.volume,
            hue_shift: synth.hue_shift,
            channel_enabled: synth.channel_enabled,
            note_lengths: synth.note_lengths.clone(),
            note_length_reversed: synth.note_length_reversed,
            note_sustain: synth.note_sustain,
            mono_note_range: synth.mono_note_range,
            voice_note_ranges: synth.voice_note_ranges,
            scale: synth.scale,
            scale_root: synth.scale_root,
        }
    }

    /// Builds a fresh synthesizer with this template's settings (playback
    /// state, cursor, name, etc. keep their standard defaults).
    pub fn to_synth(&self, id: u32) -> Synth {
        let mut synth = Synth::new(id);
        synth.tempo_ratio = self.tempo_ratio;
        synth.channel = self.channel;
        synth.midi_port = self.midi_port;
        synth.mode = self.mode;
        synth.loop_enabled = self.loop_enabled && !self.back_and_forth;
        synth.back_and_forth = self.back_and_forth;
        synth.reading_direction = self.reading_direction;
        synth.sorted_reading = self.sorted_reading;
        synth.brightness_min = self.brightness_min;
        synth.brightness_max = self.brightness_max;
        synth.velocity_min = self.velocity_min;
        synth.velocity_max = self.velocity_max;
        synth.velocity_relative = self.velocity_relative;
        synth.volume = self.volume.min(127);
        synth.hue_shift = self.hue_shift;
        synth.channel_enabled = self.channel_enabled;
        if !self.note_lengths.is_empty() {
            synth.note_lengths = self.note_lengths.clone();
        }
        synth.note_length_reversed = self.note_length_reversed;
        synth.note_sustain = self.note_sustain;
        synth.mono_note_range = self.mono_note_range;
        synth.voice_note_ranges = self.voice_note_ranges;
        synth.scale = self.scale;
        synth.scale_root = self.scale_root.min(11);
        synth
    }
}

/// Managed state holding the loaded configuration.
pub struct ConfigState {
    pub config: std::sync::Mutex<AppConfig>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("config.json"))
}

/// Recursively checks that every object field present in the serialized
/// config also exists in the raw JSON (arrays and leaves are accepted
/// as-is). Used to detect a config file written by an older version of
/// the app, so the new fields can be materialized in the file.
fn covers_fields(raw: &serde_json::Value, full: &serde_json::Value) -> bool {
    match (raw, full) {
        (serde_json::Value::Object(r), serde_json::Value::Object(f)) => {
            f.iter().all(|(k, v)| match r.get(k) {
                Some(rv) => covers_fields(rv, v),
                None => false,
            })
        }
        _ => true,
    }
}

/// Loads the configuration from the app config directory, falling back to
/// the defaults if the file is missing or unreadable. Fields absent from
/// the file (e.g. added by a newer version) are materialized in it with
/// their default value, so the user always sees every configurable value;
/// existing values and formatting of other fields are left untouched. A
/// file that fails to parse is never rewritten.
pub fn load_config(app: &AppHandle) -> AppConfig {
    let Some(path) = config_path(app) else {
        return AppConfig::default();
    };
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<AppConfig>(&content) {
            Ok(parsed) => {
                let mut config = parsed;
                config.sanitize();
                let raw = serde_json::from_str::<serde_json::Value>(&content).unwrap_or_default();
                let full = serde_json::to_value(&config).unwrap_or_default();
                if !covers_fields(&raw, &full) {
                    save_config(app, &config);
                }
                config
            }
            Err(_) => AppConfig::default(), // corrupt: left untouched
        },
        Err(_) => AppConfig::default(),
    }
}

/// Persists the configuration, creating the config directory if needed.
/// A write failure is not fatal: the app keeps running with the in-memory
/// configuration.
pub fn save_config(app: &AppHandle, config: &AppConfig) {
    let Some(path) = config_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(&path, json);
    }
}

/// Opens the configuration file in the system's default text editor. The
/// file is created with the current in-memory configuration if it doesn't
/// exist yet, so the user always has something to look at. Hand-edits
/// apply on the next application start.
#[tauri::command]
pub fn open_config_file(app: AppHandle, state: State<'_, ConfigState>) -> Result<(), AppError> {
    let path = config_path(&app).ok_or_else(|| err("config_unavailable"))?;
    if !path.exists() {
        let config = state.config.lock().unwrap().clone();
        save_config(&app, &config);
    }
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| err("open_config_failed").with_param("details", e))?;
    Ok(())
}

#[tauri::command]
pub fn get_config(state: State<'_, ConfigState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_max_image_size(app: AppHandle, max_image_size: u32, state: State<'_, ConfigState>) {
    let mut config = state.config.lock().unwrap();
    config.max_image_size = max_image_size;
    save_config(&app, &config);
}

#[tauri::command]
pub fn set_default_bpm(
    app: AppHandle,
    bpm: u32,
    state: State<'_, ConfigState>,
    metronome: State<'_, MetronomeState>,
) {
    let clamped = bpm.clamp(20, 300);
    let mut config = state.config.lock().unwrap();
    config.default_bpm = clamped;
    save_config(&app, &config);
    metronome
        .bpm
        .store(clamped, std::sync::atomic::Ordering::Relaxed);
}

/// Saves the current settings of an existing synthesizer as the default
/// template applied to every newly created synthesizer.
#[tauri::command]
pub fn set_default_synth_from(
    app: AppHandle,
    id: u32,
    synth_state: State<'_, crate::state::SynthState>,
    config_state: State<'_, ConfigState>,
) -> Result<(), AppError> {
    let template = {
        let synths = synth_state.synths.lock().unwrap();
        let synth = synths
            .get(&id)
            .ok_or_else(|| err("synth_not_found").with_param("id", id))?;
        SynthTemplate::from_synth(synth)
    };
    let mut config = config_state.config.lock().unwrap();
    config.default_synth = template;
    save_config(&app, &config);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_fields_detects_missing_top_level_field() {
        // A file written before note_range_bounds / synth_colors existed
        let raw: serde_json::Value =
            serde_json::from_str(r#"{ "max_image_size": 2048, "default_bpm": 120 }"#).unwrap();
        let full = serde_json::to_value(AppConfig::default()).unwrap();
        assert!(!covers_fields(&raw, &full));

        let raw: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&AppConfig::default()).unwrap()).unwrap();
        assert!(covers_fields(&raw, &full));
    }

    #[test]
    fn covers_fields_detects_missing_nested_field() {
        let mut raw: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&AppConfig::default()).unwrap()).unwrap();
        raw["default_synth"]
            .as_object_mut()
            .unwrap()
            .remove("velocity_min");
        let full = serde_json::to_value(AppConfig::default()).unwrap();
        assert!(!covers_fields(&raw, &full));
    }

    #[test]
    fn sanitize_fixes_bounds_and_colors() {
        let mut config = AppConfig {
            note_range_bounds: [(47, 21), (200, 130), (72, 108)],
            synth_colors: vec![
                "red".to_string(),     // invalid: dropped
                "#3498db".to_string(), // valid
                "#123abc".to_string(), // valid
            ],
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.note_range_bounds, [(21, 47), (127, 127), (72, 108)]);
        assert_eq!(
            config.synth_colors,
            vec!["#3498db".to_string(), "#123abc".to_string()]
        );

        // An empty list falls back to the default palette
        config.synth_colors = vec![];
        config.sanitize();
        assert_eq!(config.synth_colors, default_synth_colors());
    }

    #[test]
    fn sanitize_dedupes_enabled_scales_and_forces_chromatic() {
        // Duplicates collapse, and Chromatic is forced in even when the
        // hand-edited file drops it
        let mut config = AppConfig {
            enabled_scales: vec![Scale::Major, Scale::Major, Scale::Blues],
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(
            config.enabled_scales,
            vec![Scale::Chromatic, Scale::Major, Scale::Blues]
        );

        // Chromatic already present: kept once, order preserved
        let mut config = AppConfig {
            enabled_scales: vec![Scale::Chromatic, Scale::Blues, Scale::Chromatic],
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.enabled_scales, vec![Scale::Chromatic, Scale::Blues]);
    }

    #[test]
    fn config_without_enabled_scales_loads_them_all() {
        // A file written before the field existed: every scale is enabled
        let json = r##"{
            "max_image_size": 2048,
            "default_bpm": 120,
            "default_synth": {},
            "note_range_bounds": [[21, 47], [48, 71], [72, 108]],
            "synth_colors": ["#3498db"]
        }"##;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.enabled_scales, default_enabled_scales());
    }

    #[test]
    fn config_without_clock_mode_defaults_to_auto() {
        // A file written before the field existed: the historical
        // opportunistic sync
        let json = r##"{
            "max_image_size": 2048,
            "default_bpm": 120,
            "default_synth": {},
            "note_range_bounds": [[21, 47], [48, 71], [72, 108]],
            "synth_colors": ["#3498db"]
        }"##;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.clock_mode, ClockMode::Auto);
        assert_eq!(config.clock_source, None);
    }

    #[test]
    fn clock_mode_serializes_snake_case() {
        // The config file stays hand-editable: "master", not "Master"
        assert_eq!(
            serde_json::to_value(AppConfig {
                clock_mode: ClockMode::Master,
                ..AppConfig::default()
            })
            .unwrap()["clock_mode"],
            serde_json::json!("master")
        );
        let config: AppConfig =
            serde_json::from_str(r##"{ "clock_mode": "input", "clock_source": "Wysiwyl" }"##)
                .unwrap();
        assert_eq!(config.clock_mode, ClockMode::Input);
        assert_eq!(config.clock_source.as_deref(), Some("Wysiwyl"));
    }

    #[test]
    fn sanitize_fixes_the_clock_mode() {
        // "input" without a source port: meaningless, falls back to Auto
        let mut config = AppConfig {
            clock_mode: ClockMode::Input,
            clock_source: None,
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.clock_mode, ClockMode::Auto);
        assert_eq!(config.clock_source, None);

        // Same with an empty source string
        let mut config = AppConfig {
            clock_mode: ClockMode::Input,
            clock_source: Some("   ".to_string()),
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.clock_mode, ClockMode::Auto);

        // "input" with a source: kept
        let mut config = AppConfig {
            clock_mode: ClockMode::Input,
            clock_source: Some("Wysiwyl".to_string()),
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.clock_mode, ClockMode::Input);
        assert_eq!(config.clock_source.as_deref(), Some("Wysiwyl"));

        // A source in any other mode: dropped
        let mut config = AppConfig {
            clock_mode: ClockMode::Off,
            clock_source: Some("Wysiwyl".to_string()),
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.clock_source, None);
    }

    #[test]
    fn config_without_wheel_trackpad_threshold_defaults_to_100() {
        // A file written before the field existed
        let json = r##"{
            "max_image_size": 2048,
            "default_bpm": 120,
            "default_synth": {},
            "note_range_bounds": [[21, 47], [48, 71], [72, 108]],
            "synth_colors": ["#3498db"]
        }"##;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.wheel_trackpad_threshold, 100);
    }

    #[test]
    fn sanitize_clamps_wheel_trackpad_threshold() {
        let mut config = AppConfig {
            wheel_trackpad_threshold: 0,
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.wheel_trackpad_threshold, 1);

        let mut config = AppConfig {
            wheel_trackpad_threshold: 100_000,
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.wheel_trackpad_threshold, 2000);
    }
}

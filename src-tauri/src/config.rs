use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::error::{err, AppError};
use crate::locks::MutexExt;
use crate::metronome::{ClockMode, MetronomeState};
use crate::state::{default_silence_pattern, Scale, SynthConfig};

/// Hard cap on the longest side of any image held by the app (import,
/// session load, transform results): beyond it the grid rendering and the
/// IPC payloads exhaust memory. `max_image_size = 0` (unlimited) is capped
/// to it too.
pub const MAX_IMAGE_SIDE: u32 = 8192;

/// Schema version of the persisted configuration. Bumped when a one-time
/// migration must run on files written by an older build (see
/// [`migrate_config`]). Files written before the field existed read as 0.
pub const CONFIG_VERSION: u32 = 2;

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

pub(crate) fn is_valid_hex_color(s: &str) -> bool {
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
    pub default_synth: SynthConfig,
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
    /// Minimum duration (ms) of a note in the pizzicato articulation
    /// (`note_sustain = false`): the Note Off is delayed by that much
    /// instead of being sent in the same packet as the Note On. This lets
    /// instruments whose envelope needs time to rise (most software synths)
    /// produce an audible pluck. 0 restores the historical behavior (the
    /// Note Off is immediate and the instrument's release shapes the tail).
    /// Hand-edited values are clamped to 0–1000 on load.
    pub pizzicato_gate_ms: u32,
    /// Depth of the undo/redo history for zone and silence edits (number
    /// of steps kept). Hand-edited values are clamped to 1–500 on load.
    pub undo_depth: u32,
    /// Schema version of the file (see [`CONFIG_VERSION`]). Absent in files
    /// written before it existed: the field-level default reads them as 0,
    /// so the one-time migrations run once and are then recorded here.
    #[serde(default)]
    pub config_version: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            max_image_size: 2048,
            default_bpm: 120,
            clock_mode: ClockMode::Auto,
            clock_source: None,
            default_synth: SynthConfig::default(),
            note_range_bounds: DEFAULT_NOTE_RANGE_BOUNDS,
            synth_colors: default_synth_colors(),
            enabled_scales: default_enabled_scales(),
            wheel_trackpad_threshold: 100,
            pizzicato_gate_ms: 40,
            undo_depth: 25,
            config_version: CONFIG_VERSION,
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
        // Pizzicato gate: at most one second, 0 = immediate Note Off
        self.pizzicato_gate_ms = self.pizzicato_gate_ms.min(1000);
        // Undo history depth: at least one step, capped to stay reasonable
        self.undo_depth = self.undo_depth.clamp(1, 500);
        // Startup tempo: the metronome's range (a 0 or a huge value would
        // stall or spin the metronome thread)
        self.default_bpm = self.default_bpm.clamp(20, 300);
        // Imported image size: 0 = unlimited, else at least a usable size
        // and at most MAX_IMAGE_SIDE (memory)
        if self.max_image_size != 0 {
            self.max_image_size = self.max_image_size.clamp(16, MAX_IMAGE_SIDE);
        }
        self.clock_source = self
            .clock_source
            .take()
            .map(|s| s.chars().take(256).collect());
        // The default synth template gets the same bounds as the commands
        self.default_synth = self.default_synth.sanitized();
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

/// Runs the one-time configuration migrations up to [`CONFIG_VERSION`],
/// reading the file's schema version from the raw JSON (`from_version`).
/// Returns true when the config changed and must be written back.
///
/// Migrations are keyed on the version, never on the current values, so a
/// setting deliberately chosen after the migration is never overwritten.
fn migrate_config(config: &mut AppConfig, from_version: u32) -> bool {
    if from_version >= CONFIG_VERSION {
        config.config_version = CONFIG_VERSION;
        return false;
    }
    // v2: the silence pattern's first default was all-play (the placeholder
    // value materialized by an earlier build); the real default is a
    // four-on-the-floor pulse. A template left untouched (still all-play)
    // is upgraded; a customized one is kept as-is.
    if config.default_synth.silence_pattern == [false; 16] {
        config.default_synth.silence_pattern = default_silence_pattern();
    }
    config.config_version = CONFIG_VERSION;
    true
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
/// their default value, so the user always sees every configurable value.
///
/// A file that fails to parse is preserved: it is copied aside as
/// `config.json.bak` (a later save writes the defaults over
/// `config.json`, the user's hand edits must not be lost with it).
/// Individual fields of the wrong type fall back to their default instead
/// of discarding the whole file.
pub fn load_config(app: &AppHandle) -> AppConfig {
    let Some(path) = config_path(app) else {
        return AppConfig::default();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return AppConfig::default();
    };
    match parse_config(&content) {
        Some((mut config, complete)) => {
            config.sanitize();
            let raw = serde_json::from_str::<serde_json::Value>(&content).unwrap_or_default();
            // The file's schema version drives the one-time migrations: a
            // file written before the field existed reads as 0. Reading it
            // from the raw JSON keeps this correct on both parse paths.
            let from_version = raw
                .get("config_version")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let migrated = migrate_config(&mut config, from_version);
            let full = serde_json::to_value(&config).unwrap_or_default();
            if !complete || !covers_fields(&raw, &full) || migrated {
                if !complete {
                    backup_config(&path);
                }
                save_config(app, &config);
            }
            config
        }
        None => {
            // Not even valid JSON: keep it aside, run on the defaults
            backup_config(&path);
            AppConfig::default()
        }
    }
}

/// Parses a config file leniently: a valid JSON object whose fields do
/// not all deserialize keeps the valid ones (each invalid field falls back
/// to its default). Returns the config and whether every field was valid;
/// None when the content is not a JSON object at all.
fn parse_config(content: &str) -> Option<(AppConfig, bool)> {
    if let Ok(config) = serde_json::from_str::<AppConfig>(content) {
        return Some((config, true));
    }
    let raw: serde_json::Value = serde_json::from_str(content).ok()?;
    let raw = raw.as_object()?;
    let mut merged = serde_json::to_value(AppConfig::default()).ok()?;
    let target = merged.as_object_mut()?;
    for (key, value) in raw {
        if !target.contains_key(key) {
            continue;
        }
        // Accept the field only if the config still parses with it
        let previous = target.insert(key.clone(), value.clone());
        let candidate = serde_json::Value::Object(target.clone());
        if serde_json::from_value::<AppConfig>(candidate).is_err() {
            match previous {
                Some(v) => target.insert(key.clone(), v),
                None => target.remove(key),
            };
        }
    }
    let config = serde_json::from_value(merged).ok()?;
    Some((config, false))
}

/// Copies a config file aside as `<name>.bak` before it gets rewritten.
fn backup_config(path: &std::path::Path) {
    let backup = path.with_extension("json.bak");
    if let Err(e) = fs::copy(path, &backup) {
        eprintln!("Unable to back up the config file: {e}");
    } else {
        eprintln!(
            "Invalid config file: kept a copy as {}",
            backup.to_string_lossy()
        );
    }
}

/// Persists the configuration atomically, creating the config directory if
/// needed. A write failure is not fatal (the app keeps running with the
/// in-memory configuration) but it is reported on stderr. Never call it
/// while holding the config lock (clone the config first): the metronome
/// reads the config on every wake.
pub fn save_config(app: &AppHandle, config: &AppConfig) {
    let Some(path) = config_path(app) else { return };
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("Unable to create the config directory: {e}");
            return;
        }
    }
    match serde_json::to_string_pretty(config) {
        Ok(json) => {
            if let Err(e) = crate::fsutil::write_atomic(&path, json.as_bytes()) {
                eprintln!("Unable to save the config file: {e}");
            }
        }
        Err(e) => eprintln!("Unable to serialize the config: {e}"),
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
        let config = state.config.lock_safe().clone();
        save_config(&app, &config);
    }
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| err("open_config_failed").with_param("details", e))?;
    Ok(())
}

#[tauri::command]
pub fn get_config(state: State<'_, ConfigState>) -> AppConfig {
    state.config.lock_safe().clone()
}

/// Sets the longest side allowed for imported images (0 = unlimited,
/// capped to `MAX_IMAGE_SIDE` anyway) and persists it.
#[tauri::command]
pub fn set_max_image_size(app: AppHandle, max_image_size: u32, state: State<'_, ConfigState>) {
    let snapshot = {
        let mut config = state.config.lock_safe();
        config.max_image_size = max_image_size;
        config.sanitize();
        config.clone()
    };
    save_config(&app, &snapshot);
}

#[tauri::command]
pub fn set_default_bpm(
    app: AppHandle,
    bpm: u32,
    state: State<'_, ConfigState>,
    metronome: State<'_, MetronomeState>,
) {
    let clamped = bpm.clamp(20, 300);
    let snapshot = {
        let mut config = state.config.lock_safe();
        config.default_bpm = clamped;
        config.clone()
    };
    save_config(&app, &snapshot);
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
        let synths = synth_state.synths.lock_safe();
        let synth = synths
            .get(&id)
            .ok_or_else(|| err("synth_not_found").with_param("id", id))?;
        SynthConfig::from_synth(synth)
    };
    let snapshot = {
        let mut config = config_state.config.lock_safe();
        config.default_synth = template;
        config.clone()
    };
    save_config(&app, &snapshot);
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
    fn sanitize_clamps_pizzicato_gate() {
        let mut config = AppConfig {
            pizzicato_gate_ms: 5000,
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.pizzicato_gate_ms, 1000);

        // 0 is valid: the historical immediate Note Off
        let mut config = AppConfig {
            pizzicato_gate_ms: 0,
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.pizzicato_gate_ms, 0);

        // The default is a usable minimum gate
        assert_eq!(AppConfig::default().pizzicato_gate_ms, 40);
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

    #[test]
    fn config_without_undo_depth_defaults_to_25() {
        // A file written before the field existed
        let json = r##"{
            "max_image_size": 2048,
            "default_bpm": 120,
            "default_synth": {},
            "note_range_bounds": [[21, 47], [48, 71], [72, 108]],
            "synth_colors": ["#3498db"]
        }"##;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.undo_depth, 25);
        assert_eq!(AppConfig::default().undo_depth, 25);
    }

    #[test]
    fn sanitize_clamps_bpm_image_size_and_the_default_synth() {
        let mut config = AppConfig {
            default_bpm: 9000,
            max_image_size: 100_000,
            ..AppConfig::default()
        };
        config.default_synth.channel = 40;
        config.default_synth.tempo_ratio = 0.66;
        config.sanitize();
        assert_eq!(config.default_bpm, 300);
        assert_eq!(config.max_image_size, MAX_IMAGE_SIDE);
        assert_eq!(config.default_synth.channel, 15);
        assert_eq!(config.default_synth.tempo_ratio, 2.0 / 3.0);

        let mut config = AppConfig {
            default_bpm: 0,
            max_image_size: 0, // unlimited stays unlimited (capped at use)
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.default_bpm, 20);
        assert_eq!(config.max_image_size, 0);
    }

    #[test]
    fn a_field_of_the_wrong_type_only_resets_that_field() {
        let json = r##"{
            "default_bpm": "fast",
            "undo_depth": 42,
            "clock_mode": "nonsense"
        }"##;
        let (config, complete) = parse_config(json).unwrap();
        assert!(!complete);
        assert_eq!(config.default_bpm, AppConfig::default().default_bpm);
        assert_eq!(config.clock_mode, ClockMode::Auto);
        // The valid fields survive
        assert_eq!(config.undo_depth, 42);
        // Not JSON at all: nothing to salvage
        assert!(parse_config("{ not json").is_none());
        // A clean file is complete
        let (_, complete) = parse_config(r#"{ "undo_depth": 3 }"#).unwrap();
        assert!(complete);
    }

    #[test]
    fn sanitize_clamps_undo_depth() {
        let mut config = AppConfig {
            undo_depth: 0,
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.undo_depth, 1);

        let mut config = AppConfig {
            undo_depth: 10_000,
            ..AppConfig::default()
        };
        config.sanitize();
        assert_eq!(config.undo_depth, 500);
    }

    #[test]
    fn default_config_serializes_the_silence_pattern() {
        // The default synth template is saved whole, so the pattern fields
        // must be part of the serialized config (they survive a
        // save-default / reload round trip)
        let value = serde_json::to_value(AppConfig::default()).unwrap();
        let synth = value.get("default_synth").unwrap();
        assert!(synth.get("silence_pattern").is_some());
        assert!(synth.get("silence_pattern_repeat").is_some());
    }

    #[test]
    fn migrate_config_upgrades_the_legacy_silence_pattern() {
        let mut config = AppConfig::default();
        config.default_synth.silence_pattern = [false; 16];
        config.config_version = 0;
        assert!(migrate_config(&mut config, 0));
        assert_eq!(
            config.default_synth.silence_pattern,
            default_silence_pattern()
        );
        assert_eq!(config.config_version, CONFIG_VERSION);
    }

    #[test]
    fn migrate_config_preserves_a_customized_pattern() {
        let mut config = AppConfig::default();
        let custom = {
            let mut p = [false; 16];
            p[2] = true;
            p
        };
        config.default_synth.silence_pattern = custom;
        assert!(migrate_config(&mut config, 0));
        assert_eq!(config.default_synth.silence_pattern, custom);
        assert_eq!(config.config_version, CONFIG_VERSION);
    }

    #[test]
    fn migrate_config_is_a_no_op_at_the_current_version() {
        // Once migrated, an all-play pattern is a deliberate choice and must
        // not be touched again
        let mut config = AppConfig::default();
        config.default_synth.silence_pattern = [false; 16];
        assert!(!migrate_config(&mut config, CONFIG_VERSION));
        assert_eq!(config.default_synth.silence_pattern, [false; 16]);
    }

    #[test]
    fn config_version_defaults_to_zero_when_absent() {
        // A file written before the field existed has no config_version:
        // the field-level default must read it as 0 so the migration runs
        let config: AppConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.config_version, 0);
    }
}

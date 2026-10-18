use base64::{engine::general_purpose, Engine as _};
use image::{GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::config::ConfigState;
use crate::error::{err, AppError};
use crate::image_processing::{decode_image_bounded, encode_to_base64_png, fit_image_size};
use crate::locks::MutexExt;
use crate::state::{ImageState, MidiState, ProgramState, Synth, SynthConfig, SynthState, Zone};
use crate::zone::normalize_zones;

/// Frontend-owned state passed on save: metronome tempo, image processing
/// sliders, and the synths' display colors (in list order).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub struct SessionUi {
    pub bpm: u32,
    pub grid_slider: u32,
    pub contrast: f32,
    pub brightness: i32,
    pub vibrance: f32,
    pub posterize_levels: Option<u8>,
    pub texture: f32,
    pub clarity: f32,
    pub simplify: f32,
    #[serde(default)]
    pub auto_levels: bool,
    /// Zone display mode of the projection mirror (see
    /// `deserialize_mirror_zones_mode`). Absent when the frontend state
    /// predates the three-mode toggle.
    #[serde(
        alias = "mirror_show_zones",
        default = "default_mirror_zones_mode",
        deserialize_with = "deserialize_mirror_zones_mode"
    )]
    pub mirror_zones_mode: String,
    /// Active masking effect of the projection mirror's top layer (see
    /// the frontend effects registry, `mirror/effects.js`). Absent when
    /// the frontend state predates the feature. Unlike the zones mode,
    /// the id is not validated here: the registry belongs to the
    /// frontend and grows independently — an unknown id falls back to
    /// the no-op effect on restore.
    #[serde(default = "default_mirror_effect")]
    pub mirror_effect: String,
    /// Numeric options of the active effect, keyed by option id.
    #[serde(default)]
    pub mirror_effect_options: HashMap<String, f64>,
    /// Synth ids the effect does not apply to (see the frontend's
    /// `synthEffectExcluded` set: the ids are stack positions, remapped
    /// by the frontend on its id renumbering). Absent when the session
    /// predates the feature: the effect applies to every synth.
    #[serde(default)]
    pub mirror_effect_synths: Vec<u32>,
    pub synth_colors: Vec<SynthUiEntry>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct SynthUiEntry {
    pub id: u32,
    pub color: String,
}

/// Zone display mode of the projection mirror when the session (or the
/// frontend state) predates the three-mode toggle: zones hidden, the
/// historical default.
fn default_mirror_zones_mode() -> String {
    "none".into()
}

/// Masking effect of the projection mirror when the session (or the
/// frontend state) predates the feature: no effect, the historical
/// single-surface display.
fn default_mirror_effect() -> String {
    "none".into()
}

/// Deserializes the mirror's zone display mode: "all" (every synth's
/// zones), "active" (only the synths whose eye button is on in the main
/// window) or "none". Sessions saved with the older two-state toggle
/// store a boolean instead: `true` loads as "all", `false` as "none".
fn deserialize_mirror_zones_mode<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct MirrorZonesModeVisitor;

    impl<'de> serde::de::Visitor<'de> for MirrorZonesModeVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .write_str(r#"a mirror zones mode ("all", "active", "none") or a legacy boolean"#)
        }

        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
            match value {
                "all" | "active" | "none" => Ok(value.into()),
                _ => Err(E::custom(format!("unknown mirror zones mode: {value}"))),
            }
        }

        // Legacy two-state toggle: zones shown or hidden
        fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
            Ok(if value { "all".into() } else { "none".into() })
        }
    }

    deserializer.deserialize_any(MirrorZonesModeVisitor)
}

/// Image processing settings, saved as raw slider values so the restore
/// is exact (the column count itself is derived from the original image).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionImageSettings {
    pub grid_slider: u32,
    pub contrast: f32,
    pub brightness: i32,
    /// Vibrance (formerly saturation): sessions saved before the rename
    /// store the value under the old `saturation` key.
    #[serde(default, alias = "saturation")]
    pub vibrance: f32,
    pub posterize_levels: Option<u8>,
    #[serde(default)]
    pub texture: f32,
    #[serde(default)]
    pub clarity: f32,
    #[serde(default)]
    pub simplify: f32,
    #[serde(default)]
    pub auto_levels: bool,
    /// Zone display mode of the projection mirror (see SessionUi).
    #[serde(
        alias = "mirror_show_zones",
        default = "default_mirror_zones_mode",
        deserialize_with = "deserialize_mirror_zones_mode"
    )]
    pub mirror_zones_mode: String,
    /// Active masking effect of the projection mirror (see SessionUi).
    #[serde(default = "default_mirror_effect")]
    pub mirror_effect: String,
    /// Numeric options of the active effect (see SessionUi).
    #[serde(default)]
    pub mirror_effect_options: HashMap<String, f64>,
    /// Synth ids the effect does not apply to (see SessionUi).
    #[serde(default)]
    pub mirror_effect_synths: Vec<u32>,
}

/// A synthesizer as stored in a session file: its identity, display color,
/// pixel zones as exact connected components (empty = nothing selected),
/// settings (flattened SynthConfig), and the channel's program at save
/// time so loading the session can reconfigure the instruments to the
/// same sounds.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionSynth {
    pub id: u32,
    /// Stable display number of the default title (see
    /// `Synth::display_number`). Absent in sessions saved before its
    /// introduction: the id is used as a fallback on load.
    #[serde(default)]
    pub display_number: Option<u32>,
    pub name: Option<String>,
    pub color: String,
    pub zones: Vec<Zone>,
    /// Manually silenced pixels (rests) among the selected zones. Absent
    /// in sessions saved before the feature: nothing is muted.
    #[serde(default)]
    pub mute_zones: Vec<Zone>,
    #[serde(default)]
    pub program: Option<ProgramState>,
    #[serde(flatten)]
    pub settings: SynthConfig,
}

/// A self-contained work session: the original image (base64 PNG) plus
/// everything needed to restore the exact same state. `version` allows
/// future formats to stay backward-compatible. Version 3 switched the
/// zones from rectangles to exact run-length-encoded components; older
/// files are refused at load with `session_version_unsupported`.
pub const SESSION_VERSION: u32 = 3;

#[derive(Serialize, Deserialize, Debug)]
pub struct SessionFile {
    pub version: u32,
    pub bpm: u32,
    pub image: SessionImage,
    pub image_settings: SessionImageSettings,
    pub synths: Vec<SessionSynth>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SessionImage {
    pub data: String, // base64 PNG of the original image
}

/// Payload returned by `load_session`, for the frontend to rebuild its UI.
/// `path` is the file the session was loaded from, so the frontend can
/// track the current session file (title bar, direct re-save with Cmd+S).
#[derive(Serialize, Debug)]
pub struct LoadedSession {
    pub version: u32,
    pub path: String,
    pub bpm: u32,
    pub image_base64: String,
    pub orig_width: u32,
    pub orig_height: u32,
    pub image_settings: SessionImageSettings,
    pub synths: Vec<SessionSynth>,
}

/// Session files the user picked through a native dialog during this run
/// (opened or saved as). `save_session` only writes to a path given by the
/// webview when it is one of these: the webview can update the current
/// session file, but never choose an arbitrary path on disk (a script
/// injected in the page could otherwise overwrite any user file).
#[derive(Default)]
pub struct SessionPaths {
    paths: Mutex<HashSet<PathBuf>>,
}

impl SessionPaths {
    fn allow(&self, path: &Path) {
        self.paths.lock_safe().insert(path.to_path_buf());
    }

    fn is_allowed(&self, path: &Path) -> bool {
        self.paths.lock_safe().contains(path)
    }
}

/// Validated restore data of one session synth (see `validate_session`).
struct RestoredSynth {
    synth: Synth,
    program: Option<ProgramState>,
}

/// A synth color as stored in / restored from a session: a "#rrggbb" hex
/// string, anything else (it ends up in a CSS property) falls back to a
/// neutral default.
fn session_color(color: &str) -> String {
    if crate::config::is_valid_hex_color(color) {
        color.to_ascii_lowercase()
    } else {
        "#808080".into()
    }
}

/// Synth ids and display numbers must stay well below the counters' range.
const MAX_SESSION_ID: u32 = 1 << 20;

/// Longest custom synth name kept on load.
const MAX_NAME_CHARS: usize = 200;

/// A session file larger than this is refused before being read (the
/// image of a session is capped to `MAX_IMAGE_SIDE` anyway).
const MAX_SESSION_BYTES: u64 = 512 * 1024 * 1024;

/// Checks a parsed session file and builds its synths, rejecting what the
/// app could never have produced (`session_invalid`): duplicate synth
/// ids, ids or display numbers at the edge of the counters, malformed
/// zones. Hand-editable values are brought into range (see
/// `SynthConfig::sanitized`), so a restored synth never holds a value the
/// UI could not set.
fn validate_session(file: &SessionFile) -> Result<Vec<RestoredSynth>, AppError> {
    let invalid = |details: &str| err("session_invalid").with_param("details", details);
    let mut ids = HashSet::new();
    let mut restored = Vec::with_capacity(file.synths.len());
    for entry in &file.synths {
        if entry.id == 0 || entry.id >= MAX_SESSION_ID || !ids.insert(entry.id) {
            return Err(invalid("synth id"));
        }
        let display_number = entry.display_number.unwrap_or(entry.id);
        if display_number == 0 || display_number >= MAX_SESSION_ID {
            return Err(invalid("display number"));
        }
        let mut synth = entry.settings.to_synth(entry.id);
        synth.display_number = display_number;
        synth.name = entry
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| n.chars().take(MAX_NAME_CHARS).collect());
        synth.zones = normalize_zones(entry.zones.clone()).map_err(|_| invalid("zones"))?;
        synth.mute_zones =
            normalize_zones(entry.mute_zones.clone()).map_err(|_| invalid("mute zones"))?;
        let program = entry.program.map(|p| ProgramState {
            bank_msb: p.bank_msb.map(|v| v & 0x7F),
            bank_lsb: p.bank_lsb.map(|v| v & 0x7F),
            program: p.program.map(|v| v & 0x7F),
        });
        restored.push(RestoredSynth { synth, program });
    }
    Ok(restored)
}

/// Saves the current work session to a `.wysiwyl` file. When `path` is
/// provided the session is written there directly (updating a previously
/// loaded or saved one) — it must be a file picked through a dialog during
/// this run, otherwise a native save dialog is shown. Returns the path
/// actually written, or `None` when the dialog was canceled (not an
/// error). The write is atomic: a crash mid-save never destroys the
/// previous version of the file.
#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    ui: SessionUi,
    path: Option<String>,
) -> Result<Option<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || save_session_blocking(&app, ui, path))
        .await
        .map_err(|e| err("session_write_error").with_param("details", e))?
}

fn save_session_blocking(
    app: &AppHandle,
    ui: SessionUi,
    path: Option<String>,
) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let allowed = app.state::<SessionPaths>();
    let known = path.map(PathBuf::from).filter(|p| allowed.is_allowed(p));
    let path = match known {
        Some(p) => p,
        None => {
            let file_path = app
                .dialog()
                .file()
                .add_filter("Wysiwyl session", &["wysiwyl"])
                .blocking_save_file();

            let Some(file_path) = file_path else {
                return Ok(None); // canceled
            };
            file_path
                .as_path()
                .ok_or_else(|| err("invalid_file_path"))?
                .to_path_buf()
        }
    };

    // Snapshot the state under the locks, then release them before the
    // (slow) encoding and the disk write: the metronome and the image
    // commands must not wait for a save.
    let original = app
        .state::<ImageState>()
        .original
        .lock_safe()
        .clone()
        .ok_or_else(|| err("no_image_loaded"))?;

    // Synths in display order, as given by the frontend's color list
    let synths: Vec<SessionSynth> = {
        let synth_state = app.state::<SynthState>();
        let midi_state = app.state::<MidiState>();
        let synths_guard = synth_state.synths.lock_safe();
        let known_programs = midi_state.known_programs.lock_safe();
        let mut seen = HashSet::new();
        ui.synth_colors
            .iter()
            .filter(|entry| seen.insert(entry.id))
            .filter_map(|entry| {
                let synth = synths_guard.get(&entry.id)?;
                Some(SessionSynth {
                    id: entry.id,
                    display_number: Some(synth.display_number),
                    name: synth.name.clone(),
                    color: session_color(&entry.color),
                    zones: synth.zones.clone(),
                    mute_zones: synth.mute_zones.clone(),
                    // Snapshot of the channel state, so the session restores
                    // the same sounds even if the synths changed channels
                    program: known_programs
                        .get(&(synth.config.midi_port, synth.config.channel))
                        .copied()
                        .filter(|p| p.is_known()),
                    settings: SynthConfig::from_synth(synth),
                })
            })
            .collect()
    };

    let mut buffer = Vec::new();
    original
        .write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png)
        .map_err(|e| err("png_encoding_error").with_param("details", e))?;
    drop(original);
    let image = SessionImage {
        data: general_purpose::STANDARD.encode(&buffer),
    };
    drop(buffer);

    let file = SessionFile {
        version: SESSION_VERSION,
        bpm: ui.bpm.clamp(20, 300),
        image,
        image_settings: SessionImageSettings {
            grid_slider: ui.grid_slider,
            contrast: ui.contrast,
            brightness: ui.brightness,
            vibrance: ui.vibrance,
            posterize_levels: ui.posterize_levels,
            texture: ui.texture,
            clarity: ui.clarity,
            simplify: ui.simplify,
            auto_levels: ui.auto_levels,
            mirror_zones_mode: ui.mirror_zones_mode,
            mirror_effect: ui.mirror_effect,
            mirror_effect_options: ui.mirror_effect_options,
            mirror_effect_synths: ui.mirror_effect_synths,
        },
        synths,
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| err("session_write_error").with_param("details", e))?;
    crate::fsutil::write_atomic(&path, json.as_bytes())
        .map_err(|e| err("session_write_error").with_param("details", e))?;

    allowed.allow(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Loads a `.wysiwyl` (or legacy `.soundmap`) file picked through a native
/// open dialog and reinstalls its whole state (image, synths) into the
/// backend. Returns the session's content for the frontend to rebuild its
/// UI; `None` means the dialog was canceled. The file is fully parsed,
/// decoded and validated before anything is replaced: a refused file
/// leaves the current session untouched.
#[tauri::command]
pub async fn load_session(app: AppHandle) -> Result<Option<LoadedSession>, AppError> {
    tauri::async_runtime::spawn_blocking(move || load_session_blocking(&app))
        .await
        .map_err(|e| err("session_read_error").with_param("details", e))?
}

fn load_session_blocking(app: &AppHandle) -> Result<Option<LoadedSession>, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("Wysiwyl session", &["wysiwyl", "soundmap"])
        .blocking_pick_file();

    let Some(path) = file_path else {
        return Ok(None); // canceled
    };
    let path = path
        .as_path()
        .ok_or_else(|| err("invalid_file_path"))?
        .to_path_buf();

    let size = fs::metadata(&path)
        .map_err(|e| err("session_read_error").with_param("details", e))?
        .len();
    if size > MAX_SESSION_BYTES {
        return Err(err("session_invalid").with_param("details", "file size"));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| err("session_read_error").with_param("details", e))?;

    // Version gate, before any struct parsing: a session of an older
    // format (rectangular zones, versions 1-2) is refused with a clear
    // error instead of an opaque deserialization failure. The file's
    // structure cannot be trusted enough to migrate reliably.
    let raw: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    drop(content);
    let version = raw
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| err("session_version_unsupported").with_param("version", "missing"))?;
    if version != SESSION_VERSION as u64 {
        return Err(err("session_version_unsupported").with_param("version", version));
    }

    let mut file: SessionFile = serde_json::from_value(raw)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    let restored = validate_session(&file)?;

    // Decode the original image, within the app's size limits
    let bytes = general_purpose::STANDARD
        .decode(std::mem::take(&mut file.image.data))
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    let img = decode_image_bounded(&bytes)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    drop(bytes);
    let max_size = app.state::<ConfigState>().config.lock_safe().max_image_size;
    let img = fit_image_size(img, max_size);
    let (orig_width, orig_height) = img.dimensions();
    let image_base64 = encode_to_base64_png(&img)?;

    // Reinstall the image first, then the synths (same lock order as the
    // metronome thread: image, then synths). The processed grid is reset:
    // the frontend re-renders it right after (apply_image_adjustments), and
    // until then no synth can read a full-resolution image as its grid.
    let image_state = app.state::<ImageState>();
    let synth_state = app.state::<SynthState>();
    let midi_state = app.state::<MidiState>();
    image_state.replace_original(img);

    let mut to_send = HashMap::<(usize, u8), ProgramState>::new();
    let synths_view: Vec<SessionSynth>;
    {
        let mut synths = synth_state.synths.lock_safe();
        // Turn off any sounding note (and pending gate) before dropping
        // the old synths
        for synth in synths.values_mut() {
            synth.stop_playback(&midi_state);
        }
        synths.clear();
        let mut max_id = 0;
        let mut max_display_number = 0;
        for RestoredSynth { synth, program } in restored {
            max_id = max_id.max(synth.id);
            max_display_number = max_display_number.max(synth.display_number);
            // Reconfigure the instruments: each saved program once per
            // (port, channel) — when several synths share a channel with
            // conflicting programs, the last one in file order wins
            if let Some(program) = program {
                to_send.insert((synth.config.midi_port, synth.config.channel), program);
            }
            synths.insert(synth.id, synth);
        }
        *synth_state.next_id.lock_safe() = max_id + 1;
        // The display-number counter continues past the highest restored
        // number, so a newly created synth never collides with an
        // existing default title
        *synth_state.next_display_number.lock_safe() = max_display_number + 1;

        // The frontend rebuilds its UI from the validated, sanitized state
        synths_view = file
            .synths
            .iter()
            .filter_map(|entry| {
                let synth = synths.get(&entry.id)?;
                Some(SessionSynth {
                    id: synth.id,
                    display_number: Some(synth.display_number),
                    name: synth.name.clone(),
                    color: session_color(&entry.color),
                    zones: synth.zones.clone(),
                    mute_zones: synth.mute_zones.clone(),
                    program: entry.program,
                    settings: synth.config.clone(),
                })
            })
            .collect();
    }

    // Outside the synth lock. Ports that no longer exist silently skip the
    // send (the program is still remembered and displayed). Banks travel
    // with the program in one explicit send: the instrument is
    // reconfigured even if it transmits nothing.
    for (&(port, channel), &program) in &to_send {
        midi_state.send_program_change(
            port,
            channel,
            program.program,
            program.bank_msb,
            program.bank_lsb,
        );
    }

    app.state::<SessionPaths>().allow(&path);

    Ok(Some(LoadedSession {
        version: file.version,
        path: path.to_string_lossy().into_owned(),
        bpm: file.bpm.clamp(20, 300),
        image_base64,
        orig_width,
        orig_height,
        image_settings: file.image_settings,
        synths: synths_view,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{NoteLength, ReadingDirection, Scale, SynthMode};

    /// A session saved before velocity_max existed must load with the
    /// default (127), not fail or fall back to 0. (The zone rides along
    /// to check the v3 run format deserializes too.)
    #[test]
    fn session_without_velocity_max_loads_with_default() {
        let json = r##"{
            "id": 1,
            "name": null,
            "color": "#3498db",
            "zones": [{"order": 0, "runs": [{"y": 0, "x0": 0, "x1": 1}, {"y": 1, "x0": 0, "x1": 1}]}],
            "velocity_min": 40
        }"##;
        let s: SessionSynth = serde_json::from_str(json).unwrap();
        assert_eq!(s.settings.velocity_min, 40);
        assert_eq!(s.settings.velocity_max, 127);
        assert_eq!(s.zones.len(), 1);
        assert_eq!(s.zones[0].pixel_count(), 4);
        // velocity_relative didn't exist either: defaults to the
        // historical relative mapping
        assert!(s.settings.velocity_relative);
        // Volume didn't exist in that format either: full volume
        assert_eq!(s.settings.volume, 127);
        // Programs didn't exist in that format either
        assert_eq!(s.program, None);
    }

    /// A session saved before the program field existed must load with
    /// program = None (older format compatibility).
    #[test]
    fn session_without_program_loads_with_none() {
        let json = r##"{
            "id": 1,
            "name": null,
            "color": "#3498db",
            "zones": [],
            "velocity_min": 0
        }"##;
        let s: SessionSynth = serde_json::from_str(json).unwrap();
        assert_eq!(s.program, None);
        // The display number didn't exist in that format either: it
        // deserializes to None, and the loader falls back to the id
        assert_eq!(s.display_number, None);
    }

    /// A session saved before the vibrance rename must load its saturation
    /// value as vibrance (older format compatibility).
    #[test]
    fn image_settings_saturation_key_loads_as_vibrance() {
        let json = r##"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "saturation": -30.0,
            "posterize_levels": 4
        }"##;
        let s: SessionImageSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.vibrance, -30.0);
        assert_eq!(s.grid_slider, 800);
    }

    /// The mirror zones mode is optional and accepts the legacy boolean:
    /// sessions saved before the feature load with zones hidden, ones
    /// saved with the two-state toggle map true → "all" / false → "none",
    /// and the three modes round-trip.
    #[test]
    fn image_settings_mirror_zones_mode_compat_and_round_trip() {
        // Session saved before the feature: the key is absent
        let legacy = r##"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "posterize_levels": 4
        }"##;
        let s: SessionImageSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(s.mirror_zones_mode, "none");

        // Two-state toggle era: the boolean maps onto the modes
        let shown = r##"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "posterize_levels": 4,
            "mirror_show_zones": true
        }"##;
        let s: SessionImageSettings = serde_json::from_str(shown).unwrap();
        assert_eq!(s.mirror_zones_mode, "all");

        let hidden = r##"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "posterize_levels": 4,
            "mirror_show_zones": false
        }"##;
        let s: SessionImageSettings = serde_json::from_str(hidden).unwrap();
        assert_eq!(s.mirror_zones_mode, "none");

        // Newer session: the mode survives a save → file → load cycle
        let json = serde_json::to_string(&SessionImageSettings {
            grid_slider: 800,
            contrast: 10.0,
            brightness: 5,
            vibrance: -30.0,
            posterize_levels: Some(4),
            texture: 0.0,
            clarity: 0.0,
            simplify: 0.0,
            auto_levels: true,
            mirror_zones_mode: "active".into(),
            mirror_effect: "none".into(),
            mirror_effect_options: HashMap::new(),
            mirror_effect_synths: Vec::new(),
        })
        .unwrap();
        let restored: SessionImageSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.mirror_zones_mode, "active");

        // An unknown mode is a parse error rather than a silent fallback
        let invalid = r#"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "posterize_levels": 4,
            "mirror_zones_mode": "sometimes"
        }"#;
        assert!(serde_json::from_str::<SessionImageSettings>(invalid).is_err());
    }

    /// The projection effect is optional: sessions saved before the
    /// feature load with the no-op default, and an id + options set
    /// survives a save → file → load cycle. Unlike the zones mode, an
    /// unknown id is not a parse error — the frontend registry owns
    /// the ids and falls back on restore.
    #[test]
    fn image_settings_mirror_effect_defaults_and_round_trip() {
        // Session saved before the feature: the keys are absent
        let legacy = r#"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "posterize_levels": 4
        }"#;
        let s: SessionImageSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(s.mirror_effect, "none");
        assert!(s.mirror_effect_options.is_empty());
        assert!(s.mirror_effect_synths.is_empty());

        // Newer session: the effect and its options round-trip
        let json = serde_json::to_string(&SessionImageSettings {
            grid_slider: 800,
            contrast: 10.0,
            brightness: 5,
            vibrance: -30.0,
            posterize_levels: Some(4),
            texture: 0.0,
            clarity: 0.0,
            simplify: 0.0,
            auto_levels: true,
            mirror_zones_mode: "all".into(),
            mirror_effect: "drag".into(),
            mirror_effect_options: HashMap::from([
                ("length".into(), 20.0),
                ("colored".into(), 1.0),
                ("fade".into(), 6.0),
            ]),
            mirror_effect_synths: vec![2, 3],
        })
        .unwrap();
        let restored: SessionImageSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.mirror_effect, "drag");
        assert_eq!(restored.mirror_effect_options.get("length"), Some(&20.0));
        assert_eq!(restored.mirror_effect_synths, vec![2, 3]);

        // An id the registry does not know (yet) parses fine
        let unknown = r#"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "posterize_levels": 4,
            "mirror_effect": "holograms"
        }"#;
        let s: SessionImageSettings = serde_json::from_str(unknown).unwrap();
        assert_eq!(s.mirror_effect, "holograms");
    }

    /// The save payload (SessionUi) accepts the mirror effect keys as
    /// optional too: an older frontend state saves without them.
    #[test]
    fn session_ui_without_mirror_effect_loads_with_default() {
        let legacy = r#"{
            "bpm": 120,
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "vibrance": 0.0,
            "posterize_levels": null,
            "texture": 0.0,
            "clarity": 0.0,
            "simplify": 0.0,
            "synth_colors": []
        }"#;
        let ui: SessionUi = serde_json::from_str(legacy).unwrap();
        assert_eq!(ui.mirror_effect, "none");
        assert!(ui.mirror_effect_options.is_empty());
    }

    fn session_with(synths: Vec<SessionSynth>) -> SessionFile {
        SessionFile {
            version: SESSION_VERSION,
            bpm: 120,
            image: SessionImage {
                data: String::new(),
            },
            image_settings: serde_json::from_str(
                r#"{ "grid_slider": 1, "contrast": 0, "brightness": 0, "posterize_levels": null }"#,
            )
            .unwrap(),
            synths,
        }
    }

    fn session_synth(id: u32) -> SessionSynth {
        SessionSynth {
            id,
            display_number: None,
            name: None,
            color: "#3498db".into(),
            zones: vec![],
            mute_zones: vec![],
            program: None,
            settings: SynthConfig::default(),
        }
    }

    #[test]
    fn validate_session_rejects_duplicate_and_extreme_ids() {
        let dup = session_with(vec![session_synth(1), session_synth(1)]);
        assert_eq!(
            validate_session(&dup).err().unwrap().code,
            "session_invalid"
        );
        let huge = session_with(vec![session_synth(u32::MAX)]);
        assert_eq!(
            validate_session(&huge).err().unwrap().code,
            "session_invalid"
        );
        let zero = session_with(vec![session_synth(0)]);
        assert!(validate_session(&zero).is_err());
        let ok = session_with(vec![session_synth(2), session_synth(1)]);
        assert_eq!(validate_session(&ok).unwrap().len(), 2);
    }

    #[test]
    fn validate_session_sanitizes_hand_edited_values() {
        let mut entry = session_synth(1);
        entry.settings.channel = 99;
        entry.settings.tempo_ratio = 1.33;
        entry.settings.note_lengths = vec![];
        entry.name = Some("   ".into());
        entry.zones = vec![Zone {
            order: 0,
            runs: vec![
                crate::zone::RowRun { y: 1, x0: 3, x1: 1 },
                crate::zone::RowRun { y: 0, x0: 0, x1: 0 },
            ],
        }];
        let restored = validate_session(&session_with(vec![entry])).unwrap();
        let synth = &restored[0].synth;
        assert_eq!(synth.config.channel, 15);
        assert_eq!(synth.config.tempo_ratio, 4.0 / 3.0);
        assert_eq!(synth.config.note_lengths, vec![NoteLength::Quarter]);
        assert_eq!(synth.name, None);
        assert_eq!(synth.zones[0].runs[0].y, 0);
        assert_eq!(
            (synth.zones[0].runs[1].x0, synth.zones[0].runs[1].x1),
            (1, 3)
        );
    }

    /// Round-trip check: a synth's full parameter set survives a
    /// save → file → load cycle.
    #[test]
    fn session_synth_round_trip() {
        // A synth with every parameter away from its default
        let mut synth = SynthConfig::default().to_synth(7);
        synth.config.tempo_ratio = 0.5;
        synth.config.channel = 9;
        synth.config.midi_port = 2;
        synth.config.mode = SynthMode::Polyphonic;
        synth.config.loop_enabled = false;
        synth.config.back_and_forth = true;
        synth.config.reading_direction = ReadingDirection::BottomToTop;
        synth.config.sorted_reading = true;
        synth.config.velocity_min = 40;
        synth.config.velocity_max = 110;
        synth.config.velocity_relative = false;
        synth.config.volume = 55;
        synth.config.hue_shift = 180;
        synth.config.channel_enabled = [true, false, true];
        synth.config.note_lengths = vec![NoteLength::Whole, NoteLength::Eighth];
        synth.config.note_length_reversed = true;
        synth.config.note_length_ternary = true;
        synth.config.note_sustain = false;
        synth.config.note_legato = true;
        synth.config.mono_note_range = [true, false, true];
        synth.config.voice_note_ranges = [
            [true, false, false],
            [false, true, false],
            [false, false, true],
        ];
        synth.config.scale = Scale::Blues;
        synth.config.scale_root = 9;

        let original = SessionSynth {
            id: 7,
            display_number: Some(7),
            name: Some("Lead".into()),
            color: "#3498db".into(),
            zones: vec![Zone::from_rect(0, 2, 3, 5, 4)],
            mute_zones: vec![Zone::from_rect(0, 3, 4, 1, 2)],
            program: Some(ProgramState {
                bank_msb: Some(1),
                bank_lsb: Some(32),
                program: Some(41),
            }),
            settings: SynthConfig::from_synth(&synth),
        };

        // Serialize to the session-file format, then back
        let json = serde_json::to_string(&original).unwrap();
        let restored: SessionSynth = serde_json::from_str(&json).unwrap();

        // Every parameter must survive
        assert_eq!(restored.id, original.id);
        assert_eq!(restored.display_number, original.display_number);
        assert_eq!(restored.name, original.name);
        assert_eq!(restored.color, original.color);
        assert_eq!(restored.zones, original.zones);
        assert_eq!(restored.mute_zones, original.mute_zones);
        assert_eq!(restored.program, original.program);
        let s = restored.settings.to_synth(7);
        assert_eq!(s.config.tempo_ratio, synth.config.tempo_ratio);
        assert_eq!(s.config.channel, synth.config.channel);
        assert_eq!(s.config.midi_port, synth.config.midi_port);
        assert_eq!(s.config.mode, synth.config.mode);
        assert_eq!(s.config.loop_enabled, synth.config.loop_enabled);
        assert_eq!(s.config.back_and_forth, synth.config.back_and_forth);
        assert_eq!(s.config.reading_direction, synth.config.reading_direction);
        assert_eq!(s.config.sorted_reading, synth.config.sorted_reading);
        assert_eq!(s.config.velocity_min, synth.config.velocity_min);
        assert_eq!(s.config.velocity_max, synth.config.velocity_max);
        assert_eq!(s.config.velocity_relative, synth.config.velocity_relative);
        assert_eq!(s.config.volume, synth.config.volume);
        assert_eq!(s.config.hue_shift, synth.config.hue_shift);
        assert_eq!(s.config.channel_enabled, synth.config.channel_enabled);
        assert_eq!(s.config.note_lengths, synth.config.note_lengths);
        assert_eq!(
            s.config.note_length_reversed,
            synth.config.note_length_reversed
        );
        assert_eq!(
            s.config.note_length_ternary,
            synth.config.note_length_ternary
        );
        assert_eq!(s.config.note_sustain, synth.config.note_sustain);
        assert_eq!(s.config.note_legato, synth.config.note_legato);
        assert_eq!(s.config.mono_note_range, synth.config.mono_note_range);
        assert_eq!(s.config.voice_note_ranges, synth.config.voice_note_ranges);
        assert_eq!(s.config.scale, synth.config.scale);
        assert_eq!(s.config.scale_root, synth.config.scale_root);
    }
}

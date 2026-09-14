use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use tauri::{AppHandle, State};

use crate::config::SynthTemplate;
use crate::error::{err, AppError};
use crate::image_processing::encode_to_base64_png;
use crate::state::{ImageState, MidiState, PixelZone, ProgramState, SynthState};

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
    /// Zones visible in the projection mirror window. Absent in sessions
    /// saved before the feature: the mirror starts with zones hidden.
    #[serde(default)]
    pub mirror_show_zones: bool,
    pub synth_colors: Vec<SynthUiEntry>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct SynthUiEntry {
    pub id: u32,
    pub color: String,
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
    /// Zones visible in the projection mirror window (see SessionUi).
    #[serde(default)]
    pub mirror_show_zones: bool,
}

/// A synthesizer as stored in a session file: its identity, display color,
/// pixel zones (empty = nothing selected since version 2; in version 1 it
/// implicitly meant the whole image), settings (flattened SynthTemplate),
/// and the channel's program at save time so loading the session can
/// reconfigure the instruments to the same sounds.
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
    pub zones: Vec<PixelZone>,
    /// Manually silenced pixels (rests) among the selected zones. Absent
    /// in sessions saved before the feature: nothing is muted.
    #[serde(default)]
    pub mute_zones: Vec<PixelZone>,
    #[serde(default)]
    pub program: Option<ProgramState>,
    #[serde(flatten)]
    pub settings: SynthTemplate,
}

/// A self-contained work session: the original image (base64 PNG) plus
/// everything needed to restore the exact same state. `version` allows
/// future formats to stay backward-compatible.
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
#[derive(Serialize, Debug)]
pub struct LoadedSession {
    pub version: u32,
    pub bpm: u32,
    pub image_base64: String,
    pub orig_width: u32,
    pub orig_height: u32,
    pub image_settings: SessionImageSettings,
    pub synths: Vec<SessionSynth>,
}

/// Saves the current work session to a `.wysiwyl` file picked through a
/// native save dialog. Canceling the dialog is not an error.
#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    ui: SessionUi,
    image_state: State<'_, ImageState>,
    synth_state: State<'_, SynthState>,
    midi_state: State<'_, MidiState>,
) -> Result<(), AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("Wysiwyl session", &["wysiwyl"])
        .blocking_save_file();

    let Some(path) = file_path else {
        return Ok(()); // canceled
    };
    let path = path
        .as_path()
        .ok_or_else(|| err("invalid_file_path"))?;

    // Encode the original image (the processed grid is re-derived from it)
    let image_guard = image_state.original.lock().unwrap();
    let Some(img) = image_guard.as_ref() else {
        return Err(err("no_image_loaded"));
    };
    let mut buffer = Vec::new();
    img.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png)
        .map_err(|e| err("png_encoding_error").with_param("details", e))?;
    let image = SessionImage {
        data: general_purpose::STANDARD.encode(&buffer),
    };

    // Synths in display order, as given by the frontend's color list
    let synths_guard = synth_state.synths.lock().unwrap();
    let known_programs = midi_state.known_programs.lock().unwrap();
    let synths = ui
        .synth_colors
        .iter()
        .filter_map(|entry| {
            let synth = synths_guard.get(&entry.id)?;
            Some(SessionSynth {
                id: entry.id,
                display_number: Some(synth.display_number),
                name: synth.name.clone(),
                color: entry.color.clone(),
                zones: synth.zones.clone(),
                mute_zones: synth.mute_zones.clone(),
                // Snapshot of the channel state, so the session restores the
                // same sounds even if the synths changed channels since
                program: known_programs
                    .get(&(synth.midi_port, synth.channel))
                    .copied()
                    .filter(|p| p.is_known()),
                settings: SynthTemplate::from_synth(synth),
            })
        })
        .collect();

    let file = SessionFile {
        version: 2,
        bpm: ui.bpm,
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
            mirror_show_zones: ui.mirror_show_zones,
        },
        synths,
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| err("session_write_error").with_param("details", e))?;
    fs::write(path, json)
        .map_err(|e| err("session_write_error").with_param("details", e))?;
    Ok(())
}

/// Loads a `.wysiwyl` (or legacy `.soundmap`) file picked through a native open dialog and
/// reinstalls its whole state (image, synths) into the backend. Returns
/// the session's content for the frontend to rebuild its UI; `None` means
/// the dialog was canceled.
#[tauri::command]
pub async fn load_session(
    app: AppHandle,
    image_state: State<'_, ImageState>,
    synth_state: State<'_, SynthState>,
    midi_state: State<'_, MidiState>,
) -> Result<Option<LoadedSession>, AppError> {
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
        .ok_or_else(|| err("invalid_file_path"))?;

    let content = fs::read_to_string(path)
        .map_err(|e| err("session_read_error").with_param("details", e))?;
    let file: SessionFile = serde_json::from_str(&content)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;

    // Decode the original image
    let bytes = general_purpose::STANDARD
        .decode(&file.image.data)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    let img: DynamicImage = image::load_from_memory(&bytes)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    let (orig_width, orig_height) = img.dimensions();
    let image_base64 = encode_to_base64_png(&img)?;

    // Reinstall the image first, then the synths (same lock order as the
    // metronome thread: image, then synths)
    {
        let mut original = image_state.original.lock().unwrap();
        let mut processed = image_state.processed.lock().unwrap();
        *original = Some(img.clone());
        *processed = Some(img);
    }

    {
        let mut synths = synth_state.synths.lock().unwrap();
        // Turn off any sounding note before dropping the old synths
        for synth in synths.values_mut() {
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
        synths.clear();
        let mut max_id = 0;
        let mut max_display_number = 0;
        for entry in &file.synths {
            let mut synth = entry.settings.to_synth(entry.id);
            synth.name = entry.name.clone();
            synth.zones = entry.zones.clone();
            synth.mute_zones = entry.mute_zones.clone();
            // Sessions predating the display number: fall back to the
            // saved id, itself stable across this session's lifetime
            synth.display_number = entry.display_number.unwrap_or(entry.id);
            max_id = max_id.max(entry.id);
            max_display_number = max_display_number.max(synth.display_number);
            synths.insert(entry.id, synth);
        }
        *synth_state.next_id.lock().unwrap() = max_id + 1;
        // The display-number counter continues past the highest restored
        // number, so a newly created synth never collides with an
        // existing default title
        *synth_state.next_display_number.lock().unwrap() = max_display_number + 1;
    }

    // Reconfigure the instruments: send each saved program once per
    // (port, channel) — when several synths share a channel with
    // conflicting programs, the last one in file order wins. Ports that
    // no longer exist silently skip the send (the program is still
    // remembered and displayed).
    {
        let mut to_send = std::collections::HashMap::<(usize, u8), ProgramState>::new();
        for entry in &file.synths {
            let Some(program) = entry.program else { continue };
            let (port, channel) = {
                let synths = synth_state.synths.lock().unwrap();
                let Some(synth) = synths.get(&entry.id) else { continue };
                (synth.midi_port, synth.channel)
            };
            to_send.insert((port, channel), program);
        }
        for (&(port, channel), &program) in &to_send {
            // Banks travel with the program in one explicit send: the
            // instrument is reconfigured even if it transmits nothing.
            midi_state.send_program_change(
                port,
                channel,
                program.program,
                program.bank_msb,
                program.bank_lsb,
            );
        }
    }

    Ok(Some(LoadedSession {
        version: file.version,
        bpm: file.bpm,
        image_base64,
        orig_width,
        orig_height,
        image_settings: file.image_settings,
        synths: file.synths,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{NoteLength, ReadingDirection, Scale, SynthMode};

    /// A session saved before velocity_max existed must load with the
    /// default (127), not fail or fall back to 0.
    #[test]
    fn session_without_velocity_max_loads_with_default() {
        let json = r##"{
            "id": 1,
            "name": null,
            "color": "#3498db",
            "zones": [{"x": 0, "y": 0, "w": 2, "h": 2}],
            "velocity_min": 40
        }"##;
        let s: SessionSynth = serde_json::from_str(json).unwrap();
        assert_eq!(s.settings.velocity_min, 40);
        assert_eq!(s.settings.velocity_max, 127);
        // velocity_relative didn't exist either: defaults to the
        // historical relative mapping
        assert!(s.settings.velocity_relative);
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

    /// The mirror zones toggle is optional: sessions saved before the
    /// feature load with zones hidden, newer ones round-trip the value.
    #[test]
    fn image_settings_mirror_show_zones_defaults_and_round_trip() {
        // Session saved before the feature: the key is absent
        let legacy = r##"{
            "grid_slider": 800,
            "contrast": 10.0,
            "brightness": 5,
            "posterize_levels": 4
        }"##;
        let s: SessionImageSettings = serde_json::from_str(legacy).unwrap();
        assert!(!s.mirror_show_zones);

        // Newer session: the value survives a save → file → load cycle
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
            mirror_show_zones: true,
        })
        .unwrap();
        let restored: SessionImageSettings = serde_json::from_str(&json).unwrap();
        assert!(restored.mirror_show_zones);
    }

    /// Round-trip check: a synth's full parameter set survives a
    /// save → file → load cycle.
    #[test]
    fn session_synth_round_trip() {
        // A synth with every parameter away from its default
        let mut synth = SynthTemplate::default().to_synth(7);
        synth.tempo_ratio = 0.5;
        synth.channel = 9;
        synth.midi_port = 2;
        synth.mode = SynthMode::Polyphonic;
        synth.loop_enabled = false;
        synth.back_and_forth = true;
        synth.reading_direction = ReadingDirection::BottomToTop;
        synth.sorted_reading = true;
        synth.brightness_min = 12;
        synth.brightness_max = 100;
        synth.velocity_min = 40;
        synth.velocity_max = 110;
        synth.velocity_relative = false;
        synth.hue_shift = 180;
        synth.channel_enabled = [true, false, true];
        synth.note_lengths = vec![NoteLength::Whole, NoteLength::Eighth];
        synth.note_length_reversed = true;
        synth.note_sustain = false;
        synth.mono_note_range = [true, false, true];
        synth.voice_note_ranges = [[true, false, false], [false, true, false], [false, false, true]];
        synth.scale = Scale::Blues;
        synth.scale_root = 9;

        let original = SessionSynth {
            id: 7,
            display_number: Some(7),
            name: Some("Lead".into()),
            color: "#3498db".into(),
            zones: vec![PixelZone { x: 2, y: 3, w: 5, h: 4 }],
            mute_zones: vec![PixelZone { x: 3, y: 4, w: 1, h: 2 }],
            program: Some(ProgramState {
                bank_msb: Some(1),
                bank_lsb: Some(32),
                program: Some(41),
            }),
            settings: SynthTemplate::from_synth(&synth),
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
        assert_eq!(s.tempo_ratio, synth.tempo_ratio);
        assert_eq!(s.channel, synth.channel);
        assert_eq!(s.midi_port, synth.midi_port);
        assert_eq!(s.mode, synth.mode);
        assert_eq!(s.loop_enabled, synth.loop_enabled);
        assert_eq!(s.back_and_forth, synth.back_and_forth);
        assert_eq!(s.reading_direction, synth.reading_direction);
        assert_eq!(s.sorted_reading, synth.sorted_reading);
        assert_eq!(s.brightness_min, synth.brightness_min);
        assert_eq!(s.brightness_max, synth.brightness_max);
        assert_eq!(s.velocity_min, synth.velocity_min);
        assert_eq!(s.velocity_max, synth.velocity_max);
        assert_eq!(s.velocity_relative, synth.velocity_relative);
        assert_eq!(s.hue_shift, synth.hue_shift);
        assert_eq!(s.channel_enabled, synth.channel_enabled);
        assert_eq!(s.note_lengths, synth.note_lengths);
        assert_eq!(s.note_length_reversed, synth.note_length_reversed);
        assert_eq!(s.note_sustain, synth.note_sustain);
        assert_eq!(s.mono_note_range, synth.mono_note_range);
        assert_eq!(s.voice_note_ranges, synth.voice_note_ranges);
        assert_eq!(s.scale, synth.scale);
        assert_eq!(s.scale_root, synth.scale_root);
    }
}

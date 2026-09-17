pub mod config;
pub mod error;
pub mod image_processing;
pub mod metronome;
pub mod midi;
pub mod session;
pub mod state;
pub mod synth;
pub mod zone;

use config::ConfigState;
use metronome::MetronomeState;
use state::{ImageState, MidiState, SynthState};
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ImageState::default())
        .manage(MetronomeState::default())
        .manage(SynthState::default())
        .manage(MidiState::default())
        .manage(ConfigState {
            config: std::sync::Mutex::new(config::AppConfig::default()),
        })
        .setup(|app| {
            let midi_state = app.state::<MidiState>();
            midi::auto_connect(&midi_state);
            midi::start_midi_input_listeners(app.handle(), &midi_state);
            // The app's own virtual MIDI input port, for a DAW to send its
            // MIDI clock straight to Wysiwyl (Unix only)
            #[cfg(unix)]
            midi::start_virtual_input_listener(app.handle());

            // Load the persisted configuration and apply it
            let loaded = config::load_config(app.handle());
            {
                let config_state = app.state::<ConfigState>();
                *config_state.config.lock().unwrap() = loaded.clone();
            }
            let metronome_state = app.state::<MetronomeState>();
            metronome_state
                .bpm
                .store(loaded.default_bpm, std::sync::atomic::Ordering::Relaxed);
            metronome_state.apply_clock_mode(loaded.clock_mode, loaded.clock_source.clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::open_config_file,
            config::set_max_image_size,
            config::set_default_bpm,
            config::set_default_synth_from,
            image_processing::load_image,
            image_processing::rotate_image,
            image_processing::crop_image,
            image_processing::preview_image_transform,
            image_processing::apply_image_transform,
            image_processing::apply_image_adjustments,
            image_processing::set_grid_width,
            midi::list_midi_ports,
            midi::list_midi_input_ports,
            midi::get_known_programs,
            synth::set_synth_program,
            session::save_session,
            session::load_session,
            metronome::start_metronome,
            metronome::stop_metronome,
            metronome::set_metronome_bpm,
            metronome::set_clock_mode,
            metronome::is_metronome_running,
            metronome::step_synth,
            synth::add_synth,
            synth::remove_synth,
            synth::set_synth_order,
            synth::start_synth,
            synth::stop_synth,
            synth::panic_all,
            synth::reset_synth_cursor,
            synth::is_synth_playing,
            synth::set_synth_channel,
            synth::set_synth_midi_port,
            synth::set_synth_name,
            synth::set_synth_tempo,
            synth::set_synth_brightness_range,
            synth::set_synth_velocity_range,
            synth::set_synth_velocity_relative,
            synth::set_synth_volume,
            synth::set_synth_loop,
            synth::set_synth_back_n_forth,
            synth::set_synth_reading_direction,
            synth::set_synth_sorted_reading,
            synth::set_synth_zones,
            synth::set_synth_mute_zones,
            synth::set_synth_mode,
            synth::set_synth_hue_shift,
            synth::set_synth_note_lengths,
            synth::set_synth_note_length_reversed,
            synth::set_synth_note_sustain,
            synth::set_synth_note_ranges,
            synth::set_synth_scale,
            synth::set_synth_channel_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("Error while launching the Tauri application");
}

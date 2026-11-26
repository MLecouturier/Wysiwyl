# Wysiwyl

*What You See Is What You Listen*

*[Version française](README.fr.md)*

Wysiwyl is a Tauri desktop app that turns an image into music: load a picture, turn it into a pixel grid, and let one or more synthesizers read that grid to produce real-time MIDI notes — color becomes pitch, brightness becomes rhythm.

## Features

### Image
- Native load dialog; preview with an original/processed toggle.
- Pixel grid: number of columns (log slider, height deduced from the aspect ratio); shrinking the grid re-clips the zones.
- Adjustments: brightness, contrast, vibrance, posterize, texture, clarity, simplify and auto levels, plus Floyd–Steinberg dithering (levels, diffusion, serpentine). Double-click a slider to reset it.
- Rotation (90° steps), crop (free or 1:1 / 4:3 / 3:2 / 16:9), fine rotation and perspective; zoom/pan the preview with the wheel and drag.
- While a synth plays, the structural controls (load, rotate, crop, transform, grid) lock; value adjustments stay live and apply at the next step.
- **Projection window** (second screen, fullscreen): stacks the original and the processed grid. A masking effect pierces the top layer — *Drag* (a fading trail behind each playhead) or *Frontline* (the perpendicular line) — with adjustable length, fade and tint. The "Show original" toggle swaps the two stacked layers. Zones are hidden by default and cycled with a button (all synths / visible only / none).

### LFOs
- Two LFOs (cyan, magenta) with 5 waveforms (sine, triangle, saw, square, sample & hold) and a frequency set by dragging the graph (in Hz or metronome beats; double-click resets).
- Each LFO can drive any adjustable setting — the seven image sliders, plus each synth's hue shift and channel volume — with its own amount and phase (100 % = anti-phase). One LFO can drive several settings. A dot next to a slider assigns it; a ghost thumb and the readout follow the modulated value.

### Synthesizers
Create any number of independent synthesizers, each reading the grid on its own and sending MIDI in real time, driven by a shared metronome.

- **Modes** — Monophonic (hue → one note, with a 0–360° hue-shift slider) or Polyphonic (R/G/B read independently → a 1-to-3-note chord; channels can be toggled, hovering them shows their intensity map).
- **Zones** — select the played pixels with rectangles, lassos or a magic wand (adjacent/non-adjacent, adjustable tolerance). Stored as exact connected components; a click/drag from a free pixel adds, from a selected one removes; editable during playback. Hover a pixel to preview its note.
- **Silences** — Shift toggles a manual silence on the selected pixels (still travelled by the playhead, silent), Alt+Shift removes it. A 16-step **silence pattern** can be stamped by clicking a zone (optionally repeated).
- **Reading** — direction (left→right, right→left, top→bottom, bottom→top, two spirals); a "sort" toggle merges the zones into one sweep by absolute position.
- **Transport** — play/stop, rewind, step forward; loop, back-and-forth or one-shot; per-synth tempo ratio (1/2 … 3/2 of the metronome).
- **Note lengths** — sixteenth, eighth, quarter, half, whole: the pixel's brightness picks its length; reverse, ternary (triplets), sustained/pizzicato articulation and legato are available.
- **Timing** — quantize to the master tempo (resync period 1–8 beats) and chance (per-step play probability).
- **Accent** — per-beat velocity levels (off / weak / normal / strong), multiplied by global values from the config file.
- **Note range** — cumulative bass (21–47), medium (48–71), treble (72–108) filters (bounds configurable), one per voice in polyphonic mode; the note is rescaled across the allowed range.
- **Scale** — snap the notes to one of 14 scales, with a selectable tonic (Chromatic = no quantization).
- **Velocity** — min–max window, in relative (rescale) or clamp mode.
- **MIDI** — port, channel (1–16, first free by default), channel volume (CC 7) with mute, and bank/program selection.
- **Organisation** — color tag, zone-highlight toggle, info panel (pixel, note, ranges), rename (double-click), reorder by drag, copy parameters/zones from another synth, safe removal (click twice), save as default template.
- **Contextual help** — a footer button enables hover explanations on any control.
- **List** — play all / stop all and a panic button (cuts every sounding note); the metronome starts and stops on its own.

### MIDI Output
- The first available port is connected at startup; each synth can target its own port (opened lazily).
- Real-time Note On/Off with clean note-offs; the engine runs at 12 wakes per beat, so note lengths stay accurate.

### Using Wysiwyl with a DAW
- **Virtual port** "Wysiwyl" (output): appears as a MIDI input in the DAW to drive a software instrument. Windows has no virtual ports — use loopMIDI instead.
- **Tempo sync**: the app also exposes a virtual input port; send the DAW's MIDI clock to it and the metronome follows the project tempo ("Sync DAW" badge, controls disabled, sixteenth-note alignment). Ableton Live on macOS ignores virtual ports: use the IAC bus.
- **Clock source** (config `clock_mode`): *Internal* (own tempo only), *Auto* (default, follows any incoming clock), *Source…* (only the chosen input), *Master* (broadcasts its own 24 ppqn clock to every output while playing).
- The transport always stays in Wysiwyl; the clock only carries the tempo (and, in master mode, the play state).

### Work Sessions
- Save/load a self-contained `.wysiwyl` file: original image (base64 PNG), adjustments, LFOs and assignments, metronome, and every synth with its full configuration.
- Format version 3 (run-length zones); older files are refused with a clear message. Playback state is not restored. Closing with unsaved changes prompts to save.

### Global Configuration
A JSON file (opened with the gear button) holds app-wide options, applied at startup; once opened it is watched and reloads live. Keys:

- `max_image_size` — longest side of imported images (0 = capped to 8192).
- `default_bpm` — startup tempo.
- `clock_mode` / `clock_source` — clock source and its input port.
- `time_signature` — accent-grid frame ("4/4", "7/8"… or any "n/d": n 1–16, d 1/2/4/8/16).
- `accent_levels` — velocity multipliers of the four accent levels.
- `note_range_bounds` — low/high note bounds of the bass/medium/treble filters.
- `synth_colors` — palette of the synth color picker.
- `enabled_scales` — scales offered in the synth scale selects.
- `default_synth` — template applied to new synths.
- `wheel_trackpad_threshold` — scroll sensitivity of the value fields.
- `pizzicato_gate_ms` — minimum note duration in pizzicato mode.
- `undo_depth` — depth of the zone/silence undo history.

### Keyboard Shortcuts
A footer button opens the full list. Main ones: Space (play/stop all), Shift+Space (panic), 1–8 (reveal a synth), Ctrl/Cmd+1–8 (play/stop), Alt+1–8 (mute), Ctrl/Cmd+S / O (save / open), Ctrl/Cmd+Z / Shift+Z (undo / redo), Ctrl/Cmd+M (projection), Esc (cancel), Enter (apply crop/transform).

### Automatic Updates
- Silent check at startup and a manual one from the footer; the button is badged and the title shows the new version.
- "Install and restart" downloads the signed bundle, verifies it against the app's minisign public key, installs and relaunches. Only published stable releases are followed.
- **One-time setup** — `cargo tauri signer generate -w ~/.tauri/wysiwyl.key`, put the public key in `tauri.conf.json` (`plugins.updater.pubkey`) and the private key + password in the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` CI secrets. macOS builds are ad-hoc signed (`signingIdentity: "-"`), so Gatekeeper still asks on first launch.

## Tech Stack
- **Tauri 2** (desktop app + front/back IPC), **Rust 2021** (image processing, state, real-time MIDI), **vanilla HTML/SCSS/JS** (no framework, no bundler).
- Crates: `tauri`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-updater`, `image`, `midir`, `crossbeam-channel`, `serde` / `serde_json`, `base64`.

## Front-end Conventions
- Plain HTML/SCSS/JS: utility classes (`_utilities.scss`, loaded last) + component classes (one file per area) + runtime state classes (`.hidden`, `.active`, `.locked`…).
- `id`s are `querySelector` hooks only — CSS never targets an id; repeated elements use classes and `data-synth-id`.
- Semantic colors: blue = active, red = playing / destructive confirmation, green = transient confirmation.
- `styles.scss` is the entry point; its `@use` order is the cascade. Dynamic markup lives in `src/templates/*.html`, loaded by `js/core/templates.js` and cloned by `main.js`.
- Compiled CSS is committed: after editing SCSS, run `sass scss/styles.scss:css/styles.css scss/mirror.scss:css/mirror.css` from `src/` (Node.js is not required).

## Installation
- [Rust](https://www.rust-lang.org/tools/install) with Cargo, the Tauri system dependencies, and the CLI (`cargo install tauri-cli`). Node.js is not required.

## Usage
```bash
cargo tauri dev     # development
cargo tauri build   # distributable
npm test            # JS tests — cargo test for the Rust ones
```
In the app: load an image and set the grid and adjustments; add synthesizers and pick a MIDI port, channel and color; draw zones; press Play (or "play all"); save the session as a `.wysiwyl` file.

## Project Structure
```text
wysiwyl/
├── LICENSE
├── README.md / README.fr.md
├── package.json
├── src/
│   ├── index.html          # main window
│   ├── viewer.html         # projection window
│   ├── assets/  fonts/  i18n/
│   ├── css/                # compiled styles (+ .min)
│   ├── scss/               # _variables, _mixins, _fonts, _reset, _utilities, components/
│   ├── templates/          # synth card / tab / note-range
│   └── js/
│       ├── main.js
│       └── audio/  core/  image/  mirror/  session/  synth/
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs  lib.rs  state.rs  error.rs
        ├── config.rs  session.rs  image_processing.rs
        ├── synth.rs  metronome.rs  midi.rs  updater.rs
        └── fsutil.rs  gate.rs  locks.rs  zone.rs
```

The backend exposes Tauri commands to load and adjust images, manage synthesizers (zones, playback, MIDI, mode, tempo, note lengths, ranges, scales…), drive the metronome, persist the configuration and sessions, and check/install updates.

## License
GNU GPL v3 — free to use, modify and redistribute, provided derivative works are also published under GPLv3 with their sources. See [LICENSE](LICENSE).

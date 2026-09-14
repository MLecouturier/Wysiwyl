# Wysiwyl

*What You See Is What You Listen*

*[Version française](README.fr.md)*

Wysiwyl is a Tauri desktop application that turns an image into music. Load an image, turn it into a pixel grid, and let one or more synthesizers read that grid to generate real-time MIDI notes — turning colors and brightness into sound.

## Main Features

### Image Processing

- Loading an image via a native file dialog.
- Preview of the original image and the processed image, with a toggle to switch between the two.
- Resizing into a pixel grid, where each cell becomes one step in the sequence.
- Adjusting the number of columns with a logarithmic-scale slider (the height is deduced automatically to preserve the aspect ratio).
- Saturation, contrast, brightness, and posterization (color/brightness level reduction) adjustments.
- Resetting all processing parameters to their default values.
- While any synthesizer is playing, the structural image controls (loading, rotation, crop, transform, grid size) are automatically locked to keep the pixel grid stable. The value adjustments (saturation, contrast, brightness, posterization) stay editable: their effect is applied live to the playback, at the next metronome step ("Show original" also stays available).

### Synthesizers

You can create any number of independent synthesizers, each reading the pixel grid on its own and sending MIDI notes in real time, driven by a shared metronome (tempo in BPM). Each synthesizer can run at its own fraction of the main tempo, so several synths can drift apart and create polyrhythms.

- **Two pixel-to-note translation modes, switchable per synthesizer:**
  - **Monophonic** — the pixel's hue (HSL color wheel) determines a single note. A hue shift slider (0–360°) lets you rotate the color wheel to change the dominant tonality of the piece.
  - **Polyphonic** — each color channel (Red, Green, Blue) is read independently and mapped to its own note, forming a 1-to-3-note chord. Each channel can be enabled or disabled individually. Hovering over the R/G/B toggle buttons displays that channel's intensity map directly over the image, to help you decide which channels to use.
- **Rectangular zones** — select the pixels each synthesizer plays by drawing rectangles directly on the image. All pixels are selected by default; a rectangle dragged from a free pixel adds a zone, while one dragged from an already selected pixel removes those pixels instead — a simple click selects or deselects a single pixel. The zone row also displays the total number of selected pixels. Zones can be edited while the synth is playing: the playhead stays on the pixel it is playing (it is remapped into the new selection), and the zone under the playhead is locked against erasure — an erasing drag touching it is cancelled. Emptying the zones stops the synth cleanly.
- **Manual silences** — hold Alt (Option) while using the square or lasso selection tool to add or remove rests among the selected pixels: a silent pixel is still travelled by the playhead, it just sounds nothing. A rectangle dragged over existing silences removes them, otherwise it silences the selected pixels it covers; the lasso toggles every enclosed selected pixel. Silenced pixels get the same veil and rest glyph as too-dark pixels, and always live within the selection: deselecting a pixel removes its silence.
- **Per-synth tempo** — each synthesizer can play at a fraction of the main metronome tempo (1/1, 3/4, 2/3, 1/2, 1/3 or 1/4 of the global BPM), letting synths desynchronize from one another for more dynamic music.
- **Custom name** — double-click a synthesizer's title to rename it; the name is saved in sessions.
- **MIDI output port per synthesizer** — each synth can send its notes to a different MIDI interface. Connections are opened lazily on first use, and the first available port is connected automatically at startup.
- **Reading direction** — a cycling button selects the order in which the pixel sequence is read: left to right, right to left, top to bottom, or bottom to top. A "sort" toggle changes how zones relate to that order: off, each zone is read in full one after the other, in the order they were drawn; on, the pixels of every zone are merged and read following their absolute position in the image — one continuous sweep. The playhead stays on its pixel when toggling.
- **Loop, back-and-forth, or one-shot playback** — a synthesizer can loop over its zones indefinitely, bounce back and forth between the sequence bounds (ping-pong), or play the sequence once and stop. Loop and back-and-forth are mutually exclusive and can both be off.
- **Note lengths** — toggle buttons for sixteenth, eighth, quarter, half and whole notes let the pixel's brightness choose the note's duration among the enabled lengths (the 0–127 brightness range is split into as many equal bands). Each pixel is played for exactly its note's duration, so the image's brightness contrast translates directly into rhythm. A reverse button flips the brightness→length direction (dark = long instead of bright = long); the quarter-note button always stays active.
- **MIDI note range filters** — bass (21–47), medium (48–71) and treble (72–108) toggles restrict the notes a synthesizer can play. Toggles are cumulative to extend the allowed range; with none active, the full 0–127 range is available. The raw note derived from the pixel is rescaled proportionally across the allowed range: the pitch rises gradually and continuously from the low to the high bound as the hue (or the channel value) increases. Monophonic mode has a single filter; each polyphonic R/G/B voice has its own.
- **Playback controls** — play/stop, rewind (resets the playhead to the beginning of the sequence) and step forward (manually advances by one pixel while paused, playing it with its own note length).
- **Brightness threshold** — a dual-handle slider defines the brightness range a pixel must fall into to be audible; pixels outside that range are silently skipped.
- **Minimum velocity** — sets the floor of the velocity range; pixel saturation is mapped between this floor and the maximum velocity (127). Vivid colors are played with a stronger attack, achromatic areas more delicately.
- **MIDI channel selection** per synthesizer (16 channels available), locked while the synthesizer is playing.
- **Color tagging** — each synthesizer is assigned a color (with a picker of predefined swatches), used to highlight its zones and its current playback position directly on the image.
- **Visibility toggle** for the zone highlight, automatically hidden during playback to only show the current playback cursor.
- **Compact view** — a toggle on each synthesizer collapses it to the strict minimum: only the playback controls (tempo, reading direction, loop, ping-pong, rewind, play/pause, step forward) remain visible, alongside the MIDI port, channel and title. Click again to get every setting back.
- **Safe removal** — deleting a synthesizer requires a confirmation: the first click arms the button (red) for 3 seconds, and only a second click within that window actually removes the synth; otherwise the button reverts to its normal state.
- **Contextual help** — a live-help button in the footer enables an on-hover help mode: hovering any control of the interface opens a detailed explanation window instead of the native tooltip, so first-time users can discover every setting without digging into this README. Click again or press Escape to leave the mode.
- Per-synthesizer play/stop, plus a "play all / stop all" button for the whole synthesizer list.
- The shared metronome starts automatically as soon as any synthesizer starts playing, and stops automatically once all synthesizers are idle.

### MIDI Output

- Automatic connection to the first available MIDI output port on startup; every synthesizer can be routed to its own port, with connections opened lazily on first use.
- Real-time Note On / Note Off messages: each pixel is played as a note with its own duration, with clean note-offs when stopping a synthesizer or switching modes. The engine ticks at a quarter-beat resolution so eighth and sixteenth note lengths stay accurate.

### Work Sessions

- **Save the whole state** into a single self-contained `.wysiwyl` file (native save dialog): the original image (embedded as base64 PNG), the image processing settings, the metronome tempo, and every synthesizer with its full configuration (name, color, zones, tempo, mode, note lengths, note ranges, thresholds, velocity, MIDI channel and port, reading direction, sorted reading, loop/back-and-forth).
- **Reopen a session** through a native open dialog: the image is re-derived from the original with the stored settings, and all the synthesizers are recreated exactly as they were left. Playback state (playhead positions, sounding notes) is deliberately not restored: everything restarts from the beginning.

### Global Configuration

A JSON configuration file (opened with a gear button in the application settings area) holds the app-wide options, hand-edited in a text editor and applied on the next start:

- **`max_image_size`** — longest side allowed for imported images; larger originals are downscaled on import (0 = unlimited).
- **`default_bpm`** — metronome tempo used at startup.
- **`default_synth`** — template applied to every newly created synthesizer; any existing synth can be saved as the template with its bookmark button ("Use this synth as the default template").

## Tech Stack

- **Tauri 2** for the desktop application and communication between the frontend and backend.
- **Rust 2021** for image processing, application state, and real-time MIDI generation.
- **Vanilla HTML, SCSS/CSS, and JavaScript** for the user interface, without any frontend framework or bundler.
- Relevant Rust crates:
  - [`tauri`](https://crates.io/crates/tauri) and [`tauri-plugin-dialog`](https://crates.io/crates/tauri-plugin-dialog) for the application and native dialogs;
  - [`image`](https://crates.io/crates/image) for loading and processing images;
  - [`midir`](https://crates.io/crates/midir) for real-time MIDI output;
  - [`serde`](https://crates.io/crates/serde) and [`serde_json`](https://crates.io/crates/serde_json) for data exchange between the frontend and backend;
  - [`base64`](https://crates.io/crates/base64) for sending PNG previews to the frontend.

## Installation

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install), with Cargo.
- The system dependencies required by Tauri on your platform.
- The Tauri CLI:

  ```bash
  cargo install tauri-cli
  ```

Node.js is **not required**: the frontend uses vanilla HTML, CSS, and JavaScript, without any frontend bundler or package manager.

### Getting the Project

From the project directory:

```bash
cd wysiwyl
```

## Usage

Run Wysiwyl in development mode:

```bash
cargo tauri dev
```

Build a distributable version:

```bash
cargo tauri build
```

In the application:

1. Load an image and adjust the grid size, saturation, contrast, brightness, and posterization settings. The preview updates live.
2. Add one or more synthesizers, choose a MIDI port, a MIDI channel and a color for each, and rename them by double-clicking their title.
3. Draw zones on the image to restrict what each synthesizer plays, pick a tempo per synth, and open the advanced options to configure the translation mode (monophonic/polyphonic), note lengths, note range filters, brightness threshold, and minimum velocity.
4. Press Play on a synthesizer (or "play all") to start hearing your image.
5. Save your work into a `.wysiwyl` session file (save button next to the image controls) and reopen it later to find everything back in place.

## Project Structure

```text
wysiwyl/
├── Cargo.toml
├── LICENSE
├── README.md
├── README.fr.md
├── package.json
├── src/
│   ├── index.html
│   ├── css/
│   │   └── styles.css
│   ├── i18n/
│   ├── scss/
│   │   └── styles.scss
│   └── js/
│       └── main.js
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── state.rs
        ├── error.rs
        ├── config.rs
        ├── session.rs
        ├── image_processing.rs
        ├── synth.rs
        ├── metronome.rs
        └── midi.rs
```

The backend exposes Tauri commands to load images, apply adjustments, retrieve pixel data, manage synthesizers (creation, playback, MIDI channel and port, mode, zones, tempo, note lengths, note ranges, reading direction, thresholds, velocity), drive the shared metronome, persist the global configuration, and save/load work sessions.

## License

This project is licensed under the GNU GPL v3. You are free to use, modify, and redistribute this code, provided that any derivative work is also published under GPLv3 with its sources. See the [LICENSE](LICENSE) file for the full text.

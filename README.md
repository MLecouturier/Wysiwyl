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

### Using Wysiwyl with a DAW

Wysiwyl exposes everything a DAW needs, with no hardware device required (macOS and Linux):

- **Virtual MIDI port** — the app's own virtual output port, "Wysiwyl", is created at startup and listed first in every synthesizer's port menu. It shows up in your DAW as a MIDI input: select it as the source of an instrument track, and Wysiwyl drives the track's software instrument. A user with no physical synth can therefore compose with Wysiwyl and hear it through the DAW.
- **Tempo sync (MIDI clock)** — the app also creates a virtual *input* port, likewise named "Wysiwyl". Point your DAW's MIDI clock output at it (Ableton Live: Preferences → Link/Tempo/MIDI → MIDI Sync Output; Bitwig, Reaper, Logic: MIDI clock/sync destination) and the metronome automatically follows the DAW's project tempo: a "Sync DAW" badge appears, the tempo controls are disabled while the clock streams, and playback steps align with the project's sixteenth-note grid. The tempo is learned from the 24 ppqn clock and smoothed; a Start/Continue message realigns the grid with the project's beats, a Stop message releases the sync immediately. When the DAW stops sending clock, the metronome keeps running at the last synced tempo and the controls are released.
- **Clock source** — the metronome block offers a clock source setting, persisted in the configuration file, with four modes: *Internal* (the tempo set in Wysiwyl is the only master, incoming clocks are ignored), *Auto sync* (the default, historical behavior described above: any incoming clock is followed), *Source…* (only the MIDI clock received on the chosen input port is followed — other devices streaming a clock are ignored), and *Master* (see below).
- **Master clock** — in *Master* mode Wysiwyl becomes the tempo master: it broadcasts its own MIDI clock (24 ppqn) to every MIDI output port — including the virtual "Wysiwyl" port and physical interfaces — while at least one synthesizer plays, so external hardware sequencers, arpeggiators and DAWs that follow an external clock play at the tempo set in Wysiwyl. A Start message is sent when playback begins and a Stop when it ends; the tempo controls stay active and drive every follower live. The clock streams only while a synth plays, following Wysiwyl's own playback lifecycle. The timing engine is sleep-based: the resulting jitter (about a millisecond) is fine for instruments and typical workflows, but a sample-accurate DAW sync would require a dedicated audio-clock.
- **Ableton Live on macOS** — Live does not list MIDI ports created by other applications, in either direction. To work with Live, enable the IAC bus (Audio MIDI Setup → double-click "IAC Driver" → "Device is online"): the IAC bus appears in Wysiwyl as an ordinary output port for the notes, and the DAW routes its MIDI clock to the IAC bus for the tempo sync. In master mode, Live and the hardware instruments can conversely follow Wysiwyl's clock through the same IAC bus.
- **Windows** — the WinMM backend has no virtual ports: use a loopMIDI bus instead, both for the notes (create a bus, it appears as an output port in Wysiwyl and a MIDI input in the DAW) and for the clock (route the DAW's MIDI clock to the same loopMIDI bus; Wysiwyl listens to every input port).
- Stopping and starting playback of the Wysiwyl synthesizers remains done from Wysiwyl: whatever the clock mode, the transport of Wysiwyl's own synthesizers is never driven by an external device — the clock only carries the tempo (and, in master mode, Wysiwyl's playback state for external followers).

### Work Sessions

- **Save the whole state** into a single self-contained `.wysiwyl` file (native save dialog): the original image (embedded as base64 PNG), the image processing settings, the metronome tempo, and every synthesizer with its full configuration (name, color, zones, tempo, mode, note lengths, note ranges, thresholds, velocity, MIDI channel and port, reading direction, sorted reading, loop/back-and-forth).
- **Reopen a session** through a native open dialog: the image is re-derived from the original with the stored settings, and all the synthesizers are recreated exactly as they were left. Playback state (playhead positions, sounding notes) is deliberately not restored: everything restarts from the beginning.

### Global Configuration

A JSON configuration file (opened with a gear button in the application settings area) holds the app-wide options, hand-edited in a text editor and applied on the next start:

- **`max_image_size`** — longest side allowed for imported images; larger originals are downscaled on import (0 = unlimited).
- **`default_bpm`** — metronome tempo used at startup.
- **`clock_mode`** — the metronome's clock source: `auto` (follow any incoming MIDI clock, the default), `off` (internal tempo only), `input` (follow the clock of `clock_source`) or `master` (broadcast a MIDI clock to every output port while playing). Set from the metronome block in the UI, which persists it here.
- **`clock_source`** — input port name the clock sync follows when `clock_mode` is `input`.
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

## Front-end Conventions

The interface is plain HTML/SCSS/JS (no framework, no bundler), organized around a hybrid utility/component model, so the markup can be read as a description of the layout.

### Three kinds of classes

- **Utility classes** — Tailwind-style single-purpose classes, hand-rolled in `src/scss/_utilities.scss` (`flex`, `flex-col`, `items-center`, `gap-2`, `mb-3`, `text-muted`, `hidden`...). They are loaded **last** in the cascade, so a utility always overrides a component class and the markup can fine-tune any component without new SCSS. The spacing and font-size scales are generated from SCSS maps at the top of the file.
- **Component classes** — one per UI region or control role (`.image-viewer`, `.controls`, `.mode-panel`, `.icon-btn`, `.synth-block`...), with their states and pseudo-elements nested in SCSS. They live in `scss/components/`, one file per area of the interface.
- **State classes** — toggled by JS at runtime: `.hidden` (with `!important`), `.active`, `.locked`, `.picking`, `.compact`, `.confirm-pending`, `.dragging`, `.reversed`...

### Ids are hooks, never styled

Every `id` — in the static pages as well as in the dynamic templates — exists only as a stable hook for `querySelector` or as a canvas layer; **CSS never targets an id**. Repeated dynamic elements (synth cards, tabs) are identified by classes and a `data-synth-id` attribute instead of generated ids.

### Semantic colors — one meaning each

- **Blue accent** — toggle/mode currently active;
- **Red** — playback in progress (stop affordance) and destructive action awaiting confirmation;
- **Green** — transient confirmation.

### SCSS organization

`styles.scss` is only the entry point: its `@use` order *is* the cascade order — fonts, reset, one component file per UI area, utilities last. Colors and design tokens are `$color-*` variables in `_variables.scss`. Dynamic markup built by `main.js` templates follows the same conventions; classes queried by the JS are hooks: never rename one without updating the matching `querySelector`.

### Stylesheet compilation

The compiled CSS is committed (`src/css/styles.css` + source map), so running the app needs no build step. After editing the SCSS, recompile with dart-sass (a standalone tool — Node.js is not required):

```bash
sass scss/styles.scss css/styles.css
```

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
│   ├── viewer.html
│   ├── css/
│   │   ├── styles.css
│   │   └── mirror.css
│   ├── fonts/
│   ├── i18n/
│   ├── scss/
│   │   ├── styles.scss
│   │   ├── _variables.scss
│   │   ├── _mixins.scss
│   │   ├── _fonts.scss
│   │   ├── _reset.scss
│   │   ├── _utilities.scss
│   │   └── components/
│   └── js/
│       ├── main.js
│       ├── mirror.js
│       ├── viewer-render.js
│       └── i18n.js
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

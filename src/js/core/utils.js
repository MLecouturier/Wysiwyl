// Shared pure utilities: RGB conversions, MIDI note naming,
// the image-control slider scales and the raw IPC image decoder.



// RGB color conversions for the pixel info line. Pure helpers: no DOM,
// no app state.

// Converts RGB (0–255) to HSL: hue in degrees 0–360, saturation and
// lightness in percent 0–100.
export function rgbToHsl(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return [0, 0, Math.round(l * 100)];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

// Formats the TSL (teinte, saturation, luminosité) values of a pixel for
// the info line; "-" when any channel is unknown.
export function rgbToTslStr(r, g, b) {
    if (r == null || g == null || b == null) return '-';
    const [h, s, l] = rgbToHsl(r, g, b);
    return `${h}°, ${s}%, ${l}%`;
}

// MIDI note naming, shared by the note-range tooltips, the pixel info
// line and the scale-root select. Pure helpers: no DOM, no app state.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Scientific pitch notation: "C4" for MIDI note 60.
export function midiNoteName(n) {
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

// "C4 (60)" for the pixel info line; "-" when the note is unknown.
export function midiNoteToName(midi) {
    if (midi == null) return '-';
    return `${midiNoteName(midi)} (${midi})`;
}

// Slider ↔ value mappings for the image controls: the logarithmic
// column-count scale and the posterize level scale. Pure functions (the
// caller passes the raw slider value and the image's max columns), so
// they are unit-testable without the DOM.

export const SLIDER_STEPS = 1000;
export const MIN_CELLS = 2;

// Position 0 = off; positions 1..SLIDER_STEPS map linearly from
// POSTERIZE_MAX_LEVELS levels (left) down to POSTERIZE_MIN_LEVELS (right).
export const POSTERIZE_MIN_LEVELS = 2;
export const POSTERIZE_MAX_LEVELS = 64;

// ---------- Logarithmic column scale ----------
export function sliderToCells(v, maxCells) {
    if (!maxCells || maxCells < MIN_CELLS) return MIN_CELLS;
    const lmin = Math.log(MIN_CELLS);
    const lmax = Math.log(maxCells);
    const cells = Math.round(Math.exp(lmin + (lmax - lmin) * (v / SLIDER_STEPS)));
    return Number.isFinite(cells)
        ? Math.min(maxCells, Math.max(MIN_CELLS, cells))
        : MIN_CELLS;
}

// Inverse of sliderToCells: the slider position that maps to the given
// column count. The logarithmic mapping rounds cells at every step, so
// the analytic position is walked until it lands exactly on the count —
// or on the nearest reachable one at the top of the range, where one
// slider step spans several columns.
export function cellsToSlider(cells, maxCells) {
    if (!maxCells || maxCells < MIN_CELLS) return SLIDER_STEPS;
    const lmin = Math.log(MIN_CELLS);
    const lmax = Math.log(maxCells);
    let v = Math.round(((Math.log(cells) - lmin) / (lmax - lmin)) * SLIDER_STEPS);
    v = Math.min(SLIDER_STEPS, Math.max(0, v));
    if (sliderToCells(v, maxCells) < cells) {
        while (v < SLIDER_STEPS && sliderToCells(v, maxCells) < cells) v++;
    } else {
        while (v > 0 && sliderToCells(v, maxCells) > cells) v--;
    }
    return v;
}

// ---------- Posterize scale ----------
export function sliderToPosterizeLevels(v) {
    if (v <= 0) return null; // off
    const t = (v - 1) / (SLIDER_STEPS - 1); // 0 at the first notch, 1 at the far right
    const levels = Math.round(
        POSTERIZE_MAX_LEVELS - t * (POSTERIZE_MAX_LEVELS - POSTERIZE_MIN_LEVELS)
    );
    return Math.min(POSTERIZE_MAX_LEVELS, Math.max(POSTERIZE_MIN_LEVELS, levels));
}

export function posterizeLevelsToSlider(levels) {
    if (levels == null || levels <= 1) return 0; // off
    // Sessions saved when the maximum was 255 may hold higher values:
    // clamp them to the weakest reachable position (the first notch)
    levels = Math.min(POSTERIZE_MAX_LEVELS, Math.max(POSTERIZE_MIN_LEVELS, levels));
    const t = (POSTERIZE_MAX_LEVELS - levels) / (POSTERIZE_MAX_LEVELS - POSTERIZE_MIN_LEVELS);
    let v = Math.round(t * (SLIDER_STEPS - 1)) + 1;
    v = Math.min(SLIDER_STEPS, Math.max(1, v));
    // The analytic position may round to a neighbor: nudge it until the
    // forward mapping gives back exactly `levels`
    while (v < SLIDER_STEPS && sliderToPosterizeLevels(v) > levels) v++;
    while (v > 1 && sliderToPosterizeLevels(v - 1) < levels) v--;
    return v;
}

// Decodes the raw IPC format the backend uses for processed images:
// an 8-byte header (width and height as little-endian u32) followed by
// the flat RGBA bytes. Pure, no DOM.

export function decodePixelResponse(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    return {
        width,
        height,
        rgba: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, width * height * 4),
    };
}

// Three-state summary of the synthesizer list for the "play all" button:
//   'idle'      no synth playing         -> green, "play all"
//   'selective' some, but not all playing -> orange, "play all" (finishes)
//   'active'    every synth playing       -> red, "stop all"
// Pure so it can be unit-tested without a DOM.
export function playAllStatus(total, playing) {
    if (total <= 0 || playing <= 0) return 'idle';
    if (playing >= total) return 'active';
    return 'selective';
}

// Value the mute toggle should apply. `current` is the synth's volume:
// a positive value is muted (returns 0), a zero value is unmuted (returns
// the memorised `previous`, or `fallback` when there is none). Pure so it
// can be unit-tested without a DOM; shared by the mute button and the
// Alt+1-8 shortcut.
export function mutedVolume(current, previous, fallback = 100) {
    if (Number.isFinite(current) && current > 0) return 0;
    return (Number.isFinite(previous) && previous > 0) ? previous : fallback;
}

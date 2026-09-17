// Projection mirror window: display-only twin of the main image viewer.
// The main window pushes the viewer state through Tauri events (image
// snapshot, zone snapshot, playhead cursors); this page renders them with
// the same shared code (viewer-render.js) so the projection matches the
// main viewer exactly.
import { computeLayout, drawZones, drawCursorCell, MUTE_GLYPH } from './viewer-render.js';

const { emit, listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const image         = document.querySelector('#mirror-image');
const overlay       = document.querySelector('#pixel-overlay');
const cursorOverlay = document.querySelector('#cursor-overlay');

let gridW = 0;
let gridH = 0;
let zoneData   = null; // last { showZones, synths } snapshot
let cursorData = null; // last { cursors } snapshot

// Draws the zones received from the main window on the overlay when the
// mirror toggle is on. The filtering (every synth, only those whose eye
// button is active, or nothing) happens on the main window's side: the
// mirror renders exactly what it receives.
function drawZonesOverlay() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!zoneData || !zoneData.showZones) return;
    const layout = computeLayout(overlay.width, overlay.height, gridW, gridH);
    if (!layout) return;
    for (const synth of zoneData.synths) {
        drawZones(ctx, layout, synth);
    }
}

// Playhead cursors live on their own layer, above the zones — same
// stacking as the main viewer.
function drawCursorsOverlay() {
    const ctx = cursorOverlay.getContext('2d');
    ctx.clearRect(0, 0, cursorOverlay.width, cursorOverlay.height);
    if (!cursorData) return;
    const layout = computeLayout(cursorOverlay.width, cursorOverlay.height, gridW, gridH);
    if (!layout) return;
    for (const c of cursorData) {
        drawCursorCell(ctx, layout, c);
    }
}

function resizeOverlay() {
    overlay.width  = overlay.offsetWidth;
    overlay.height = overlay.offsetHeight;
    cursorOverlay.width  = cursorOverlay.offsetWidth;
    cursorOverlay.height = cursorOverlay.offsetHeight;
    drawZonesOverlay();
    drawCursorsOverlay();
}

listen('mirror:image', (event) => {
    image.src = event.payload.src;
    gridW = event.payload.gridW;
    gridH = event.payload.gridH;
    // The grid render (PNG) is displayed with crisp cells, like the main
    // viewer; photographic content (JPEG) keeps normal smoothing
    image.classList.toggle('pixelated', !event.payload.lossy);
    image.classList.remove('hidden');
    drawZonesOverlay();
    drawCursorsOverlay(); // the grid dims may have changed
});

listen('mirror:zones', (event) => {
    zoneData = event.payload;
    drawZonesOverlay();
});

listen('mirror:cursors', (event) => {
    cursorData = event.payload.cursors;
    drawCursorsOverlay();
});

// The mirror's DOM contains no musical characters, so the Noto Music
// font (loaded on demand via unicode-range) is never fetched — and
// canvas fillText does not trigger a deferred font download either:
// it silently falls back to a system font, which renders the mute rest
// glyph with the wrong symbol. Force the download explicitly, then
// redraw the zones overlay once the font is available (the mute marks
// may have been drawn before it finished loading).
document.fonts.load('16px "Noto Music"', MUTE_GLYPH)
    .then(() => drawZonesOverlay())
    .catch(err => console.error('Error while loading the Noto Music font:', err));
document.fonts.ready.then(() => drawZonesOverlay());

new ResizeObserver(resizeOverlay).observe(overlay);

// Double-click toggles between fullscreen and a floating window the
// user can drag to another screen.
document.body.addEventListener('dblclick', async () => {
    try {
        const win = getCurrentWindow();
        await win.setFullscreen(!(await win.isFullscreen()));
    } catch (err) {
        console.error('Error while toggling the mirror fullscreen:', err);
    }
});

// The close-requested listener takes over the closing, whichever way it
// was triggered (OS close button of the floating mode, or the main
// window's fullscreen button calling close()): the main window must be
// told the mirror is gone (it updates its buttons), then the window is
// actually destroyed.
const win = getCurrentWindow();
win.onCloseRequested(async (event) => {
    event.preventDefault(); // closing is handled here, not by the OS
    try {
        await emit('mirror:closed');
    } catch (err) {
        console.error('Error while reporting the mirror closing:', err);
    }
    try {
        await win.destroy();
    } catch (err) {
        // The window may already be gone
        console.error('Error while destroying the mirror window:', err);
    }
});

// Announce readiness: the main window answers with the current image
// and zone snapshots.
emit('mirror:ready');

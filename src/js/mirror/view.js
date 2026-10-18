// Projection mirror window: display-only twin of the main image viewer.
// The main window pushes the viewer state through Tauri events: both
// image snapshots (original + processed grid, always stacked), the
// layer order ("Show original" toggle), the active masking effect and
// its options, the zone snapshot and the playhead cursors. This page
// renders them with the same shared code (geometry.js, effects.js) so
// the projection matches the main viewer exactly.
//
// Layer stack (bottom to top): the <img> with the surface that is not
// on top, the #mirror-top canvas with the top surface masked by the
// active effect (alpha mask composited with 'destination-in' — the
// holes reveal the <img> underneath), the #trail-overlay canvas with the
// effect's colored layer (blended in 'screen' mode), then the zones and
// the cursors. Everything runs in this window: the IPC only carries
// state changes; an animated effect keeps a requestAnimationFrame loop,
// a non-animated one is repainted on each cursor tick.
import { computeLayout, drawZones, drawCursorCell, MUTE_GLYPH } from '../core/geometry.js';
import {
    effectOrDefault, defaultOptions, sanitizeOptions, updateTrail, clearTrails,
} from './effects.js';

const { emit, listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const bottomImage   = document.querySelector('#mirror-bottom');
const topCanvas    = document.querySelector('#mirror-top');
const trailCanvas  = document.querySelector('#trail-overlay');
const overlay       = document.querySelector('#pixel-overlay');
const cursorOverlay = document.querySelector('#cursor-overlay');
const topCtx = topCanvas.getContext('2d');
const trailCtx = trailCanvas.getContext('2d');

// Offscreen mask canvas: the active effect paints its alpha mask here
// (opaque = keep the top layer, holes = reveal the bottom one), the
// top layer is then composited against it.
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');

let gridW = 0;
let gridH = 0;
let zoneData   = null; // last { showZones, synths } snapshot
let cursorData = null; // last { cursors } snapshot

// The two stacked surfaces: a decoded <img> plus its display flags.
// Which one feeds the top canvas (the other feeds the bottom <img>)
// follows the layer order pushed by the main window.
const surfaces = { original: null, processed: null };
const surfaceTokens = { original: 0, processed: 0 }; // discards superseded decodes

let topLayer = 'processed'; // 'processed' | 'original'
let effectDef = effectOrDefault(null);   // active effect definition (registry)
let effectOptions = {};                  // its sanitized option values
let effectExcluded = new Set();          // synths the effect does not apply to

let rafId = 0; // animation loop handle (animated effects only)

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
// stacking as the main viewer. Each cursor carries the grid dimensions
// it was computed on, so a column-count change mid-playback never
// misplaces a cursor while the image snapshot catches up.
function drawCursorsOverlay() {
    const ctx = cursorOverlay.getContext('2d');
    ctx.clearRect(0, 0, cursorOverlay.width, cursorOverlay.height);
    if (!cursorData) return;
    for (const c of cursorData) {
        const layout = computeLayout(cursorOverlay.width, cursorOverlay.height, c.w || gridW, c.h || gridH);
        if (!layout) continue;
        drawCursorCell(ctx, layout, c);
    }
}

// Loads a pushed snapshot into its surface. The decode is asynchronous:
// the render happens once the image is ready; a token discards a push
// superseded before its decode completed.
function setSurface(name, { src, lossy, w, h }) {
    const token = ++surfaceTokens[name];
    const img = new Image();
    img.onload = () => {
        if (surfaceTokens[name] !== token) return;
        surfaces[name] = { img, lossy, w, h };
        stateChanged();
    };
    img.src = src;
}

// Paints the active effect's mask (viewport-sized) and returns the mask
// canvas, or null when the effect keeps the top layer opaque (no
// painter). Needs both surfaces: unmasking without a bottom layer would
// punch holes into the mirror's background.
function paintMask(w, h) {
    if (!effectDef.paintMask) return null;
    if (topLayer === 'original' ? !surfaces.processed : !surfaces.original) return null;
    if (maskCanvas.width !== w) maskCanvas.width = w;
    if (maskCanvas.height !== h) maskCanvas.height = h;
    maskCtx.clearRect(0, 0, w, h);
    effectDef.paintMask(maskCtx, {
        cursors: cursorData,
        viewW: w,
        viewH: h,
        gridW,
        gridH,
        options: effectOptions,
        time: performance.now(),
        excluded: effectExcluded,
    });
    return maskCanvas;
}

// Colored layer of an effect (the drag effect's synth-colored trail):
// the overlay canvas is blended against the stack below in 'screen' mode
// (see mirror.scss), so a tint brightens the reveal instead of hiding
// it. Cleared and repainted on every render, like the mask; only effects
// declaring a paintOverlay draw anything, and only while the effect is
// fully active (both surfaces stacked).
function paintTrail(active) {
    trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    if (!active || !effectDef.paintOverlay) return;
    effectDef.paintOverlay(trailCtx, {
        viewW: trailCanvas.width,
        viewH: trailCanvas.height,
        gridW,
        gridH,
        options: effectOptions,
        excluded: effectExcluded,
    });
}

// Top layer: the surface named by the layer order, drawn into its
// contain-fit rect (crisp cells for the grid render, smooth for
// photographic content) then composited against the effect's mask.
function renderTop() {
    const w = topCanvas.width;
    const h = topCanvas.height;
    topCtx.clearRect(0, 0, w, h);
    paintTrail(false); // cleared up front; repainted once the mask is known

    const top = surfaces[topLayer];
    if (!top || !w || !h) return;

    const layout = computeLayout(w, h, top.w, top.h);
    if (!layout) return;

    const mask = paintMask(w, h);
    topCtx.imageSmoothingEnabled = top.lossy;
    topCtx.drawImage(top.img, layout.offsetX, layout.offsetY, layout.renderW, layout.renderH);
    if (mask) {
        topCtx.globalCompositeOperation = 'destination-in';
        topCtx.drawImage(maskCanvas, 0, 0);
        topCtx.globalCompositeOperation = 'source-over';
        paintTrail(true);
    }
}

// Bottom layer: the other surface, shown as a plain <img> (object-fit:
// contain from the shared styles — the aspect ratio matches the top
// rect up to grid rounding, like the main viewer's overlays).
function renderBottom() {
    const bottom = topLayer === 'original' ? surfaces.processed : surfaces.original;
    if (!bottom) {
        bottomImage.classList.add('hidden');
        return;
    }
    bottomImage.classList.remove('hidden');
    bottomImage.classList.toggle('pixelated', !bottom.lossy);
    if (bottomImage.src !== bottom.img.src) bottomImage.src = bottom.img.src;
}

// The animation loop runs only while the active effect animates on its
// own AND there is something to animate: cursors to unmask, both
// surfaces stacked. Everything else (new snapshot, layer swap, option
// change, a cursor tick of a non-animated effect) is a single render.
function animationActive() {
    return effectDef.animated && !!effectDef.paintMask &&
        (cursorData?.length ?? 0) > 0 &&
        surfaces.original !== null && surfaces.processed !== null;
}

// Repaints once and keeps the loop in sync with the animation
// conditions (start it if needed, stop it as soon as they lapse).
function stateChanged() {
    if (rafId && !animationActive()) {
        cancelAnimationFrame(rafId);
        rafId = 0;
    }
    renderTop();
    renderBottom();
    if (!rafId && animationActive()) rafId = requestAnimationFrame(loop);
}

function loop() {
    rafId = animationActive() ? requestAnimationFrame(loop) : 0;
    renderTop(); // the bottom layer is static between state changes
}

function resizeOverlay() {
    overlay.width  = overlay.offsetWidth;
    overlay.height = overlay.offsetHeight;
    cursorOverlay.width  = cursorOverlay.offsetWidth;
    cursorOverlay.height = cursorOverlay.offsetHeight;
    trailCanvas.width  = trailCanvas.offsetWidth;
    trailCanvas.height = trailCanvas.offsetHeight;
    topCanvas.width  = topCanvas.offsetWidth;
    topCanvas.height = topCanvas.offsetHeight;
    drawZonesOverlay();
    drawCursorsOverlay();
    stateChanged();
}

listen('mirror:original', (event) => {
    setSurface('original', event.payload);
});

listen('mirror:image', (event) => {
    gridW = event.payload.gridW;
    gridH = event.payload.gridH;
    clearTrails(); // the recorded cells belong to the previous grid
    setSurface('processed', event.payload);
    drawZonesOverlay();
    drawCursorsOverlay(); // the grid dims may have changed
});

listen('mirror:layers', (event) => {
    topLayer = event.payload.top === 'original' ? 'original' : 'processed';
    stateChanged();
});

listen('mirror:effect', (event) => {
    const nextDef = effectOrDefault(event.payload.effect);
    // Only a genuine effect switch starts from an empty trail: the
    // option-only pushes (throttled, deduplicated upstream) must not
    // wipe the trail mid-playback.
    if (nextDef.id !== effectDef.id) clearTrails();
    effectDef = nextDef;
    // Every push carries the full option set of the effect; sanitize
    // again here and layer the registry defaults underneath, so a
    // payload with missing keys can never reach the painter. The
    // excluded synths ride along as ids (rekeyed by the main window
    // on every id renumbering).
    effectOptions = {
        ...defaultOptions(effectDef),
        ...sanitizeOptions(effectDef, event.payload.options),
    };
    effectExcluded = new Set(event.payload.excluded ?? []);
    stateChanged();
});

listen('mirror:zones', (event) => {
    zoneData = event.payload;
    drawZonesOverlay();
});

listen('mirror:cursors', (event) => {
    cursorData = event.payload.cursors;
    updateTrail(cursorData);
    drawCursorsOverlay();
    stateChanged(); // the cursor ticks feed every effect, animated or not
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

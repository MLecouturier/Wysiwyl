// Projection mirror window: a display-only Tauri window that mirrors
// the image area on a second screen/projector. The main window stays
// fully interactive and pushes its viewer state to the mirror through
// Tauri events, funneled through the same single points that repaint
// the main viewer (pushImage from updatePreviewSrc, pushZones from
// redrawAllHighlights, pushCursors on each playback tick).
//
// The mirror permanently stacks the two versions of the image (the
// processed grid over the original) and masks the top layer through the
// active effect (see effects.js). Accordingly pushImage always carries
// BOTH surfaces: the original snapshot is rebuilt only when the
// original changes (image load, reshape), the processed snapshot on
// every repaint — the live transform preview is deliberately NOT sent,
// the mirror keeps showing the committed image until a reshape is
// applied. The layer order follows the "Show original" toggle, and the
// effect state (id + options) is pushed on change and on open.
//
// Extracted from main.js as a factory with injected dependencies: the
// shared per-synth maps (passed by reference, they are never reassigned),
// a viewer-state getter, the mute-cell computation, and the cross-domain
// callbacks (reroute the image when the mirror opens, mark the session
// dirty when the zones mode changes).

import { NO_EFFECT, effectOrDefault, defaultOptions, sanitizeOptions } from './effects.js';

const MIRROR_LABEL = 'mirror';
// Zone display in the mirror, cycled by the zones button: 'all' (every
// synth's zones), 'active' (only the synths whose eye button is on in
// the main window) or 'none' (nothing). The mirror's display is fully
// independent of the main viewer, except in 'active' mode which follows
// the eye buttons.
const MIRROR_ZONES_MODES = ['all', 'active', 'none'];

// Snapshot of the currently displayed surfaces, downscaled for the
// projection: photographic content (the original) ships as JPEG for
// fluidity — the full-resolution RGBA would be tens of MB per frame
// through IPC — while the processed grid ships as PNG so the cells stay
// crisp on the projector.
const MIRROR_SNAPSHOT_MAX_W = 1600;

// Trailing throttle: live manipulations (transform sliders) repaint far
// faster than IPC needs to carry them — ~30 fps keeps the mirror fluid.
const MIRROR_IMAGE_MIN_INTERVAL = 33; // ms
// Full snapshot of every synth's zones, throttled and deduplicated: zone
// drags call redrawAllHighlights at mousemove rate while the committed
// zones stay unchanged — identical consecutive payloads are not re-sent.
const MIRROR_ZONES_MIN_INTERVAL = 33; // ms
// Effect options ride the same pattern: option sliders drag at
// mousemove rate, identical consecutive payloads are not re-sent.
const MIRROR_EFFECT_MIN_INTERVAL = 33; // ms

// The original <img> may not be decoded yet when the snapshot is taken
// (its src was just set): the snapshot decodes its own copy and waits.
function decodeImage(source) {
    return new Promise((resolve, reject) => {
        source.onload = () => resolve(source);
        source.onerror = () => reject(new Error('image decode failed'));
    });
}

export function createMirror({
    synthColors, synthHighlights, synthCursors, synthCursorGrid, synthCursorMuted,
    synthEffectExcluded, isSynthPlaying,
    getViewerState, computeMuteCells, onReady, onZonesModeChanged,
}) {
    const { emit, listen } = window.__TAURI__.event;
    const { WebviewWindow } = window.__TAURI__.webviewWindow;
    const { getCurrentWindow, currentMonitor, availableMonitors } = window.__TAURI__.window;

    const fullscreenBtn = document.querySelector('#fullscreen-btn');
    const mirrorZonesBtn = document.querySelector('#mirror-zones-btn');
    const showOriginalBtn = document.querySelector('#show-original-btn');

    let zonesMode = 'all';
    let effectId = NO_EFFECT;
    let effectOptions = {}; // sanitized options of the active effect
    let creating = false; // window creation in flight (guards double clicks)
    let windowRef = null; // live WebviewWindow while the mirror is open

    let imageLast = 0;
    let imageTimer = 0;
    let zonesLast = 0;
    let zonesTimer = 0;
    let effectLast = 0;
    let effectTimer = 0;
    let lastZonesJson = null;
    let lastEffectJson = null;
    let lastLayersTop = null;

    // Full-resolution copy of the processed grid pixels, repainted on
    // each push before the downscale (the snapshot is downscaled from
    // here, never from the main viewer's canvases: they may carry the
    // transient transform preview the mirror must not show).
    const gridCanvas = document.createElement('canvas');

    // Identity of the last original pushed to the mirror: the base64
    // PNG is replaced wholesale on every load/reshape, so a reference
    // comparison reliably skips the decode + re-encode while it is
    // unchanged (slider repaints push the image at ~30 fps).
    let lastOriginalPng = null;
    let lastOriginalSnapshot = null;

    // Same reference dedup for the processed pixels: repaints that do
    // not re-render the grid (transform preview drags, layer toggles)
    // skip the PNG re-encode entirely.
    let lastProcessedPixels = null;
    let lastProcessedSnapshot = null;

    // Snapshots actually sent to the mirror: a cached snapshot (unchanged
    // original or grid) is not re-emitted — repaints that do not touch
    // the surfaces only carry the layer order.
    let emittedOriginal = null;
    let emittedProcessed = null;

    const isOpen = () => windowRef !== null;

    function updateZonesButton() {
        mirrorZonesBtn.classList.toggle('active', zonesMode !== 'none');
        mirrorZonesBtn.classList.toggle('selective', zonesMode === 'active');
    }

    // The fullscreen button stays enabled while the mirror is open (it then
    // closes it); it is disabled when no second screen is available.
    async function updateButtonStates() {
        let hasSecondScreen = false;
        try {
            hasSecondScreen = (await availableMonitors()).length >= 2;
        } catch (err) {
            console.error('Error while detecting monitors:', err);
        }
        // Resync the reference with reality, in case the mirror went away
        // without a close-requested event (killed, unplugged screen). While
        // creation is in flight the window is not yet listed.
        if (creating) return;
        try {
            windowRef = await WebviewWindow.getByLabel(MIRROR_LABEL);
        } catch (err) {
            windowRef = null;
        }
        fullscreenBtn.disabled = !hasSecondScreen && !isOpen();
        fullscreenBtn.classList.toggle('active', isOpen());
    }

    // Opens the mirror on the first monitor other than the one hosting the
    // main window, in fullscreen. Built invisible, positioned on the target
    // monitor, then shown, so it never flashes on the wrong screen. When the
    // user leaves fullscreen (double-click inside the mirror), the floating
    // window keeps the monitor's geometry and can be dragged anywhere.
    async function openWindow() {
        const monitors = await availableMonitors();
        const current = await currentMonitor();
        // First monitor other than the one hosting the main window. Names
        // can be unavailable on some platforms: the second monitor is then
        // the pragmatic answer (the floating mirror can always be dragged).
        const target = monitors.find(m => !current || m.name !== current.name)
            ?? (monitors.length > 1 ? monitors[1] : null);
        if (!target) return;

        const { PhysicalPosition, PhysicalSize } = window.__TAURI__.dpi;
        const win = new WebviewWindow(MIRROR_LABEL, {
            url: 'viewer.html',
            title: 'Wysiwyl',
            visible: false,
            decorations: true,
            resizable: true,
            // Display-only window: it never takes the keyboard focus, not at
            // creation and not during its fullscreen space transition — the
            // main window (whose keyboard shortcuts drive the whole app)
            // keeps it throughout
            focus: false,
            focusable: false,
        });
        windowRef = win;

        win.once('tauri://created', async () => {
            creating = false;
            if (windowRef !== win) {
                // The main window closed while creation was in flight: the
                // mirror must not outlive its event source
                try {
                    await win.destroy();
                } catch (err) {
                    console.error('Error while closing the stale mirror window:', err);
                }
                return;
            }
            try {
                await win.setPosition(new PhysicalPosition(target.position.x, target.position.y));
                await win.setSize(new PhysicalSize(target.size.width, target.size.height));
                await win.setFullscreen(true);
                await win.show();
                // The mirror is created non-focusable, so the main window keeps
                // the keyboard focus throughout. One immediate setFocus call
                // remains as a belt-and-braces for platforms where showing a
                // window still activates it
                try {
                    await getCurrentWindow().setFocus();
                } catch (err) {
                    console.error('Error while restoring the main window focus:', err);
                }
            } catch (err) {
                console.error('Error while placing the mirror window:', err);
            }
            updateButtonStates();
        });

        win.once('tauri://error', (e) => {
            console.error('Mirror window error:', e);
            windowRef = null;
            creating = false;
            updateButtonStates();
        });
    }

    async function toggle() {
        if (windowRef) {
            const win = windowRef;
            try {
                await win.close(); // the mirror page reports the closing via mirror:closed
            } catch (err) {
                // The window is already gone: resync the state
                console.error('Error while closing the mirror window:', err);
                windowRef = null;
                updateButtonStates();
            }
        } else if (!creating) {
            // The window is created asynchronously: the guard prevents a
            // double click from spawning two windows with the same label
            creating = true;
            await openWindow();
        }
    }

    // Destroys the mirror window if open (used when the main window closes).
    async function destroy() {
        if (!windowRef) return;
        const win = windowRef;
        windowRef = null;
        try {
            await win.destroy();
        } catch (err) {
            // The window may already be gone
            console.error('Error while closing the mirror window:', err);
        }
    }

    // Playhead cursors: the positions of every playing synth, pushed on
    // each tick (tiny payloads, low frequency — no throttling needed). A
    // muted pixel keeps its position and is drawn at half opacity, matching
    // the main viewer. A synth that is not playing never reaches the
    // mirror: a pixel tick still in flight when the synth stops can
    // re-register its cursor after the erase, and the projection would
    // otherwise show the stale cell — the play state filter (injected from
    // main.js, reading the same card buttons as anySynthPlaying) makes the
    // mirror immune to that race.
    function pushCursors() {
        if (!isOpen()) return;
        const { gridW, gridH } = getViewerState();
        const cursors = [];
        synthCursors.forEach((cursor, sid) => {
            if (isSynthPlaying && !isSynthPlaying(sid)) return;
            const color = synthColors.get(sid);
            if (!color) return;
            // The grid dims the cursor was recorded on travel with it: the
            // mirror decodes the absolute index against the right grid even
            // when the column count changes while synths are playing
            const g = synthCursorGrid.get(sid);
            cursors.push({
                id: sid, // identifies the synth: the effect filters by id
                cursor, color,
                muted: !!synthCursorMuted.get(sid),
                w: g ? g.w : gridW,
                h: g ? g.h : gridH,
            });
        });
        emit('mirror:cursors', { cursors });
    }

    // Original snapshot: JPEG downscale of the original image, rebuilt only
    // when the original changed (reference comparison, see lastOriginalPng)
    // — adjustment repaints reuse the last snapshot verbatim.
    async function originalSnapshot(state) {
        if (!state.originalPng) return null;
        if (state.originalPng === lastOriginalPng) return lastOriginalSnapshot;

        const img = new Image();
        const decoded = decodeImage(img);
        img.src = `data:image/png;base64,${state.originalPng}`;
        const source = await decoded;
        const w = img.naturalWidth || state.origWidth;
        const h = img.naturalHeight || state.origHeight;
        const scale = Math.min(1, MIRROR_SNAPSHOT_MAX_W / w);
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));

        const offCanvas = document.createElement('canvas');
        offCanvas.width = cw;
        offCanvas.height = ch;
        const ctx = offCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(source, 0, 0, cw, ch);

        lastOriginalSnapshot = {
            src: offCanvas.toDataURL('image/jpeg', 0.85),
            lossy: true, // photographic content: the mirror displays it smooth
            w: cw,
            h: ch,
        };
        lastOriginalPng = state.originalPng;
        return lastOriginalSnapshot;
    }

    // Processed snapshot: PNG downscale of the committed grid render (the
    // transform preview is deliberately ignored — the mirror keeps showing
    // the committed image until the reshape is applied). Deduplicated by
    // pixel-buffer reference: every render replaces it wholesale.
    function processedSnapshot(state) {
        const pixels = state.processedPixels;
        if (!pixels) return null;
        if (pixels !== lastProcessedPixels) {
            if (gridCanvas.width !== pixels.width) gridCanvas.width = pixels.width;
            if (gridCanvas.height !== pixels.height) gridCanvas.height = pixels.height;
            gridCanvas.getContext('2d').putImageData(
                new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);

            const scale = Math.min(1, MIRROR_SNAPSHOT_MAX_W / pixels.width);
            const cw = Math.max(1, Math.round(pixels.width * scale));
            const ch = Math.max(1, Math.round(pixels.height * scale));

            const offCanvas = document.createElement('canvas');
            offCanvas.width = cw;
            offCanvas.height = ch;
            const ctx = offCanvas.getContext('2d');
            ctx.imageSmoothingEnabled = false; // grid cells stay crisp blocks
            ctx.drawImage(gridCanvas, 0, 0, cw, ch);

            lastProcessedSnapshot = {
                src: offCanvas.toDataURL('image/png'),
                lossy: false, // grid render: the mirror displays it pixelated
                w: cw,
                h: ch,
                gridW: state.gridW,
                gridH: state.gridH,
            };
            lastProcessedPixels = pixels;
        }
        return lastProcessedSnapshot;
    }

    // Layer order in the mirror: the "Show original" toggle alternates
    // which version sits on top (and is therefore the one the effect
    // masks). Piggy-backed on pushImage: every path that toggles the
    // button repaints the main viewer (updatePreviewSrc →
    // viewer-image-changed → pushImage), so the layers travel with the
    // same throttled push — including programmatic resets (image load)
    // that fire no dedicated event.
    function pushLayers() {
        if (!isOpen()) return;
        const top = showOriginalBtn.classList.contains('active') ? 'original' : 'processed';
        if (top === lastLayersTop) return;
        lastLayersTop = top;
        emit('mirror:layers', { top });
    }

    // Pushes both surfaces to the mirror. Throttled: adjustment repaints
    // call this at high frequency, ~30 fps is plenty for the projection.
    async function pushImage() {
        if (!isOpen()) return;
        const now = performance.now();
        const elapsed = now - imageLast;
        if (elapsed < MIRROR_IMAGE_MIN_INTERVAL) {
            if (imageTimer) return;
            imageTimer = setTimeout(() => {
                imageTimer = 0;
                pushImage();
            }, MIRROR_IMAGE_MIN_INTERVAL - elapsed);
            return;
        }
        imageLast = now;
        try {
            const state = getViewerState();
            const original = await originalSnapshot(state);
            if (original && original !== emittedOriginal) {
                emittedOriginal = original;
                emit('mirror:original', original);
            }
            const processed = processedSnapshot(state);
            if (processed && processed !== emittedProcessed) {
                emittedProcessed = processed;
                emit('mirror:image', processed);
            }
            pushLayers();
        } catch (err) {
            console.error('Error while building the mirror snapshots:', err);
        }
    }

    // Full snapshot of every synth's zones — regardless of their visibility
    // in the main window: the mirror toggle overrides the per-synth eye
    // buttons, and zones stay shown while a synth is playing. The mute-cell
    // computation only runs when the mirror actually shows zones.
    function pushZones() {
        if (!isOpen()) return;
        const now = performance.now();
        const elapsed = now - zonesLast;
        if (elapsed < MIRROR_ZONES_MIN_INTERVAL) {
            if (zonesTimer) return;
            zonesTimer = setTimeout(() => {
                zonesTimer = 0;
                pushZones();
            }, MIRROR_ZONES_MIN_INTERVAL - elapsed);
            return;
        }
        zonesLast = now;

        const synths = [];
        if (zonesMode !== 'none') {
            synthHighlights.forEach((hi, sid) => {
                // 'active' mode: the mirror follows the main window's eye buttons
                if (zonesMode === 'active' && !hi.visible) return;
                const color = synthColors.get(sid);
                if (!color) return;
                synths.push({
                    color,
                    zones: hi.zones,
                    muteCells: Array.from(computeMuteCells(hi)),
                });
            });
        }
        const payload = { showZones: zonesMode !== 'none', synths };
        const json = JSON.stringify(payload);
        if (json === lastZonesJson) return;
        lastZonesJson = json;
        emit('mirror:zones', payload);
    }

    // Effect state (id + options), throttled and deduplicated: the options
    // sliders drag at mousemove rate without changing the committed value
    // between steps.
    function pushEffect() {
        if (!isOpen()) return;
        const now = performance.now();
        const elapsed = now - effectLast;
        if (elapsed < MIRROR_EFFECT_MIN_INTERVAL) {
            if (effectTimer) return;
            effectTimer = setTimeout(() => {
                effectTimer = 0;
                pushEffect();
            }, MIRROR_EFFECT_MIN_INTERVAL - elapsed);
            return;
        }
        effectLast = now;
        // The payload carries the effect's excluded synths: a cursor-based
        // effect filters them on the mirror side (the set is injected by
        // reference, so renamings/renumbering are picked up on the next
        // push — 'synth-list-changed' triggers one).
        const payload = {
            effect: effectId,
            options: effectOptions,
            excluded: Array.from(synthEffectExcluded ?? []),
        };
        const json = JSON.stringify(payload);
        if (json === lastEffectJson) return;
        lastEffectJson = json;
        emit('mirror:effect', payload);
    }

    // Selects the active effect: an unknown id (session saved by a newer
    // version) loads as the no-op effect. The options reset to the new
    // effect's defaults; pass options right after for a session restore.
    function setEffect(id) {
        const def = effectOrDefault(id);
        effectId = def.id;
        effectOptions = defaultOptions(def);
    }

    // Merges and sanitizes option values onto the active effect: unknown
    // keys and out-of-range values never reach the painter.
    function setEffectOptions(options) {
        effectOptions = sanitizeOptions(
            effectOrDefault(effectId), { ...effectOptions, ...options });
    }

    fullscreenBtn.addEventListener('click', toggle);

    mirrorZonesBtn.addEventListener('click', () => {
        const idx = MIRROR_ZONES_MODES.indexOf(zonesMode);
        zonesMode = MIRROR_ZONES_MODES[(idx + 1) % MIRROR_ZONES_MODES.length];
        onZonesModeChanged?.();
        updateZonesButton();
        pushZones();
    });

    // The mirror announces itself when loaded, and reports its own closing
    // (its close-requested handler runs before the window goes away).
    listen('mirror:ready', () => {
        // Opening the mirror takes over the "Show original" toggle: it
        // becomes the projection's layer order while the main viewer
        // falls back to the grid render (see updatePreviewSrc). onReady
        // repaints the main viewer, whose viewer-image-changed covers
        // the initial image push in the same repaint.
        onReady?.();
        // A freshly opened mirror must receive the current state even
        // when it is identical to the last session's (the dedup would
        // otherwise skip the push to a window that never got it)
        lastZonesJson = null;
        lastEffectJson = null;
        lastLayersTop = null;
        // The snapshots stay cached across a close/reopen (the content
        // did not change); only their emission is replayed — a fresh
        // window never received them.
        emittedOriginal = null;
        emittedProcessed = null;
        pushZones();
        pushCursors();
        pushImage(); // original + processed + layers
        pushEffect();
    });

    listen('mirror:closed', () => {
        windowRef = null;
        // The layer order only exists in the mirror: closing the window
        // resets the toggle, so its state keeps meaning "the original is
        // on top of the projection" (with the mirror closed, the toggle
        // shows the original in the main viewer instead)
        showOriginalBtn.classList.remove('active');
        updateButtonStates();
    });

    // Re-check monitor availability whenever the main window regains focus:
    // plugging or unplugging a projector updates the buttons live.
    getCurrentWindow().onFocusChanged(() => {
        updateButtonStates();
    });

    updateButtonStates();
    updateZonesButton(); // reflect the initial mode on the button

    return {
        isOpen,
        destroy,
        updateButtonStates,
        pushCursors,
        pushZones,
        pushImage,
        pushEffect,
        getZonesMode: () => zonesMode,
        setZonesMode: (mode) => { zonesMode = mode; updateZonesButton(); },
        getEffect: () => effectId,
        setEffect,
        getEffectOptions: () => effectOptions,
        setEffectOptions,
    };
}

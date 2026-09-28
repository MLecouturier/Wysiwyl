// Projection mirror window: a display-only Tauri window that mirrors the
// image area on a second screen/projector. The main window stays fully
// interactive and pushes its viewer state to the mirror through Tauri
// events, funneled through the same single points that repaint the main
// viewer (pushImage from updatePreviewSrc, pushZones from
// redrawAllHighlights, pushCursors on each playback tick).
//
// Extracted from main.js as a factory with injected dependencies: the
// shared per-synth maps (passed by reference, they are never reassigned),
// a viewer-state getter, the mute-cell computation, and the cross-domain
// callbacks (reroute the image when the mirror opens, mark the session
// dirty when the zones mode changes).

const MIRROR_LABEL = 'mirror';
// Zone display in the mirror, cycled by the zones button: 'all' (every
// synth's zones), 'active' (only the synths whose eye button is on in
// the main window) or 'none' (nothing). The mirror's display is fully
// independent of the main viewer, except in 'active' mode which follows
// the eye buttons.
const MIRROR_ZONES_MODES = ['all', 'active', 'none'];

// Snapshot of the currently displayed surface, downscaled for the
// projection: photographic content (original, transform live preview)
// ships as JPEG for fluidity — the full-resolution RGBA would be tens of
// MB per frame through IPC — while the grid render ships as PNG so the
// cells stay crisp on the projector.
const MIRROR_SNAPSHOT_MAX_W = 1600;

// Trailing throttle: live manipulations (transform sliders) repaint far
// faster than IPC needs to carry them — ~30 fps keeps the mirror fluid.
const MIRROR_IMAGE_MIN_INTERVAL = 33; // ms
// Full snapshot of every synth's zones, throttled and deduplicated: zone
// drags call redrawAllHighlights at mousemove rate while the committed
// zones stay unchanged — identical consecutive payloads are not re-sent.
const MIRROR_ZONES_MIN_INTERVAL = 33; // ms

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
    getViewerState, computeMuteCells, onReady, onZonesModeChanged,
}) {
    const { emit, listen } = window.__TAURI__.event;
    const { WebviewWindow } = window.__TAURI__.webviewWindow;
    const { getCurrentWindow, currentMonitor, availableMonitors } = window.__TAURI__.window;

    const fullscreenBtn = document.querySelector('#fullscreen-btn');
    const mirrorZonesBtn = document.querySelector('#mirror-zones-btn');
    const showOriginalBtn = document.querySelector('#show-original-btn');
    const previewCanvas = document.querySelector('#processed-preview');

    let zonesMode = 'all';
    let creating = false; // window creation in flight (guards double clicks)
    let windowRef = null; // live WebviewWindow while the mirror is open

    let imageLast = 0;
    let imageTimer = 0;
    let zonesLast = 0;
    let zonesTimer = 0;
    let lastZonesJson = null;

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
    // the main viewer.
    function pushCursors() {
        if (!isOpen()) return;
        const { gridW, gridH } = getViewerState();
        const cursors = [];
        synthCursors.forEach((cursor, sid) => {
            const color = synthColors.get(sid);
            if (!color) return;
            // The grid dims the cursor was recorded on travel with it: the
            // mirror decodes the absolute index against the right grid even
            // when the column count changes while synths are playing
            const g = synthCursorGrid.get(sid);
            cursors.push({
                cursor, color,
                muted: !!synthCursorMuted.get(sid),
                w: g ? g.w : gridW,
                h: g ? g.h : gridH,
            });
        });
        emit('mirror:cursors', { cursors });
    }

    async function imageSnapshot() {
        const state = getViewerState();
        const showOrig = showOriginalBtn.classList.contains('active');
        const pixels = state.transformPreviewPixels ?? (showOrig ? null : state.processedPixels);

        let source, w, h, lossy;
        if (pixels) {
            source = previewCanvas; // freshly painted by updatePreviewSrc
            w = pixels.width;
            h = pixels.height;
            lossy = state.transformPreviewPixels !== null; // full-res preview → JPEG
        } else if (showOrig && state.originalPng) {
            const img = new Image();
            const decoded = decodeImage(img);
            img.src = `data:image/png;base64,${state.originalPng}`;
            source = await decoded;
            w = img.naturalWidth || state.origWidth;
            h = img.naturalHeight || state.origHeight;
            lossy = true;
        } else {
            return null;
        }

        const scale = Math.min(1, MIRROR_SNAPSHOT_MAX_W / w);
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));

        const offCanvas = document.createElement('canvas');
        offCanvas.width = cw;
        offCanvas.height = ch;
        const ctx = offCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = lossy;
        ctx.drawImage(source, 0, 0, cw, ch);

        return {
            src: lossy ? offCanvas.toDataURL('image/jpeg', 0.85)
                       : offCanvas.toDataURL('image/png'),
            lossy, // false = grid render: the mirror displays it pixelated, like the main viewer
            gridW: state.gridW,
            gridH: state.gridH,
        };
    }

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
            const snapshot = await imageSnapshot();
            if (snapshot) emit('mirror:image', snapshot);
        } catch (err) {
            console.error('Error while building the mirror snapshot:', err);
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
                    muteCells: Array.from(computeMuteCells(sid, hi)),
                });
            });
        }
        const payload = { showZones: zonesMode !== 'none', synths };
        const json = JSON.stringify(payload);
        if (json === lastZonesJson) return;
        lastZonesJson = json;
        emit('mirror:zones', payload);
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
        // Opening the mirror reroutes the original image to it (when the
        // toggle is on): the main viewer falls back to the grid render.
        // onReady also pushes the mirror image snapshot, covering the
        // initial push in the same repaint.
        onReady?.();
        // A freshly opened mirror must receive the current snapshots even
        // when they are identical to the last session's (the dedup would
        // otherwise skip the push to a window that never got them)
        lastZonesJson = null;
        pushZones();
        pushCursors();
    });

    listen('mirror:closed', () => {
        windowRef = null;
        // The original image was rerouted to the (now gone) mirror: the
        // main viewer already shows the grid render, and the toggle goes
        // back to inactive so its state keeps meaning "the original is
        // visible somewhere" (one click shows it in the main viewer again)
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
        getZonesMode: () => zonesMode,
        setZonesMode: (mode) => { zonesMode = mode; updateZonesButton(); },
    };
}

// Viewer zoom: magnifying the preview to make zone selection easier on
// images with many columns. The wheel / two-finger scroll / trackpad
// pinch zooms around the cursor; dragging pans a magnified image (with
// Space held when a zone tool is armed, so the left-drag stays available
// for selection); a double-click resets to the fit view.
//
// The image surfaces (#preview, #processed-preview) are sized to the
// zoom-aware layout here; the overlay canvases stay full-viewer and draw
// through getImageLayout(), so they follow the zoom for free. Overlay
// repaints are signalled on the event bus so this module stays free of
// the editor.

import { appEvents, viewer } from '../core/state.js';
import {
    computeLayout, computeZoomedLayout, zoomAtPoint, clampZoomCenter,
} from '../core/geometry.js';
import { getImageLayout, zoneState } from '../synth/selection.js';
import { spaceConsumed } from '../core/focus.js';

const viewerEl      = document.querySelector('#image-viewer');
const pixelOverlay  = document.querySelector('#pixel-overlay');
const preview       = document.querySelector('#preview');
const previewCanvas = document.querySelector('#processed-preview');

// Wheel sensitivity: exponential so a notch and a continuous trackpad
// scroll feel proportionate (see audio/stepper.js for the same device).
const ZOOM_WHEEL_SPEED = 0.0015;

// Cross-domain hook: whether a modal image editor (crop / transform) owns
// the left-drag. Injected by main.js — this module cannot import the
// editor, which imports it.
let hooks = { isModalEditorActive: () => false };
export function configureZoom(injected) {
    hooks = { ...hooks, ...injected };
}

// ---------- State ----------
let panning = false;
let panStart = null;
let pointerOverViewer = false;
let spaceHeld = false;

export const isPanning = () => panning;

// A left-drag pans the image when it is magnified and no modal editor
// owns the drag. With a zone tool armed the drag selects zones, so pan
// then requires Space; otherwise it is the default drag.
export function canPan() {
    if (!pointerOverViewer || viewer.zoom <= 1 || hooks.isModalEditorActive()) return false;
    return zoneState.pick ? spaceHeld : true;
}

// Space is the pan modifier only with a zone tool armed: everywhere else
// it keeps its play/pause meaning (main.js consults this).
export function isSpacePanModifier() {
    return spaceHeld && pointerOverViewer && viewer.zoom > 1
        && !!zoneState.pick && !hooks.isModalEditorActive();
}

// ---------- Surfaces ----------
// Sizes the two image surfaces to the zoom-aware layout rect of the
// currently displayed pixels (the transform preview while it is up).
// The overlays are not touched here: they stay full-viewer.
export function syncViewerSurfaces() {
    if (!viewer.hasImage) return;
    const pixels = viewer.transformPreviewPixels ?? viewer.processedPixels;
    const w = pixels?.width || viewer.gridW;
    const h = pixels?.height || viewer.gridH;
    const layout = computeZoomedLayout(
        pixelOverlay.width, pixelOverlay.height, w, h,
        viewer.zoom, viewer.zoomCenterX, viewer.zoomCenterY,
    );
    if (!layout) return;
    for (const el of [preview, previewCanvas]) {
        if (!el) continue;
        el.style.left = `${layout.offsetX}px`;
        el.style.top = `${layout.offsetY}px`;
        el.style.width = `${layout.renderW}px`;
        el.style.height = `${layout.renderH}px`;
    }
}

// Applies a { zoom, centerX, centerY } result and repaints everything.
function applyZoomState({ zoom, centerX, centerY }) {
    if (zoom === viewer.zoom && centerX === viewer.zoomCenterX && centerY === viewer.zoomCenterY) return;
    viewer.zoom = zoom;
    viewer.zoomCenterX = centerX;
    viewer.zoomCenterY = centerY;
    syncViewerSurfaces();
    syncCursor(); // the Space pan is only available while magnified
    appEvents.emit('viewer-zoom-changed');
}

export function resetZoom() {
    if (viewer.zoom === 1 && viewer.zoomCenterX === 0.5 && viewer.zoomCenterY === 0.5) return;
    viewer.zoom = 1;
    viewer.zoomCenterX = 0.5;
    viewer.zoomCenterY = 0.5;
    syncViewerSurfaces();
    syncCursor();
    appEvents.emit('viewer-zoom-changed');
}

// ---------- Wheel / pinch ----------
function normalizeWheelDelta(e) {
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;       // lines
    else if (e.deltaMode === 2) d *= 100; // pages
    return d;
}

function zoomAtClientPoint(clientX, clientY, factor) {
    if (!viewer.hasImage) return;
    const rect = pixelOverlay.getBoundingClientRect();
    const vw = pixelOverlay.width;
    const vh = pixelOverlay.height;
    const base = computeLayout(vw, vh, viewer.gridW, viewer.gridH);
    const current = getImageLayout();
    if (!base || !current) return;
    applyZoomState(zoomAtPoint(
        base, current,
        clientX - rect.left, clientY - rect.top,
        viewer.zoom * factor, vw, vh,
    ));
}

viewerEl.addEventListener('wheel', (e) => {
    if (!viewer.hasImage) return;
    e.preventDefault();
    const delta = normalizeWheelDelta(e);
    if (delta === 0) return;
    zoomAtClientPoint(e.clientX, e.clientY, Math.exp(-delta * ZOOM_WHEEL_SPEED));
}, { passive: false });

// ---------- Pan ----------
// The pan cursor is set inline and only while panning is possible; it is
// cleared afterwards. `panCursor` caches the last value we set (null =
// never) so the crop tool's own inline cursor is never clobbered and the
// DOM is not reassigned on every move.
let panCursor = null;
function applyPanCursor(cursor) {
    if (cursor === panCursor) return;
    panCursor = cursor;
    if (viewerEl) viewerEl.style.cursor = cursor;
    // The overlay only receives pointer events in picking/note-hover
    // modes: mirror the cursor there so it stays visible when a tool is
    // armed.
    pixelOverlay.style.cursor = cursor;
}
function syncCursor() {
    if (panning) applyPanCursor('grabbing');
    else if (canPan()) applyPanCursor('grab');
    else if (panCursor) applyPanCursor('');
}

export function startPan(clientX, clientY) {
    panning = true;
    panStart = {
        x: clientX,
        y: clientY,
        centerX: viewer.zoomCenterX,
        centerY: viewer.zoomCenterY,
    };
    syncCursor();
}

export function movePan(clientX, clientY) {
    if (!panning || !panStart) return;
    const layout = getImageLayout();
    if (!layout) return;
    // Dragging the image right moves its center fraction left
    const cx = panStart.centerX - (clientX - panStart.x) / layout.renderW;
    const cy = panStart.centerY - (clientY - panStart.y) / layout.renderH;
    const c = clampZoomCenter(cx, cy, pixelOverlay.width, pixelOverlay.height, layout.renderW, layout.renderH);
    applyZoomState({ zoom: viewer.zoom, centerX: c.x, centerY: c.y });
}

export function endPan() {
    if (!panning) return;
    panning = false;
    panStart = null;
    syncCursor();
}

// ---------- Space key (pan modifier) ----------
// Capture phase: the flag must be set before the shortcut registry's
// bubble-phase listener evaluates the play/pause binding.
window.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    // A focused button/select/text field keeps its own Space behavior
    if (spaceConsumed(e.target)) return;
    spaceHeld = true;
    if (e.repeat) return;
    if (isSpacePanModifier()) {
        e.preventDefault(); // no page scroll while panning
        syncCursor();
    }
}, true);

window.addEventListener('keyup', (e) => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (!spaceHeld) return;
    spaceHeld = false;
    endPan();
    syncCursor();
}, true);

// Pointer presence over the image: only there does the drag pan.
viewerEl.addEventListener('mouseenter', () => { pointerOverViewer = true; syncCursor(); });
viewerEl.addEventListener('mouseleave', () => { pointerOverViewer = false; syncCursor(); });

// Pan drag. Listened on the viewer (not the overlay): the overlay only
// receives pointer events while a tool is armed, but panning must work
// with or without one. The shared pixelOverlay listeners in main.js bail
// out when canPan() so no zone edit starts underneath.
viewerEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !canPan()) return;
    e.preventDefault();
    startPan(e.clientX, e.clientY);
});
viewerEl.addEventListener('mousemove', (e) => {
    if (panning) movePan(e.clientX, e.clientY);
    // Keep the pan cursor in sync as a zone tool is armed/disarmed
    else syncCursor();
});
window.addEventListener('mouseup', () => {
    if (panning) endPan();
});

// A window that loses focus must not keep Space armed.
window.addEventListener('blur', () => {
    spaceHeld = false;
    endPan();
    syncCursor();
});

// Double-click on the image resets to the fit view.
viewerEl.addEventListener('dblclick', () => {
    if (!viewer.hasImage || viewer.zoom <= 1) return;
    resetZoom();
});

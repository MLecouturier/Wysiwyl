// Image editor: the image-processing pipeline (grid re-render, labels,
// preview routing), the shape tools (rotate, crop, perspective transform)
// and their controls. Owns the crop/transform state; the pixelOverlay
// mouse listeners stay in main.js (shared with the zone tools) and drive
// the exported cropState/crop helpers. The projection mirror is reached
// through hooks and the event bus.

import { t, translateError } from '../core/i18n.js';
import { viewer } from '../core/state.js';
import { appEvents } from '../core/state.js';
import {
    SLIDER_STEPS, MIN_CELLS, sliderToCells, cellsToSlider,
    sliderToPosterizeLevels,
} from '../core/utils.js';
import { decodePixelResponse } from '../core/utils.js';
import { synthHighlights } from '../core/state.js';
import { clearOverlay, redrawAllHighlights, getImageLayout } from '../synth/selection.js';
import { sendSynthZones, sendSynthMuteZones } from '../synth/selection.js';
import { updateZonesLabel } from '../synth/model.js';
import { updateAllSynthZones } from '../synth/cards.js';
import { cancelZonePicking } from '../synth/selection.js';

// Deferred so importing this module does not touch the Tauri globals.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

// Cross-domain hooks injected by main.js at startup.
let hooks = { isMirrorOpen: () => false };
export function configureImageEditor(injected) {
    hooks = { ...hooks, ...injected };
}

const loadBtn = document.querySelector('#load-btn');
const resetBtn = document.querySelector('#reset-btn');
const rotateBtn = document.querySelector('#rotate-img-btn');
const cropBtn = document.querySelector('#crop-img-btn');
const transformBtn = document.querySelector('#transform-img-btn');
const showOriginalBtn = document.querySelector('#show-original-btn');
const preview = document.querySelector('#preview');
const previewCanvas = document.querySelector('#processed-preview');
const viewerEmpty = document.querySelector('#viewer-empty');
const pixelOverlay = document.querySelector('#pixel-overlay');
const gridSlider = document.querySelector('#grid-width');
const gridValue = document.querySelector('#grid-width-value');
const vibrance = document.querySelector('#vibrance');
const vibranceValue = document.querySelector('#vibrance-value');
const contrast = document.querySelector('#contrast');
const contrastValue = document.querySelector('#contrast-value');
const brightness = document.querySelector('#brightness');
const brightnessValue = document.querySelector('#brightness-value');
const posterize = document.querySelector('#posterize');
const posterizeValue = document.querySelector('#posterize-value');
const texture = document.querySelector('#texture');
const textureValue = document.querySelector('#texture-value');
const clarity = document.querySelector('#clarity');
const clarityValue = document.querySelector('#clarity-value');
const simplify = document.querySelector('#simplify');
const simplifyValue = document.querySelector('#simplify-value');
const autoLevelsBtn = document.querySelector('#auto-levels-btn');
const dimensionsInfo = document.querySelector('#dimensions-info');

// Crop state, exported so main.js's shared pixelOverlay listeners can
// drive it without a large accessor surface.
export const cropState = { mode: false, rect: null, drag: null, ratio: null };

export function currentGridWidth() {
  return sliderToCells(Number(gridSlider.value), viewer.origWidth);
}

// ---------- Settings ----------
export function buildParams() {
  return {
    grid_width:       currentGridWidth(),
    grid_height:      null,              // always deduced from the ratio
    contrast:         Number(contrast.value),
    brightness:       Number(brightness.value),
    vibrance:         Number(vibrance.value),
    posterize_levels: sliderToPosterizeLevels(Number(posterize.value)),
    texture:          Number(texture.value),
    clarity:          Number(clarity.value),
    simplify:         Number(simplify.value),
    auto_levels:      autoLevelsBtn.classList.contains('active'),
  };
}

// ---------- Display ----------
export function paintPreviewCanvas(pixels) {
    if (previewCanvas.width !== pixels.width) previewCanvas.width = pixels.width;
    if (previewCanvas.height !== pixels.height) previewCanvas.height = pixels.height;
    previewCanvas.getContext('2d').putImageData(
        new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
}

// Shows the right surface: the <img> for the original ("Show original"
// toggle), the canvas for everything that comes as raw pixels (processed
// image, transform live preview — the latter taking precedence).
// The original is routed by the toggle: in the main viewer while the
// projection mirror is closed, in the mirror only while it is open (the
// main viewer then falls back to the grid render and stays interactive).
export function updatePreviewSrc() {
    const showOrig = showOriginalBtn.classList.contains('active') && !hooks.isMirrorOpen();
    const pixels = viewer.transformPreviewPixels ?? (showOrig ? null : viewer.processedPixels);

    if (pixels) {
        paintPreviewCanvas(pixels);
        previewCanvas.classList.remove('hidden');
        preview.classList.add('hidden');
    } else if (showOrig && viewer.originalPng) {
        preview.src = `data:image/png;base64,${viewer.originalPng}`;
        preview.classList.remove('hidden');
        previewCanvas.classList.add('hidden');
    } else {
        preview.classList.add('hidden');
        previewCanvas.classList.add('hidden');
    }

    // The processed view is the grid render: show cells as crisp blocks
    previewCanvas.classList.toggle('pixelated', !showOrig && viewer.transformPreviewPixels === null);

    appEvents.emit('viewer-image-changed');
}

export function syncLabels() {
  gridValue.textContent       = viewer.hasImage ? currentGridWidth() : '-';
  contrastValue.textContent   = Number(contrast.value).toFixed(0);
  brightnessValue.textContent = Number(brightness.value).toFixed(0);
  vibranceValue.textContent   = Number(vibrance.value).toFixed(0);
  textureValue.textContent    = Number(texture.value).toFixed(0);
  clarityValue.textContent    = Number(clarity.value).toFixed(0);
  simplifyValue.textContent   = Number(simplify.value).toFixed(0);

  const p = sliderToPosterizeLevels(Number(posterize.value));
  posterizeValue.textContent = p ? t('controls.posterizeLevels', { count: p }) : t('controls.posterizeOff');
}

// ---------- Refresh ----------
let pending = false;
let lastDimensionsInfo = null; // remembers the last result, to retranslate on locale change

export async function refresh() {
  if (!viewer.hasImage || pending) return;
  pending = true;

  try {
    const buf = await invoke('apply_image_adjustments', {
      params: buildParams(),
    });
    const decoded = decodePixelResponse(buf);

    viewer.processedPixels = decoded;
    updatePreviewSrc();

    viewer.totalPixels = decoded.width * decoded.height;
    viewer.gridW = decoded.width;
    viewer.gridH = decoded.height;
    clearOverlay();
    cancelZonePicking();
    updateAllSynthZones();

    lastDimensionsInfo = {
      origWidth: viewer.origWidth, origHeight: viewer.origHeight,
      width: decoded.width, height: decoded.height,
      cellCount: viewer.totalPixels,
    };
    dimensionsInfo.textContent = t('controls.dimensionsInfo', lastDimensionsInfo);
  } catch (err) {
    console.error('Error while processing:', err);
    dimensionsInfo.textContent = translateError(err);
  } finally {
    pending = false;
  }
}

let debounceId = null;
export function scheduleRefresh(delay = 60) {
  clearTimeout(debounceId);
  debounceId = setTimeout(refresh, delay);
}

// ---------- Loading ----------
loadBtn.addEventListener('click', async () => {
  try {
    const result = await invoke('load_image');
    if (!result) return;

    exitCropMode();
    closeTransformPanel();

    viewer.origWidth   = result.orig_width;
    viewer.origHeight  = result.orig_height;
    viewer.originalPng = result.base64_png;
    viewer.hasImage    = true;
    appEvents.emit('session-dirty');

    gridSlider.value         = SLIDER_STEPS;
    showOriginalBtn.classList.remove('active');

    viewerEmpty.classList.add('hidden');

    syncLabels();
    // A new image invalidates every zone: they are grid coordinates of
    // the previous image and carry no meaning here (same policy as the
    // reshape operations). resetAllSynthZones clears them on the UI and
    // backend sides alike (silences too — they live within the
    // selection), then the plain refresh re-renders the grid: the
    // zone re-push inside it is a no-op (everything is already empty).
    resetAllSynthZones();
    await refresh();
  } catch (err) {
    console.error('Error while loading the image:', err);
    dimensionsInfo.textContent = translateError(err);
  }
});

// ---------- Image shape tools (rotate / crop / transform) ----------
// Every reshape operation resets the synth zones and silences: they are
// grid coordinates and would no longer match the manipulated image.
export function resetAllSynthZones() {
    synthHighlights.forEach(hi => {
        hi.zones = [];
        hi.muteZones = [];
    });
    document.querySelector('.synth-list-body').querySelectorAll('.synth-block').forEach(el => {
        const id = Number(el.dataset.synthId);
        sendSynthZones(id);
        sendSynthMuteZones(id);
        updateZonesLabel(id);
    });
    redrawAllHighlights();
}

// Applies a backend reshape result (new original) to the frontend state
export async function applyReshapedImage(result) {
    appEvents.emit('session-dirty');
    viewer.origWidth   = result.orig_width;
    viewer.origHeight  = result.orig_height;
    viewer.originalPng = result.base64_png;

    resetAllSynthZones();
    syncLabels();
    updatePreviewSrc();
    await refresh();
}

// ---------- Rotation (90° steps) ----------
rotateBtn.addEventListener('click', async () => {
    if (!viewer.hasImage) return;
    try {
        const result = await invoke('rotate_image');

        exitCropMode();
        closeTransformPanel();
        await applyReshapedImage(result);
    } catch (err) {
        console.error('Error while rotating the image:', err);
        dimensionsInfo.textContent = translateError(err);
    }
});

// ---------- Crop ----------
export const cropBar          = document.querySelector('#crop-bar');
export const cropApplyBtn     = document.querySelector('#crop-apply-btn');
export const cropCancelBtn    = document.querySelector('#crop-cancel-btn');






const CROP_HANDLE_HIT  = 6; // grab tolerance around an edge/corner, in overlay px
const CROP_HANDLE_DRAW = 8; // on-screen size of the handle squares
const CROP_MIN_SIZE    = 1; // smallest frame a resize can produce, in overlay px
export const CROP_HANDLE_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize',   s: 'ns-resize',
    e: 'ew-resize',   w: 'ew-resize',
};

// Image bounds in overlay canvas pixels: the frame never leaves them
export function cropImageBounds() {
    const layout = getImageLayout();
    if (layout) return { x: layout.offsetX, y: layout.offsetY, w: layout.renderW, h: layout.renderH };
    return { x: 0, y: 0, w: pixelOverlay.width, h: pixelOverlay.height };
}

// Shifts the rect (size unchanged) so it stays inside the image bounds
export function clampCropRect(rect) {
    const b = cropImageBounds();
    rect.w = Math.min(rect.w, b.w);
    rect.h = Math.min(rect.h, b.h);
    rect.x = Math.min(Math.max(rect.x, b.x), b.x + b.w - rect.w);
    rect.y = Math.min(Math.max(rect.y, b.y), b.y + b.h - rect.h);
    return rect;
}

// Re-fits an existing rect onto the forced ratio: the size is capped by both
// the current rect and the image bounds, the position keeps the rect center
export function applyCropRatioToRect(rect) {
    if (!cropState.ratio) return rect;
    const b = cropImageBounds();
    let w = rect.w;
    let h = w / cropState.ratio;
    if (h > rect.h) { h = rect.h; w = h * cropState.ratio; }
    if (w > b.w)    { w = b.w;    h = w / cropState.ratio; }
    if (h > b.h)    { h = b.h;    w = h * cropState.ratio; }
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return clampCropRect({ x: cx - w / 2, y: cy - h / 2, w, h });
}

// What a press at (px, py) would grab: a resize handle, the frame interior
// (move), or empty space (draw a brand new frame)
export function cropDragTargetAt(px, py) {
    if (!cropState.rect) return { kind: 'new', handle: null };
    const { x, y, w, h } = cropState.rect;
    const t = CROP_HANDLE_HIT;
    const inside = px >= x && px <= x + w && py >= y && py <= y + h;
    // A tiny frame is easier to move than to resize: interior presses move it
    if (inside && w <= 2 * t && h <= 2 * t) return { kind: 'move', handle: null };
    const nearL = Math.abs(px - x) <= t;
    const nearR = Math.abs(px - (x + w)) <= t;
    const nearT = Math.abs(py - y) <= t;
    const nearB = Math.abs(py - (y + h)) <= t;
    if (nearL && nearT) return { kind: 'resize', handle: 'nw' };
    if (nearR && nearT) return { kind: 'resize', handle: 'ne' };
    if (nearL && nearB) return { kind: 'resize', handle: 'sw' };
    if (nearR && nearB) return { kind: 'resize', handle: 'se' };
    if (nearT) return { kind: 'resize', handle: 'n' };
    if (nearB) return { kind: 'resize', handle: 's' };
    if (nearL) return { kind: 'resize', handle: 'w' };
    if (nearR) return { kind: 'resize', handle: 'e' };
    if (inside) return { kind: 'move', handle: null };
    return { kind: 'new', handle: null };
}

// Computes the frame for the drag in progress from the current pointer
// position. Every branch keeps the frame inside the image bounds.
export function updateCropDrag(cx, cy) {
    const { kind, handle, startX, startY, orig } = cropState.drag;
    const b = cropImageBounds();
    const dx = cx - startX;
    const dy = cy - startY;

    if (kind === 'move') {
        return clampCropRect({ x: orig.x + dx, y: orig.y + dy, w: orig.w, h: orig.h });
    }

    if (kind === 'new') {
        // Anchor clamped inside the image: pressing outside the image starts
        // the frame on the nearest image edge
        const ax = Math.max(b.x, Math.min(b.x + b.w, startX));
        const ay = Math.max(b.y, Math.min(b.y + b.h, startY));
        const dirX = cx >= ax ? 1 : -1;
        const dirY = cy >= ay ? 1 : -1;
        const availW = dirX > 0 ? b.x + b.w - ax : ax - b.x;
        const availH = dirY > 0 ? b.y + b.h - ay : ay - b.y;
        let w = Math.min(Math.abs(cx - ax), availW);
        let h = Math.min(Math.abs(cy - ay), availH);
        if (cropState.ratio) {
            // Dominant drag axis drives the frame, the other follows
            if (w >= h * cropState.ratio) {
                h = w / cropState.ratio;
                if (h > availH) { h = availH; w = h * cropState.ratio; }
            } else {
                w = h * cropState.ratio;
                if (w > availW) { w = availW; h = w / cropState.ratio; }
            }
        }
        return { x: dirX > 0 ? ax : ax - w, y: dirY > 0 ? ay : ay - h, w, h };
    }

    // --- resize ---
    if (!cropState.ratio) {
        let left = orig.x, right = orig.x + orig.w;
        let top = orig.y, bottom = orig.y + orig.h;
        if (handle.includes('w')) left = orig.x + dx;
        if (handle.includes('e')) right = orig.x + orig.w + dx;
        if (handle.includes('n')) top = orig.y + dy;
        if (handle.includes('s')) bottom = orig.y + orig.h + dy;
        left  = Math.min(Math.max(left, b.x), right - CROP_MIN_SIZE);
        right = Math.min(Math.max(right, left + CROP_MIN_SIZE), b.x + b.w);
        top   = Math.min(Math.max(top, b.y), bottom - CROP_MIN_SIZE);
        bottom = Math.min(Math.max(bottom, top + CROP_MIN_SIZE), b.y + b.h);
        return { x: left, y: top, w: right - left, h: bottom - top };
    }

    // Ratio-locked resize: the opposite edge/corner stays anchored. Corner
    // handles follow the dominant drag axis; edge handles resize along their
    // axis and stay centered on the other.
    const horiz = handle.includes('w') || handle.includes('e');
    const vert  = handle.includes('n') || handle.includes('s');
    if (horiz && vert) {
        const ax = handle.includes('w') ? orig.x + orig.w : orig.x; // anchored vertical edge
        const ay = handle.includes('n') ? orig.y + orig.h : orig.y; // anchored horizontal edge
        const availW = handle.includes('w') ? ax - b.x : b.x + b.w - ax;
        const availH = handle.includes('n') ? ay - b.y : b.y + b.h - ay;
        const wantW = handle.includes('w') ? orig.w - dx : orig.w + dx;
        const wantH = handle.includes('n') ? orig.h - dy : orig.h + dy;
        let w, h;
        if (wantW >= wantH * cropState.ratio) { w = wantW; h = w / cropState.ratio; }
        else                            { h = wantH; w = h * cropState.ratio; }
        w = Math.max(CROP_MIN_SIZE, Math.min(w, availW));
        h = w / cropState.ratio;
        if (h > availH) { h = availH; w = h * cropState.ratio; }
        return clampCropRect({
            x: handle.includes('w') ? ax - w : ax,
            y: handle.includes('n') ? ay - h : ay,
            w, h,
        });
    }
    const centerX = orig.x + orig.w / 2;
    const centerY = orig.y + orig.h / 2;
    let w, h;
    if (horiz) {
        const availW = Math.min(centerX - b.x, b.x + b.w - centerX) * 2;
        const wantW = handle === 'w' ? orig.w - dx : orig.w + dx;
        w = Math.max(CROP_MIN_SIZE, Math.min(wantW, availW));
        h = w / cropState.ratio;
        const availH = Math.min(centerY - b.y, b.y + b.h - centerY) * 2;
        if (h > availH) { h = availH; w = h * cropState.ratio; }
    } else {
        const availH = Math.min(centerY - b.y, b.y + b.h - centerY) * 2;
        const wantH = handle === 'n' ? orig.h - dy : orig.h + dy;
        h = Math.max(CROP_MIN_SIZE, Math.min(wantH, availH));
        w = h * cropState.ratio;
        const availW = Math.min(centerX - b.x, b.x + b.w - centerX) * 2;
        if (w > availW) { w = availW; h = w / cropState.ratio; }
    }
    return clampCropRect({ x: centerX - w / 2, y: centerY - h / 2, w, h });
}

export function drawCropOverlay() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    if (!cropState.rect) return;
    const { x, y, w, h } = cropState.rect;
    const vw = pixelOverlay.width;
    const vh = pixelOverlay.height;

    ctx.save();
    // Dim everything outside the selection
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, vw, y);
    ctx.fillRect(0, y + h, vw, vh - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, vw - x - w, h);
    // Selection outline
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    // Corner & edge handles
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    const hs = CROP_HANDLE_DRAW;
    for (const [hx, hy] of [
        [x, y], [x + w / 2, y], [x + w, y],
        [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h],
        [x, y + h], [x, y + h / 2],
    ]) {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
    ctx.restore();
}

export function enterCropMode() {
    if (!viewer.hasImage || cropState.mode) return;
    cancelZonePicking();
    closeTransformPanel();
    cropState.mode = true;
    cropState.rect = null;
    cropState.drag = null;
    // Each session starts free-form: predictable behavior across sessions
    cropState.ratio = null;
    cropRatioGroup.querySelectorAll('.ratio-btn').forEach(btn => {
        btn.classList.toggle('active', !btn.dataset.cropState.ratio);
    });
    cropBtn.classList.add('active');
    pixelOverlay.classList.add('picking');
    pixelOverlay.style.cursor = 'crosshair';
    cropBar.classList.remove('hidden');
    cropApplyBtn.disabled = true;
    drawCropOverlay();
}

export function exitCropMode() {
    if (!cropState.mode) return;
    cropState.mode = false;
    cropState.rect = null;
    cropState.drag = null;
    cropBtn.classList.remove('active');
    pixelOverlay.classList.remove('picking');
    pixelOverlay.style.cursor = '';
    cropBar.classList.add('hidden');
    redrawAllHighlights();
}

cropBtn.addEventListener('click', () => cropState.mode ? exitCropMode() : enterCropMode());
cropCancelBtn.addEventListener('click', exitCropMode);

// ---------- Crop: forced aspect ratio ----------
export const cropRatioGroup = document.querySelector('#crop-ratio-group');

// "1", "4/3", "16/9"... -> number (w/h); "" -> null (free form)
export function parseCropRatio(str) {
    if (!str) return null;
    const m = str.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return null;
    return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
}

cropRatioGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.ratio-btn');
    if (!btn) return;
    const ratio = parseCropRatio(btn.dataset.cropState.ratio);
    if (ratio === cropState.ratio) return;
    cropState.ratio = ratio;
    cropRatioGroup.querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b === btn));
    // An existing frame is re-fitted onto the new ratio
    if (cropState.rect) {
        cropState.rect = applyCropRatioToRect(cropState.rect);
        drawCropOverlay();
    }
});

cropApplyBtn.addEventListener('click', async () => {
    if (!cropState.mode || !cropState.rect || !viewer.hasImage) return;
    const layout = getImageLayout();
    if (!layout) return;

    // Overlay canvas pixels → original image pixels
    const x = Math.max(0, Math.round((cropState.rect.x - layout.offsetX) / layout.renderW * viewer.origWidth));
    const y = Math.max(0, Math.round((cropState.rect.y - layout.offsetY) / layout.renderH * viewer.origHeight));
    const w = Math.max(1, Math.min(viewer.origWidth - x, Math.round(cropState.rect.w / layout.renderW * viewer.origWidth)));
    const h = Math.max(1, Math.min(viewer.origHeight - y, Math.round(cropState.rect.h / layout.renderH * viewer.origHeight)));

    try {
        const result = await invoke('crop_image', { x, y, width: w, height: h });
        exitCropMode();
        await applyReshapedImage(result);
    } catch (err) {
        console.error('Error while cropping the image:', err);
        dimensionsInfo.textContent = translateError(err);
    }
});

// ---------- Transform (fine rotation + perspective) ----------
export const transformPanel          = document.querySelector('#transform-panel');
export const transformApplyBtn       = document.querySelector('#transform-apply-btn');
export const transformCancelBtn      = document.querySelector('#transform-cancel-btn');
export const transformRotation       = document.querySelector('#transform-rotation');
export const transformRotationValue  = document.querySelector('#transform-rotation-value');
export const transformPerspV         = document.querySelector('#transform-persp-v');
export const transformPerspVValue    = document.querySelector('#transform-persp-v-value');
export const transformPerspH         = document.querySelector('#transform-persp-h');
export const transformPerspHValue    = document.querySelector('#transform-persp-h-value');
export const transformGridBtn        = document.querySelector('#transform-grid-btn');

let transformActive = false;
let transformDebounceId = null;
let transformRequestToken = 0;     // discards stale preview responses

export function transformParams() {
    return {
        rotation: Number(transformRotation.value),
        perspective_v: Number(transformPerspV.value) / 100,
        perspective_h: Number(transformPerspH.value) / 100,
    };
}

export function isTransformPending() {
    const p = transformParams();
    return p.rotation !== 0 || p.perspective_v !== 0 || p.perspective_h !== 0;
}

// ---------- Alignment grid overlay ----------
// Computes the render rect of the image currently displayed in the viewer:
// the transform preview while the panel is open (its canvas changes size
// with the rotation/perspective), the processed grid otherwise.
export function getDisplayedImageLayout() {
    const vw = pixelOverlay.width;
    const vh = pixelOverlay.height;
    const pixels = viewer.transformPreviewPixels ?? viewer.processedPixels;
    if (!pixels || !pixels.width || !pixels.height || !vw || !vh) return null;
    const imgRatio  = pixels.width / pixels.height;
    const viewRatio = vw / vh;
    let renderW, renderH;
    if (imgRatio > viewRatio) { renderW = vw; renderH = vw / imgRatio; }
    else                      { renderH = vh; renderW = vh * imgRatio; }
    return {
        renderW, renderH,
        offsetX: (vw - renderW) / 2,
        offsetY: (vh - renderH) / 2,
    };
}

// Rule of thirds plus a finer 12-division grid, drawn over the displayed
// image. The grid is fixed relative to the viewer: it does not rotate with
// the image, so it can be used as an alignment reference.
const TRANSFORM_GRID_DIVISIONS = 12;

export function drawTransformGrid() {
    const layout = getDisplayedImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, renderW, renderH } = layout;
    const ctx = pixelOverlay.getContext('2d');

    ctx.save();
    ctx.lineWidth = 1;

    const vline = i => offsetX + Math.round(renderW * i / TRANSFORM_GRID_DIVISIONS) + 0.5;
    const hline = i => offsetY + Math.round(renderH * i / TRANSFORM_GRID_DIVISIONS) + 0.5;
    const third1 = TRANSFORM_GRID_DIVISIONS / 3;
    const third2 = 2 * TRANSFORM_GRID_DIVISIONS / 3;

    // Fine grid (thirds drawn separately, stronger)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    for (let i = 1; i < TRANSFORM_GRID_DIVISIONS; i++) {
        if (i === third1 || i === third2) continue;
        ctx.moveTo(vline(i), offsetY);
        ctx.lineTo(vline(i), offsetY + renderH);
        ctx.moveTo(offsetX, hline(i));
        ctx.lineTo(offsetX + renderW, hline(i));
    }
    ctx.stroke();

    // Rule of thirds
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    for (const i of [third1, third2]) {
        ctx.moveTo(vline(i), offsetY);
        ctx.lineTo(vline(i), offsetY + renderH);
        ctx.moveTo(offsetX, hline(i));
        ctx.lineTo(offsetX + renderW, hline(i));
    }
    ctx.stroke();

    // Displayed image bounds (the transform preview includes transparent
    // corners when rotated)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, renderW - 1, renderH - 1);

    ctx.restore();
}

// Rebuilds the whole overlay while the transform panel is open: synth
// highlights first, alignment grid on top.
export function redrawTransformOverlay() {
    redrawAllHighlights();
    if (transformGridBtn.classList.contains('active')) drawTransformGrid();
}

export function syncTransformLabels() {
    transformRotationValue.textContent = `${Number(transformRotation.value).toFixed(1)}°`;
    transformPerspVValue.textContent = Number(transformPerspV.value);
    transformPerspHValue.textContent = Number(transformPerspH.value);
    transformApplyBtn.disabled = !isTransformPending();
}

export function scheduleTransformPreview(delay = 150) {
    clearTimeout(transformDebounceId);
    transformDebounceId = setTimeout(requestTransformPreview, delay);
}

export async function requestTransformPreview() {
    if (!transformActive) return;
    // No adjustment: show the original as-is (no backend round trip)
    if (!isTransformPending()) {
        transformRequestToken++;
        viewer.transformPreviewPixels = null;
        updatePreviewSrc();
        redrawTransformOverlay();
        return;
    }
    const params = transformParams();
    const token = ++transformRequestToken;
    try {
        const buf = await invoke('preview_image_transform', { params });
        if (!transformActive || token !== transformRequestToken) return;
        viewer.transformPreviewPixels = decodePixelResponse(buf);
        updatePreviewSrc();
        redrawTransformOverlay();
    } catch (err) {
        console.error('Error in preview_image_transform:', err);
    }
}

export function openTransformPanel() {
    if (!viewer.hasImage || transformActive) return;
    cancelZonePicking();
    exitCropMode();
    transformActive = true;
    transformBtn.classList.add('active');
    transformPanel.classList.remove('hidden');
    // The sliders start from zero: any previous adjustment was consumed
    // into the original when applied
    transformRotation.value = 0;
    transformPerspV.value = 0;
    transformPerspH.value = 0;
    syncTransformLabels();
    viewer.transformPreviewPixels = null;
    updatePreviewSrc();
    redrawTransformOverlay();
}

export function closeTransformPanel() {
    if (!transformActive) return;
    transformActive = false;
    clearTimeout(transformDebounceId);
    transformRequestToken++;
    viewer.transformPreviewPixels = null;
    transformBtn.classList.remove('active');
    transformPanel.classList.add('hidden');
    updatePreviewSrc();
    redrawAllHighlights(); // removes the alignment grid
}

transformBtn.addEventListener('click', () => transformActive ? closeTransformPanel() : openTransformPanel());
transformCancelBtn.addEventListener('click', closeTransformPanel);

[transformRotation, transformPerspV, transformPerspH].forEach(el => {
    el.addEventListener('input', () => {
        syncTransformLabels();
        scheduleTransformPreview();
    });
});

transformGridBtn.addEventListener('click', () => {
    transformGridBtn.classList.toggle('active');
    redrawTransformOverlay();
});

// Keyboard control while the transform panel is open: arrows adjust the
// perspective, Shift+up/down the fine rotation. Skipped when the focus is
// already in a form field or button, since the focused widget handles the
// keys itself (native slider behavior).
window.addEventListener('keydown', (e) => {
    if (!transformActive) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

    let slider = null;
    let delta  = 0;
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        slider = transformRotation;
        delta  = e.key === 'ArrowUp' ? 0.1 : -0.1;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        slider = transformPerspV;
        delta  = e.key === 'ArrowUp' ? 1 : -1;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        slider = transformPerspH;
        delta  = e.key === 'ArrowRight' ? 1 : -1;
    }
    if (!slider) return;

    e.preventDefault(); // the arrows must not scroll the page
    const next = Math.min(Number(slider.max), Math.max(Number(slider.min), Number(slider.value) + delta));
    // Rounded to one decimal: the rotation accumulates 0.1 steps and the
    // float sum would drift (0.1 + 0.2 = 0.30000000000000004)
    slider.value = Math.round(next * 10) / 10;
    syncTransformLabels();
    scheduleTransformPreview();
});

// Double-click on a slider resets it to zero
[transformRotation, transformPerspV, transformPerspH].forEach(el => {
    el.addEventListener('dblclick', () => {
        el.value = 0;
        syncTransformLabels();
        scheduleTransformPreview();
    });
});

transformApplyBtn.addEventListener('click', async () => {
    if (!transformActive || !viewer.hasImage || !isTransformPending()) return;
    const params = transformParams();
    try {
        const result = await invoke('apply_image_transform', { params });
        closeTransformPanel(); // restores the normal preview
        await applyReshapedImage(result);
    } catch (err) {
        console.error('Error while transforming the image:', err);
        dimensionsInfo.textContent = translateError(err);
    }
});

// ---------- Reset ----------
resetBtn.addEventListener('click', () => {
  gridSlider.value  = SLIDER_STEPS;
  contrast.value    = 0;
  brightness.value  = 0;
  vibrance.value  = 0;
  posterize.value   = 0;
  texture.value    = 0;
  clarity.value    = 0;
  simplify.value   = 0;
  autoLevelsBtn.classList.remove('active');

  appEvents.emit('session-dirty');
  syncLabels();
  refresh();
});
// ---------- Listeners ----------
// The column-count change only ever happens while nothing plays (the
// slider is locked during playback): the debounced refresh re-renders
// continuously during the drag, and the zones simply stay at their
// place — updateAllSynthZones clips them to the new grid and drops
// the ones that no longer intersect it.
[gridSlider, contrast, brightness, vibrance, posterize, texture, clarity, simplify].forEach(el => {
  el.addEventListener('input', () => {
    syncLabels();
    scheduleRefresh();
  });
});

// Double-click a slider to reset it to its default value (0 for the
// adjustments, the maximum for the grid width)
const sliderDefaults = new Map([
  [gridSlider, SLIDER_STEPS],
  [contrast, 0],
  [brightness, 0],
  [vibrance, 0],
  [posterize, 0],
  [texture, 0],
  [clarity, 0],
  [simplify, 0],
]);
sliderDefaults.forEach((def, el) => {
  el.addEventListener('dblclick', () => {
    if (el.value == def) return;
    el.value = def;
    appEvents.emit('session-dirty');
    syncLabels();
    scheduleRefresh();
  });
});

autoLevelsBtn.addEventListener('click', () => {
  autoLevelsBtn.classList.toggle('active');
  appEvents.emit('session-dirty');
  scheduleRefresh();
});

// ---------- Manual column entry: double-click the placeholder ----------
// The column count normally follows the logarithmic slider; a
// double-click on the displayed count opens an inline input to type an
// exact number instead. Values outside 2..origWidth are refused (the
// input closes without changing anything), as is any entry while the
// controls are locked during playback.
gridValue.addEventListener('dblclick', () => {
  if (!viewer.hasImage || gridSlider.disabled || document.querySelector('#grid-width-input')) return;

  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'grid-width-input';
  input.className = 'grid-width-input';
  input.min = MIN_CELLS;
  input.max = viewer.origWidth;
  input.step = 1;
  input.value = currentGridWidth();

  gridValue.classList.add('hidden');
  gridValue.after(input);
  input.focus();
  input.select();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input.remove();
    gridValue.classList.remove('hidden');
  };
  const commit = () => {
    if (closed) return;
    const cells = Math.round(Number(input.value));
    if (Number.isFinite(cells) && cells >= MIN_CELLS && cells <= viewer.origWidth) {
      gridSlider.value = cellsToSlider(cells, viewer.origWidth);
      appEvents.emit('session-dirty');
      syncLabels();
      scheduleRefresh();
    }
    close();
  };

  input.addEventListener('keydown', (e) => {
    // Enter commits, Escape cancels; stopPropagation prevents global
    // handlers (zone picking, help mode) from firing as well
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', commit);
});

// "Show original" routes the original image by the mirror's state:
// main viewer while the mirror is closed, mirror only while it is open
// (see updatePreviewSrc). Closing the mirror while the original is
// shown there resets the toggle.
showOriginalBtn.addEventListener('click', () => {
    showOriginalBtn.classList.toggle('active');
    updatePreviewSrc();
});
// Whether the crop frame is armed (global shortcuts, ResizeObserver).
export const isCropActive = () => cropState.mode;
// Whether the transform panel is open (ResizeObserver, global shortcuts).
export const isTransformActive = () => transformActive;
// Re-renders the dimensions line on locale change (main.js's handler).
export function refreshDimensionsInfo() {
    if (lastDimensionsInfo) {
        dimensionsInfo.textContent = t('controls.dimensionsInfo', lastDimensionsInfo);
    }
}

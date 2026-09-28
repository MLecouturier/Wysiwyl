// Synth selection: the zone/mute editing, the overlay highlights and
// the mouse-based zone selection tools.

import { cellSetFromZones, computeLayout, drawCursorCell, drawZones, rebuildZones, zoneCellSet, zoneIntersectsRect } from '../core/geometry.js';
import { appEvents, synthBrightnessBounds, synthColors, synthCursorGrid, synthCursorMuted, synthCursors, synthHighlights, viewer } from '../core/state.js';
import { syncEyeButton, synthElementById, updateZonesLabel } from './model.js';

// Synth zone editing and persistence: adding/removing selection
// rectangles, the manual silences (rests), and the commands that push
// the resulting zones to the backend. The zones are exact connected
// components (see zones.js); these helpers only compose and send them.

// Deferred so importing this module does not touch the Tauri globals.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

export function addSynthZone(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const cells = zoneCellSet(hi.zones);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            cells.add(`${col},${row}`);
        }
    }
    hi.zones = rebuildZones(hi.zones, cells);
    sendSynthZones(id);
    updateZonesLabel(id);
}

// Subtracts a rectangle from the synth's zones: the exact difference is
// rebuilt as connected components, so a zone cut in the middle splits
// into two fragments that both keep its creation order. Deselected
// pixels lose their silence.
export function removeSynthZoneRect(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const cells = zoneCellSet(hi.zones);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            cells.delete(`${col},${row}`);
        }
    }
    hi.zones = rebuildZones(hi.zones, cells);
    sendSynthZones(id);
    // Deselected pixels lose their silence
    clipMuteZonesToSelection(id);
    updateZonesLabel(id);
}

export function sendSynthZones(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    appEvents.emit('session-dirty');
    invoke('set_synth_zones', { id, zones: hi.zones })
        .catch(err => console.error('Error in set_synth_zones:', err));
}

// ---------- Manual silences (Alt + square/lasso) ----------
// Silent pixels chosen by hand among the selected ones: the playhead
// still travels over them, but no note is sounded (a rest). They are
// stored as connected components, like the selection, and always
// clipped to it: deselecting a pixel removes its silence.

// Builds the set of manually silenced cells of a synth from its mute
// zones.
export function muteCellSet(hi) {
    return cellSetFromZones(hi.muteZones);
}

// Does the rectangle overlap (even partially) one of the synth's mute
// zones? Such an Alt-drag removes silences instead of adding them.
export function rectOverlapsMuteZones(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;
    return hi.muteZones.some(z => zoneIntersectsRect(z, rect));
}

// Adds a silence rectangle (Alt + square over free space): the dragged
// rectangle silences the selected pixels it covers; touching silence
// components fuse, like the selection.
export function addSynthMuteRect(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const selected = cellSetFromZones(hi.zones);
    const cells = muteCellSet(hi);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            const key = `${col},${row}`;
            if (selected.has(key)) cells.add(key);
        }
    }
    hi.muteZones = rebuildZones(hi.muteZones, cells);
    sendSynthMuteZones(id);
}

// Subtracts a silence rectangle (Alt + square over an existing silence):
// exact difference, components recomposed.
export function removeSynthMuteRect(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    const cells = muteCellSet(hi);
    for (let row = rect.y; row < rect.y + rect.h; row++) {
        for (let col = rect.x; col < rect.x + rect.w; col++) {
            cells.delete(`${col},${row}`);
        }
    }
    hi.muteZones = rebuildZones(hi.muteZones, cells);
    sendSynthMuteZones(id);
}

// Re-clips the mute zones to the current selection — the silences only
// ever live inside it — and pushes the result to the backend when it
// actually changed.
export function clipMuteZonesToSelection(id) {
    const hi = synthHighlights.get(id);
    if (!hi || hi.muteZones.length === 0) return;
    const selected = cellSetFromZones(hi.zones);
    const muted = muteCellSet(hi);
    const kept = new Set([...muted].filter(k => selected.has(k)));
    if (kept.size === muted.size) return; // nothing deselected
    hi.muteZones = rebuildZones(hi.muteZones, kept);
    sendSynthMuteZones(id);
}

export function sendSynthMuteZones(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    appEvents.emit('session-dirty');
    invoke('set_synth_mute_zones', { id, zones: hi.muteZones })
        .catch(err => console.error('Error in set_synth_mute_zones:', err));
}

// Sends the note-range filter states: one triplet (bass, medium, treble)
// for the monophonic note, and one per R/G/B voice in polyphonic mode.
export function sendSynthNoteRanges(id, el) {
    const read = group => ['bass', 'medium', 'treble'].map(kind =>
        group.querySelector(`.synth-${kind}`).classList.contains('active')
    );
    const mono = read(el.querySelector('.synth-mode-panel-mono .synth-note-range'));
    const voices = Array.from(el.querySelectorAll('.synth-mode-panel-poly .synth-note-range'))
        .map(read);
    invoke('set_synth_note_ranges', { id, mono, voices })
        .catch(err => console.error('Error in set_synth_note_ranges:', err));
}

// Sends the enabled note lengths ("whole", "half", "quarter", "eighth",
// "sixteenth"). The UI always keeps at least one button active.
export function sendSynthNoteLengths(id, el) {
    const lengths = Array.from(el.querySelectorAll('.note-length-btn.active'))
        .map(btn => btn.dataset.length);
    invoke('set_synth_note_lengths', { id, lengths })
        .catch(err => console.error('Error in set_synth_note_lengths:', err));
}

// Viewer overlay drawing: the zone highlights, the playhead cursors and
// the channel preview, on the main window's overlay canvases. The mirror
// window is refreshed through the event bus (main.js forwards the events
// to it), so this module stays free of the mirror dependency.

// Guarded so the module stays importable outside a browser (unit tests):
// only the DOM-free helpers are exercised there.
const pixelOverlay = typeof document !== 'undefined' ? document.querySelector('#pixel-overlay') : null;
const cursorOverlay = typeof document !== 'undefined' ? document.querySelector('#cursor-overlay') : null;

// ---------- Canvas overlay ----------
export function resizeOverlay() {
    pixelOverlay.width  = pixelOverlay.offsetWidth;
    pixelOverlay.height = pixelOverlay.offsetHeight;
    cursorOverlay.width  = cursorOverlay.offsetWidth;
    cursorOverlay.height = cursorOverlay.offsetHeight;
}

// Draws the playhead of a synth. `w`/`h` are the grid dimensions the
// cursor's absolute pixel index was computed on (from the tick payload);
// they match the globals except during a live grid change, where ticks
// emitted after the backend swap can precede the change's response.
export function drawSynthPixel(synthId, cursor, muted, w = viewer.gridW, h = viewer.gridH) {
    if (!viewer.hasImage) return;
    const color = synthColors.get(synthId);
    if (!color) return;

    const ctx = cursorOverlay.getContext('2d');

    // Rendered dimensions of the image in the viewer (object-fit: contain)
    const vw = cursorOverlay.width;
    const vh = cursorOverlay.height;
    const imgRatio = w / h;
    const viewRatio = vw / vh;

    let renderW, renderH, offsetX, offsetY;
    if (imgRatio > viewRatio) {
        renderW = vw;
        renderH = vw / imgRatio;
    } else {
        renderH = vh;
        renderW = vh * imgRatio;
    }
    offsetX = (vw - renderW) / 2;
    offsetY = (vh - renderH) / 2;

    const cellW = renderW / w;
    const cellH = renderH / h;

    // Only clear the previous pixel of this synth — decoded against the
    // grid it was recorded on. When that grid is the one that just
    // changed (dims differ), the precise erase is skipped: the change's
    // response wipes the whole cursor layer anyway
    const prev = synthCursors.get(synthId);
    const pg = synthCursorGrid.get(synthId);
    if (prev !== undefined && pg && pg.w === w && pg.h === h) {
        const pc = prev % w;
        const pr = Math.floor(prev / w);
        ctx.clearRect(
            offsetX + pc * cellW - 1,
            offsetY + pr * cellH - 1,
            cellW + 2, cellH + 2
        );
        // Redraw other synths that occupy this pixel
        synthCursors.forEach((c, sid) => {
            if (sid !== synthId && c === prev) drawPixelAt(ctx, sid, c, offsetX, offsetY, cellW, cellH, synthCursorMuted.get(sid), w);
        });
    }

    synthCursors.set(synthId, cursor);
    synthCursorMuted.set(synthId, !!muted);
    synthCursorGrid.set(synthId, { w, h });
    drawPixelAt(ctx, synthId, cursor, offsetX, offsetY, cellW, cellH, muted, w);
    appEvents.emit('cursors-changed');
}

export function drawPixelAt(ctx, synthId, cursor, offsetX, offsetY, cellW, cellH, muted, w = viewer.gridW) {
    const color = synthColors.get(synthId);
    if (!color) return;
    drawCursorCell(ctx, { offsetX, offsetY, cellW, cellH, gridW: w }, { color, cursor, muted });
}

// Removes one synth's cursor from the cursor layer: erases its cell and
// repaints the cursors of any other synth sitting on that same cell
export function eraseSynthCursor(synthId) {
    const prev = synthCursors.get(synthId);
    const pg = synthCursorGrid.get(synthId);
    synthCursors.delete(synthId);
    synthCursorMuted.delete(synthId);
    synthCursorGrid.delete(synthId);
    appEvents.emit('cursors-changed');
    if (prev === undefined || !viewer.hasImage || !pg || !pg.w || !pg.h) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const ctx = cursorOverlay.getContext('2d');
    const pc = prev % pg.w;
    const pr = Math.floor(prev / pg.w);
    ctx.clearRect(
        offsetX + pc * cellW - 1,
        offsetY + pr * cellH - 1,
        cellW + 2, cellH + 2
    );
    synthCursors.forEach((c, sid) => {
        if (c === prev) drawPixelAt(ctx, sid, c, offsetX, offsetY, cellW, cellH, synthCursorMuted.get(sid));
    });
}

export function clearOverlay() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    const cursorCtx = cursorOverlay.getContext('2d');
    cursorCtx.clearRect(0, 0, cursorOverlay.width, cursorOverlay.height);
    synthCursors.clear();
    synthCursorMuted.clear();
    synthCursorGrid.clear();
    appEvents.emit('cursors-changed');
}
// Computes the render dimensions of the image in the viewer (object-fit:
// contain). Thin binding of the shared renderer on the main window's
// overlay canvas, so every call site keeps the same signature.
export function getImageLayout() {
    return computeLayout(pixelOverlay.width, pixelOverlay.height, viewer.gridW, viewer.gridH);
}

// Refreshes the stored brightness bounds of a synth from its sliders and
// redraws the highlights: muted-pixel marks depend on the bounds.
export function updateBrightnessBounds(id) {
    const el = synthElementById(id);
    if (!el) return;
    const bounds = synthBrightnessBounds.get(id);
    if (!bounds) return;
    bounds.min = Number(el.querySelector('.brightness-start').value);
    bounds.max = Number(el.querySelector('.brightness-end').value);
    redrawAllHighlights();
}

// Mute cells of a synth: pixels outside its brightness window plus the
// manually silenced ones, precomputed so the mirror window can render
// the marks without needing the processed pixel buffer.
export function computeMuteCells(synthId, hi) {
    const muteCells = new Set();
    const bounds = synthBrightnessBounds.get(synthId);
    if (bounds && viewer.processedPixels && (bounds.min > 0 || bounds.max < 127)) {
        const { width: pw, rgba } = viewer.processedPixels;
        for (const z of hi.zones) {
            for (const r of z.runs) {
                for (let col = r.x0; col <= r.x1; col++) {
                    const i = (r.y * pw + col) * 4;
                    if (i + 2 >= rgba.length) continue; // torn zone edge
                    const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
                    const level = Math.round(luma / 255 * 127);
                    if (level >= bounds.min && level <= bounds.max) continue;
                    muteCells.add(`${col},${r.y}`);
                }
            }
        }
    }
    // Manually silenced pixels: they always live within the selection
    if (hi.muteZones.length > 0) {
        const selected = cellSetFromZones(hi.zones);
        for (const key of muteCellSet(hi)) {
            if (selected.has(key)) muteCells.add(key);
        }
    }
    return muteCells;
}

export function drawRangeHighlight(synthId) {
    const hi = synthHighlights.get(synthId);
    if (!hi || !hi.visible) return;
    const layout = getImageLayout();
    if (!layout) return;
    const color = synthColors.get(synthId);
    if (!color) return;

    drawZones(pixelOverlay.getContext('2d'), layout, {
        color,
        zones: hi.zones,
        muteCells: computeMuteCells(synthId, hi),
    });
}

export function clearRangeHighlight(synthId) {
    // We redraw the whole canvas from scratch (safer than targeting individual areas)
    redrawAllHighlights();
}

export function redrawAllHighlights() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    // Cursors live on their own layer (#cursor-overlay): they survive
    // zone redraws and no longer need to be repositioned here
    synthHighlights.forEach((_, sid) => drawRangeHighlight(sid));
    appEvents.emit('highlights-changed');
}

// ---------- Color channel preview (hovering the R/G/B buttons) ----------
// channelIndex: 0 = red, 1 = green, 2 = blue
// The preview is rendered in grayscale rather than tinted with the channel's
// color, so luminosities can be compared at a glance between layers.

export function drawChannelOverlay(channelIndex) {
    if (!viewer.hasImage || !viewer.processedPixels) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, renderW, renderH } = layout;
    const { width, height, rgba } = viewer.processedPixels;
    if (!width || !height) return;

    // Build an offscreen canvas at the grid's resolution, where each pixel
    // reflects the intensity of the chosen channel as a gray level.
    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d');
    const imageData = offCtx.createImageData(width, height);

    for (let i = 0; i < width * height; i++) {
        const value = rgba[i * 4 + channelIndex];
        const o = i * 4;
        imageData.data[o]     = value;
        imageData.data[o + 1] = value;
        imageData.data[o + 2] = value;
        imageData.data[o + 3] = 255;
    }
    offCtx.putImageData(imageData, 0, 0);

    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offCanvas, offsetX, offsetY, renderW, renderH);
    ctx.restore();
}

export function hideChannelOverlay() {
    redrawAllHighlights();
}

// Mouse-based zone selection on the image: rectangle, lasso and magic
// wand tools (and their Alt variants for manual silences). Owns the
// selection state (zoneState); the pixelOverlay mouse listeners live in
// main.js because they are shared with the crop tool, and drive these
// helpers.


// Selection state: the armed tool, the in-progress drags and the Alt
// (silence-editing) flag. Exported as a mutable object so main.js's
// shared mouse listeners can drive it without a large accessor surface.
export const zoneState = { pick: null, drag: null, lasso: null, altHeld: false };

// ---------- Mouse-based zone selection ----------
// Only one synth can be in zone-drawing mode at a time. Three modes:
// - rect:  each rectangle dragged on the image either adds a zone (when
//          it overlaps no existing zone) or removes pixels from the
//          existing zones (when it overlaps one, even partially).
// - lasso: free-hand closed shape. Every pixel inside the traced polygon
//          (boundary included) toggles: unselected becomes selected,
//          selected becomes deselected — except the pixels of the zone
//          under the playhead, which never lose their selection while
//          the synth is playing. Releasing the button closes the shape
//          with a straight line back to the start point.
// - wand:  magic-wand click. Every pixel 4-connected to the clicked one
//          whose color stays within the tolerance (largest per-channel
//          difference, 1–255 on the per-channel 0–255 scale) is flooded,
//          with the same positional semantics as the rectangle: a click
//          on a free pixel adds the flooded region (fusing with any
//          zone it touches), a click on a selected pixel removes the
//          flooded pixels instead. Committed on the click itself: no
//          drag.
// Holding Alt (Option) while using any of the three tools edits the
// manual silences instead of the selection: the same positional (rect,
// wand) / XOR (lasso) semantics apply to the silent pixels among the
// selected ones. A silent pixel is still travelled by the playhead, it
// just sounds nothing — a rest. Silences always live within the
// selection: deselecting a pixel removes its silence.





// Reflects the Alt key state on the overlay (distinct cursor while a
// drawing mode is armed) and refreshes the in-progress preview so it
// switches style the moment Alt is pressed or released mid-drag.
export function syncAltPickingUi() {
    pixelOverlay.classList.toggle('picking-silence', zoneState.altHeld && !!zoneState.pick);
    if (zoneState.drag || zoneState.lasso) {
        redrawAllHighlights();
        if (zoneState.drag) drawZonePreview();
        if (zoneState.lasso) drawLassoPreview();
    }
}

// Alt can be pressed or released at any time — before starting a drag
// (the mousedown captures it) or in the middle of one (the listeners
// below update the drag live, so the same gesture can switch mode).
// Guarded so the module stays importable outside a browser (unit tests).
if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Alt' || zoneState.altHeld) return;
        zoneState.altHeld = true;
        if (zoneState.drag) zoneState.drag.alt = true;
        if (zoneState.lasso) zoneState.lasso.alt = true;
        syncAltPickingUi();
    });
    window.addEventListener('keyup', (e) => {
        if (e.key !== 'Alt' || !zoneState.altHeld) return;
        zoneState.altHeld = false;
        if (zoneState.drag) zoneState.drag.alt = false;
        if (zoneState.lasso) zoneState.lasso.alt = false;
        syncAltPickingUi();
    });
    window.addEventListener('blur', () => {
        // The OS may swallow the keyup when the window loses focus
        if (!zoneState.altHeld) return;
        zoneState.altHeld = false;
        if (zoneState.drag) zoneState.drag.alt = false;
        if (zoneState.lasso) zoneState.lasso.alt = false;
        syncAltPickingUi();
    });
}

// Does the rectangle overlap (even partially) one of the synth's zones?
// Such a drag removes pixels instead of creating an overlapping zone.
export function rectOverlapsZones(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;
    return hi.zones.some(z => zoneIntersectsRect(z, rect));
}

// Normalized grid rect of the zone drag in progress, or null
export function zoneDragRect() {
    if (!zoneState.drag) return null;
    const { start, cur } = zoneState.drag;
    return {
        x: Math.min(start.col, cur.col),
        y: Math.min(start.row, cur.row),
        w: Math.abs(cur.col - start.col) + 1,
        h: Math.abs(cur.row - start.row) + 1,
    };
}

export function cellFromClientPoint(clientX, clientY) {
    const layout = getImageLayout();
    if (!layout) return null;
    const rect = pixelOverlay.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left - layout.offsetX) / layout.cellW);
    const row = Math.floor((clientY - rect.top - layout.offsetY) / layout.cellH);
    if (col < 0 || row < 0 || col >= viewer.gridW || row >= viewer.gridH) return null;
    return { col, row };
}

export function startZonePicking(id, btn, mode = 'rect') {
    // Cancel any drawing mode already active on another synth (or in
    // another mode on the same one)
    if (zoneState.pick && (zoneState.pick.id !== id || zoneState.pick.mode !== mode)) {
        cancelZonePicking();
    }
    zoneState.pick = { id, btn, mode };
    btn.classList.add('active');
    // The tolerance input only shows while the magic-wand mode is armed
    // on this card
    if (mode === 'wand') btn.closest('.synth-block')?.classList.add('wand-armed');
    pixelOverlay.classList.add('picking');
    syncAltPickingUi(); // reflect the Alt key if it is already held
    // Editing blind is confusing: arming the picking mode reveals this
    // synth's zones (they may be hidden during playback). The eye button
    // reflects it; the user can hide them again at any time.
    const hi = synthHighlights.get(id);
    if (hi && !hi.visible) {
        hi.visible = true;
        hi._wasVisible = true; // keep the zones visible after a stop too
        syncEyeButton(btn.closest('.synth-block'), true);
        redrawAllHighlights();
    }
}

export function cancelZonePicking() {
    if (!zoneState.pick) return;
    zoneState.pick.btn.classList.remove('active');
    zoneState.pick.btn.closest('.synth-block')?.classList.remove('wand-armed');
    pixelOverlay.classList.remove('picking');
    pixelOverlay.classList.remove('picking-silence');
    zoneState.pick = null;
    const hadDrag = !!zoneState.drag || !!zoneState.lasso;
    zoneState.drag = null;
    zoneState.lasso = null;
    if (hadDrag) redrawAllHighlights();
}

// Live preview of the rectangle being dragged: filled with the synth's
// color while it overlaps no zone, "erasing" the highlights beneath it
// as soon as it touches one — the drag then removes pixels instead. In
// silence mode (Alt) the preview is a black veil with a dashed outline:
// same positional semantics as the selection, but it never reads as a
// zone edit.
export function drawZonePreview() {
    if (!zoneState.drag) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const { start, cur } = zoneState.drag;
    const x = Math.min(start.col, cur.col);
    const y = Math.min(start.row, cur.row);
    const w = Math.abs(cur.col - start.col) + 1;
    const h = Math.abs(cur.row - start.row) + 1;
    const rect = { x, y, w, h };

    const ctx = pixelOverlay.getContext('2d');
    ctx.save();
    if (zoneState.drag.alt) {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = 'black';
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    } else if (rectOverlapsZones(zoneState.drag.id, rect)) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    } else {
        ctx.fillStyle = synthColors.get(zoneState.drag.id) || '#ffffff';
        ctx.globalAlpha = 0.4;
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    }
    ctx.restore();
}

// ---------- Lasso (free-hand zone selection) ----------

// Continuous image coordinates (in grid cells, fractional) of a mouse
// event, so the traced shape isn't quantized to cell corners.
export function imagePointFromClient(clientX, clientY) {
    const layout = getImageLayout();
    const rect = pixelOverlay.getBoundingClientRect();
    return {
        x: (clientX - rect.left - layout.offsetX) / layout.cellW,
        y: (clientY - rect.top - layout.offsetY) / layout.cellH,
    };
}

// Even-odd point-in-polygon test on the closed shape.
export function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if ((yi > py) !== (yj > py) &&
            px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

// Cells whose center the segment (x0,y0)→(x1,y1) passes through, added
// to `out` as "col,row" keys (Bresenham over cell centers' grid, so the
// traced boundary counts as enclosed).
export function addSegmentCells(x0, y0, x1, y1, out) {
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    x1 = Math.floor(x1); y1 = Math.floor(y1);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
        out.add(`${x0},${y0}`);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 <  dx) { err += dx; y0 += sy; }
    }
}

// Live preview of the lasso shape: the traced polygon, closed back to
// its start point, filled with the synth's color — black with a dashed
// white outline in silence mode (Alt).
export function drawLassoPreview() {
    if (!zoneState.lasso || zoneState.lasso.points.length < 1) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const ctx = pixelOverlay.getContext('2d');
    ctx.save();
    ctx.beginPath();
    zoneState.lasso.points.forEach((pt, i) => {
        const px = offsetX + pt.x * cellW;
        const py = offsetY + pt.y * cellH;
        if (i === 0) ctx.moveTo(px, py);
        else          ctx.lineTo(px, py);
    });
    ctx.closePath(); // straight line back to the start point
    if (zoneState.lasso.alt) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = 'black';
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
    } else {
        ctx.fillStyle = synthColors.get(zoneState.lasso.id) || '#ffffff';
        ctx.globalAlpha = 0.35;
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    ctx.restore();
}

// Computes every pixel enclosed by the lasso polygon: polygon interior
// (cell centers) ∪ boundary cells (Bresenham), including the closing line
// from the release point back to the start. Returned as "col,row" keys.
export function lassoEnclosedCells(points, start) {
    // Closed polygon in continuous coordinates; the closing segment is
    // the straight line back to the start cell's center.
    const poly = points.slice();
    poly.push({ x: start.col + 0.5, y: start.row + 0.5 });
    // Single point (simple click): degenerate polygon, nothing enclosed —
    // handled below by the boundary-only path.
    if (points.length === 1) {
        poly.push({ x: points[0].x, y: points[0].y + 0.01 });
    }

    // Bounding box (clamped to the grid): only cells inside can toggle
    const xs = poly.map(p => p.x);
    const ys = poly.map(p => p.y);
    const minCol = Math.max(0, Math.floor(Math.min(...xs)));
    const maxCol = Math.min(viewer.gridW - 1, Math.ceil(Math.max(...xs)));
    const minRow = Math.max(0, Math.floor(Math.min(...ys)));
    const maxRow = Math.min(viewer.gridH - 1, Math.ceil(Math.max(...ys)));

    // Enclosed cells = polygon interior (cell centers) ∪ boundary cells
    const enclosed = new Set();
    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            if (pointInPolygon(col + 0.5, row + 0.5, poly)) {
                enclosed.add(`${col},${row}`);
            }
        }
    }
    for (let i = 1; i < poly.length; i++) {
        addSegmentCells(poly[i - 1].x, poly[i - 1].y, poly[i].x, poly[i].y, enclosed);
    }
    return enclosed;
}

// Flood fill for the magic wand: every cell 4-connected to the clicked
// one whose color stays within `tolerance` of the clicked cell's color
// (edge adjacency like everywhere else — a corner touch is NOT
// contiguous). The color distance is the largest per-channel difference
// (Chebyshev) on the 0–255 scale, the tolerance input (1–255) being that
// difference directly. Returned as "col,row" keys.
export function wandFloodCells(startCell, tolerance) {
    const { rgba } = viewer.processedPixels;
    const seedIdx = (startCell.row * viewer.gridW + startCell.col) * 4;
    const sr = rgba[seedIdx], sg = rgba[seedIdx + 1], sb = rgba[seedIdx + 2];
    const limit = tolerance;
    const flooded = new Set([`${startCell.col},${startCell.row}`]);
    const queue = [startCell];
    while (queue.length > 0) {
        const { col, row } = queue.pop();
        for (const [nx, ny] of [[col + 1, row], [col - 1, row], [col, row + 1], [col, row - 1]]) {
            if (nx < 0 || ny < 0 || nx >= viewer.gridW || ny >= viewer.gridH) continue;
            const key = `${nx},${ny}`;
            if (flooded.has(key)) continue;
            const i = (ny * viewer.gridW + nx) * 4;
            if (Math.max(
                Math.abs(rgba[i] - sr),
                Math.abs(rgba[i + 1] - sg),
                Math.abs(rgba[i + 2] - sb),
            ) > limit) continue;
            flooded.add(key);
            queue.push({ col: nx, row: ny });
        }
    }
    return flooded;
}

// Lasso on the selection: every pixel enclosed by the traced polygon
// (boundary included, closure line from the release point back to the
// start) toggles — unselected becomes selected, selected becomes
// deselected. Pixels of the zone under the playhead (while the synth
// plays) are exempt from deselection. Returns true when the selection
// changed.
export function lassoTogglePixels(id, points, start) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const enclosed = lassoEnclosedCells(points, start);
    if (enclosed.size === 0) return false;

    // Current selection as a cell set
    const selected = cellSetFromZones(hi.zones);

    // Toggle each enclosed pixel (XOR)
    let changed = false;
    for (const key of enclosed) {
        const isSelected = selected.has(key);
        if (isSelected) {
            selected.delete(key);
        } else {
            selected.add(key);
        }
        changed = true;
    }
    if (!changed) return false;

    // Rebuild the selection as connected components with inherited
    // creation orders
    hi.zones = rebuildZones(hi.zones, selected);
    sendSynthZones(id);
    // Deselected pixels lose their silence
    clipMuteZonesToSelection(id);
    updateZonesLabel(id);
    return true;
}

// Lasso on the manual silences (Alt held): every enclosed selected pixel
// toggles — played becomes silent, silent becomes played. Pixels that
// are not selected are ignored (a silence always lives inside the
// selection). Returns true when the silences changed.
export function lassoToggleMutePixels(id, points, start) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const enclosed = lassoEnclosedCells(points, start);
    if (enclosed.size === 0) return false;

    const selected = cellSetFromZones(hi.zones);
    const muted = muteCellSet(hi);

    let changed = false;
    for (const key of enclosed) {
        if (!selected.has(key)) continue; // silences live in the selection
        if (muted.has(key)) {
            muted.delete(key);
            changed = true;
        } else {
            muted.add(key);
            changed = true;
        }
    }
    if (!changed) return false;

    hi.muteZones = rebuildZones(hi.muteZones, muted);
    sendSynthMuteZones(id);
    return true;
}

// Magic wand on the selection: positional semantics, like the rectangle.
// A click on an unselected pixel adds the whole flooded region (every
// pixel 4-connected to the clicked one whose color stays within the
// tolerance) — already-selected pixels are left untouched, and a flooded
// region touching an existing zone fuses with it. A click on a selected
// pixel removes the flooded pixels instead. Returns true when the
// selection changed.
export function wandTogglePixels(id, startCell, tolerance) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const flooded = wandFloodCells(startCell, tolerance);
    const seedKey = `${startCell.col},${startCell.row}`;

    // Current selection as a cell set
    const selected = cellSetFromZones(hi.zones);

    if (!selected.has(seedKey)) {
        // Free seed: pure addition — the union is rebuilt as connected
        // components, so a flooded region touching an existing zone
        // fuses with it (contiguity is one zone)
        for (const key of flooded) selected.add(key);
        hi.zones = rebuildZones(hi.zones, selected);
        sendSynthZones(id);
        updateZonesLabel(id);
        return true;
    }

    // Selected seed: remove every flooded pixel
    let changed = false;
    for (const key of flooded) {
        if (selected.delete(key)) changed = true;
    }
    if (!changed) return false;

    // Rebuild the selection as connected components with inherited
    // creation orders
    hi.zones = rebuildZones(hi.zones, selected);
    sendSynthZones(id);
    // Deselected pixels lose their silence
    clipMuteZonesToSelection(id);
    updateZonesLabel(id);
    return true;
}

// Magic wand on the manual silences (Alt held): positional semantics,
// like the Alt rectangle. A click on a played pixel silences every
// flooded pixel that belongs to the selection; a click on a silent
// pixel unsilences the flooded silent ones instead. Pixels that are
// not selected are ignored either way (a silence always lives inside
// the selection). Returns true when the silences changed.
export function wandToggleMutePixels(id, startCell, tolerance) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;

    const flooded = wandFloodCells(startCell, tolerance);
    const seedKey = `${startCell.col},${startCell.row}`;

    const selected = cellSetFromZones(hi.zones);
    const muted = muteCellSet(hi);

    let changed = false;
    if (!muted.has(seedKey)) {
        // Played seed: silence every flooded pixel of the selection
        for (const key of flooded) {
            if (!selected.has(key)) continue; // silences live in the selection
            if (muted.add(key)) changed = true;
        }
    } else {
        // Silent seed: unsilence every flooded silent pixel
        for (const key of flooded) {
            if (muted.delete(key)) changed = true;
        }
    }
    if (!changed) return false;

    hi.muteZones = rebuildZones(hi.muteZones, muted);
    sendSynthMuteZones(id);
    return true;
}
// Helpers used by main.js's shared listeners and by the synth cards.
export const isZoneMode = (id, mode) =>
    !!zoneState.pick && zoneState.pick.id === id && zoneState.pick.mode === mode;
export const isZonePickingId = (id) => !!zoneState.pick && zoneState.pick.id === id;
export function remapZonePickIds(oldId, newId) {
    if (zoneState.pick && zoneState.pick.id === oldId) zoneState.pick.id = newId;
    if (zoneState.drag && zoneState.drag.id === oldId) zoneState.drag.id = newId;
    if (zoneState.lasso && zoneState.lasso.id === oldId) zoneState.lasso.id = newId;
}

// Shared zone rendering for the main viewer and the projection mirror
// window. Pure drawing helpers only: no app state, no event handling —
// both windows own their own state and canvases, and feed them to these
// functions.

// Mute rest glyph, drawn on every muted pixel of a zone (rests outside
// the brightness window and manual silences alike). Rendered with the
// Noto Music font (self-hosted, loaded on demand via unicode-range).
export const MUTE_GLYPH = '𝆝';

// Computes the render rect of the image inside a viewer of the given
// dimensions (object-fit: contain), in grid cell units.
export function computeLayout(viewW, viewH, gridW, gridH) {
    if (!gridW || !gridH || !viewW || !viewH) return null;
    const imgRatio  = gridW / gridH;
    const viewRatio = viewW / viewH;
    let renderW, renderH;
    if (imgRatio > viewRatio) { renderW = viewW; renderH = viewW / imgRatio; }
    else                      { renderH = viewH; renderW = viewH * imgRatio; }
    return {
        renderW, renderH,
        offsetX: (viewW - renderW) / 2,
        offsetY: (viewH - renderH) / 2,
        cellW: renderW / gridW,
        cellH: renderH / gridH,
        gridW, gridH,
    };
}

// Builds the set of selected cells from zones (connected components
// stored as runs): "col,row" keys, one per covered cell.
export function cellSetFromZones(zones) {
    const cells = new Set();
    for (const z of zones) {
        for (const r of z.runs) {
            for (let col = r.x0; col <= r.x1; col++) {
                cells.add(`${col},${r.y}`);
            }
        }
    }
    return cells;
}

// Draws the single outline of a cell set: every cell edge that doesn't
// touch another selected cell is traced, producing one closed contour
// per connected component — the irregular shape of the lasso instead of
// the seams of the internal rectangles. Edge segments are merged into
// runs (horizontal and vertical) to keep the number of path operations
// low on large selections.
export function strokeCellOutline(ctx, cellSet, offsetX, offsetY, cellW, cellH) {
    ctx.beginPath();
    // Horizontal edges: between (col,row) and its top neighbor
    for (const key of cellSet) {
        const [col, row] = key.split(',').map(Number);
        const x = offsetX + col * cellW;
        const y = offsetY + row * cellH;
        if (!cellSet.has(`${col},${row - 1}`)) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + cellW, y);
        }
        if (!cellSet.has(`${col},${row + 1}`)) {
            ctx.moveTo(x, y + cellH);
            ctx.lineTo(x + cellW, y + cellH);
        }
        if (!cellSet.has(`${col - 1},${row}`)) {
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + cellH);
        }
        if (!cellSet.has(`${col + 1},${row}`)) {
            ctx.moveTo(x + cellW, y);
            ctx.lineTo(x + cellW, y + cellH);
        }
    }
    ctx.stroke();
}

// Draws one synth's zones onto a canvas: light fill of every zone rect
// (the image stays readable underneath), single outline of the union's
// contours, then the mute marks — a semi-transparent black veil (readable
// at any cell size) topped with the rest glyph in the synth's color when
// cells are large enough for it to read (below ~9px it would turn into a
// colored blur). muteCells accepts a Set or an array of "col,row" keys
// (the mirror window receives it as a plain array through the IPC).
export function drawZones(ctx, layout, { color, zones, muteCells }) {
    const { offsetX, offsetY, cellW, cellH } = layout;

    ctx.save();

    // Light fill of every zone run: the image stays readable underneath
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = color;
    for (const z of zones) {
        for (const r of z.runs) {
            ctx.fillRect(
                offsetX + r.x0 * cellW,
                offsetY + r.y * cellH,
                (r.x1 - r.x0 + 1) * cellW,
                cellH
            );
        }
    }

    // Single outline of the selection's union: one closed contour per
    // connected component, showing the actual shape (lasso included)
    // instead of the seams of the internal rectangles.
    const cells = cellSetFromZones(zones);
    if (cells.size > 0) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        strokeCellOutline(ctx, cells, offsetX, offsetY, cellW, cellH);
    }

    const muteList = muteCells ? Array.from(muteCells) : [];
    if (muteList.length > 0) {
        const canDrawGlyphs = cellH >= 9 && cellW >= 9;
        const fontSize = Math.min(cellW, cellH) * 0.9;
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = 'black';
        for (const key of muteList) {
            const [col, row] = key.split(',').map(Number);
            const x = offsetX + col * cellW;
            const y = offsetY + row * cellH;
            ctx.fillRect(x, y, cellW, cellH);
            if (canDrawGlyphs) {
                ctx.globalAlpha = 0.9;
                ctx.fillStyle = color;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = `${fontSize}px "Noto Music"`;
                ctx.fillText(MUTE_GLYPH, x + cellW / 2, y + cellH / 2);
                ctx.globalAlpha = 0.55;
                ctx.fillStyle = 'black';
            }
        }
    }

    ctx.restore();
}

// Draws one playhead cell: semi-transparent fill of the whole cell in
// the synth's color, like the main viewer's cursor layer. A muted cell
// (manual silence or pixel outside the brightness window) keeps its
// cursor, drawn at half opacity so it stays visible above the silence
// veil.
export function drawCursorCell(ctx, layout, { color, cursor, muted }) {
    const { offsetX, offsetY, cellW, cellH, gridW } = layout;
    const col = cursor % gridW;
    const row = Math.floor(cursor / gridW);
    ctx.save();
    ctx.globalAlpha = muted ? 0.375 : 0.75;
    ctx.fillStyle = color;
    ctx.fillRect(offsetX + col * cellW, offsetY + row * cellH, cellW, cellH);
    ctx.restore();
}

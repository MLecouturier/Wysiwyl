// Geometry: the exact zone model (run-length connected components)
// and the shared canvas rendering helpers.



// Exact zone model, frontend twin of the Rust `zone` module: a synth's
// selection is a list of disjoint connected components ("zones"),
// each stored as horizontal runs of cells ({y, x0, x1}, closed
// interval). Contiguous zones fuse (edge adjacency); a zone split by an
// erase keeps its creation order for every fragment. That order is the
// canonical "zone by zone" reading order, alongside the top-left
// corner as the tie-break.

// Monotonic creation-order counter; seeded from a loaded session or a
// backend grid change so new zones never collide with restored ones.
let orderCounter = 1;

export function nextZoneOrder() {
    return orderCounter++;
}

// Seeds the counter past every order already in use.
export function seedZoneOrder(zones) {
    let max = 0;
    for (const z of zones) {
        if (Number.isFinite(z?.order) && z.order > max) max = z.order;
    }
    orderCounter = max + 1;
}

// Builds a rect zone directly from its geometry (no cell enumeration:
// a select-all on a large grid must not materialize millions of keys).
export function rectZone(x, y, w, h, order = nextZoneOrder()) {
    const runs = [];
    for (let row = y; row < y + h; row++) {
        runs.push({ y: row, x0: x, x1: x + w - 1 });
    }
    return { order, runs };
}

// The cells of a zone list, as "col,row" keys.
export function zoneCellSet(zones) {
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

// True when the zone covers the cell (col, row).
export function zoneContains(zone, col, row) {
    return zone.runs.some(r => r.y === row && col >= r.x0 && col <= r.x1);
}

// True when any cell of the zone lies inside the rectangle.
export function zoneIntersectsRect(zone, rect) {
    return zone.runs.some(r =>
        r.y >= rect.y && r.y < rect.y + rect.h &&
        r.x0 < rect.x + rect.w && r.x1 >= rect.x
    );
}

// Exact pixel count of a zone list (runs never overlap within a
// component, and components are disjoint).
export function zonesPixelCount(zones) {
    let total = 0;
    for (const z of zones) {
        for (const r of z.runs) total += r.x1 - r.x0 + 1;
    }
    return total;
}

// Deep equality of two zone lists (order and runs, order-sensitive).
export function zonesEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((z, i) => {
        const o = b[i];
        return z.order === o.order &&
            z.runs.length === o.runs.length &&
            z.runs.every((r, j) =>
                r.y === o.runs[j].y && r.x0 === o.runs[j].x0 && r.x1 === o.runs[j].x1
            );
    });
}

// Groups a cell set into 4-connected components (edge adjacency; a
// corner touch is NOT contiguous). Returns an array of cell sets.
function connectedComponents(cells) {
    const components = [];
    const seen = new Set();
    for (const key of cells) {
        if (seen.has(key)) continue;
        // BFS over the component containing this cell
        const comp = new Set([key]);
        seen.add(key);
        const queue = [key];
        while (queue.length > 0) {
            const [cx, cy] = queue.pop().split(',').map(Number);
            for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
                const nkey = `${nx},${ny}`;
                if (cells.has(nkey) && !seen.has(nkey)) {
                    seen.add(nkey);
                    comp.add(nkey);
                    queue.push(nkey);
                }
            }
        }
        components.push(comp);
    }
    return components;
}

// Encodes one component (a cell set) as normalized runs.
function componentToRuns(comp) {
    const rows = new Map();
    for (const key of comp) {
        const [col, row] = key.split(',').map(Number);
        if (!rows.has(row)) rows.set(row, []);
        rows.get(row).push(col);
    }
    const runs = [];
    for (const row of [...rows.keys()].sort((a, b) => a - b)) {
        const cols = rows.get(row).sort((a, b) => a - b);
        let start = cols[0];
        let prev = cols[0];
        for (let i = 1; i <= cols.length; i++) {
            if (cols[i] !== prev + 1) {
                runs.push({ y: row, x0: start, x1: prev });
                start = cols[i];
            }
            prev = cols[i];
        }
    }
    return runs;
}

// Rebuilds a zone list from a cell set, preserving the creation orders:
// each new component inherits the smallest order among the old zones
// it shares cells with (fusions keep the eldest order, fragments of a
// split zone keep their parent's), and genuinely new components take
// fresh orders. The result is sorted canonically (order, top-left).
export function rebuildZones(oldZones, cells) {
    if (cells.size === 0) return [];
    const oldCellsPerZone = oldZones.map(z => ({ order: z.order, cells: zoneCellSet([z]) }));
    const zones = [];
    for (const comp of connectedComponents(cells)) {
        let order = null;
        for (const old of oldCellsPerZone) {
            if (order !== null && old.order >= order) continue;
            for (const key of comp) {
                if (old.cells.has(key)) {
                    order = old.order;
                    break;
                }
            }
        }
        if (order === null) order = nextZoneOrder();
        zones.push({ order, runs: componentToRuns(comp) });
    }
    zones.sort((a, b) => {
        const ta = a.runs[0], tb = b.runs[0];
        return a.order - b.order || ta.y - tb.y || ta.x0 - tb.x0;
    });
    return zones;
}

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

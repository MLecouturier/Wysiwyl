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

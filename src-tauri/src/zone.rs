//! Exact zone model: run-length-encoded rows grouped into connected
//! components.
//!
//! A [`Zone`] is one connected component of grid cells (4-connectivity:
//! cells touching along an edge are contiguous, corner-touching cells
//! are not). Its shape is stored as horizontal runs of cells, one
//! [`RowRun`] per maximal stretch of selected cells on a row. This
//! replaces the historical model where a selection was a list of
//! overlapping rectangles — the exact representation keeps a lasso's
//! shape, never over-covers (a rectangle fusion could include cells
//! that were never selected), and gives exact pixel counts.
//!
//! Zones carry a creation `order` so the reading "zone by zone"
//! (unsorted, per-component) is deterministic: fusions keep the eldest
//! order, and an erase that splits a zone keeps the parent's order for
//! every fragment (fragments are then told apart by their top-left
//! corner).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A maximal horizontal run of selected cells on row `y`: columns
/// `x0..=x1` (closed interval, `x1 >= x0`).
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
pub struct RowRun {
    pub y: u32,
    pub x0: u32,
    pub x1: u32,
}

/// One connected component of cells, encoded as normalized runs:
/// strictly ascending `y`, and within a row the selected cells are
/// merged into one run (two runs of the same zone never share a row).
/// `order` is the creation rank used as the canonical reading order.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Debug)]
pub struct Zone {
    pub order: u64,
    pub runs: Vec<RowRun>,
}

impl Zone {
    /// A zone covering the rectangle `x..x+w`, `y..y+h`.
    pub fn from_rect(order: u64, x: u32, y: u32, w: u32, h: u32) -> Zone {
        Zone {
            order,
            runs: (y..y + h)
                .map(|row| RowRun { y: row, x0: x, x1: x + w - 1 })
                .collect(),
        }
    }

    /// A zone from a raw set of cells: runs are rebuilt per row, in
    /// no particular input order. An empty set yields an empty zone
    /// (no runs).
    pub fn from_cells(order: u64, cells: &[(u32, u32)]) -> Zone {
        let mut by_row: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for &(x, y) in cells {
            by_row.entry(y).or_default().push(x);
        }
        let mut runs = Vec::new();
        for (y, mut xs) in by_row {
            xs.sort_unstable();
            let mut run_start = xs[0];
            let mut prev = xs[0];
            for &x in &xs[1..] {
                if x > prev + 1 {
                    runs.push(RowRun { y, x0: run_start, x1: prev });
                    run_start = x;
                }
                prev = x;
            }
            runs.push(RowRun { y, x0: run_start, x1: prev });
        }
        Zone { order, runs }
    }

    /// True when the cell (x, y) belongs to the zone.
    pub fn contains(&self, x: u32, y: u32) -> bool {
        // Runs are sorted by y: binary search the row
        match self.runs.binary_search_by(|r| r.y.cmp(&y)) {
            Ok(i) => {
                let r = self.runs[i];
                x >= r.x0 && x <= r.x1
            }
            Err(_) => false,
        }
    }

    /// Exact number of cells covered (runs never overlap, so a plain
    /// sum of lengths is exact — unlike the historical rectangle
    /// model where overlapping zones double-counted).
    pub fn pixel_count(&self) -> u64 {
        self.runs.iter().map(|r| (r.x1 - r.x0 + 1) as u64).sum()
    }

    /// Top-left cell of the zone's bounding box (the canonical tie-break
    /// between fragments of the same creation order).
    pub fn top_left(&self) -> Option<(u32, u32)> {
        self.runs.first().map(|r| (r.x0, r.y))
    }

    /// The zone's bounding box, as (x, y, w, h); None when empty.
    pub fn bounding_box(&self) -> Option<(u32, u32, u32, u32)> {
        let first = self.runs.first()?;
        let y0 = first.y;
        let y1 = self.runs.last()?.y;
        let x0 = self.runs.iter().map(|r| r.x0).min()?;
        let x1 = self.runs.iter().map(|r| r.x1).max()?;
        Some((x0, y0, x1 - x0 + 1, y1 - y0 + 1))
    }
}

/// Merges the cell sets of several zones into one raw run map (row →
/// sorted disjoint intervals). Order-preserving helper for the set
/// operations below; the output carries no zone order yet.
fn merge_runs(zones: &[&Zone]) -> BTreeMap<u32, Vec<(u32, u32)>> {
    let mut by_row: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    for zone in zones {
        for r in &zone.runs {
            by_row.entry(r.y).or_default().push((r.x0, r.x1));
        }
    }
    for intervals in by_row.values_mut() {
        intervals.sort_unstable();
        let mut merged: Vec<(u32, u32)> = Vec::with_capacity(intervals.len());
        for &(x0, x1) in intervals.iter() {
            match merged.last_mut() {
                // Adjacent or overlapping intervals fuse (a gap of zero
                // columns still makes one run)
                Some((_, end)) if x0 <= *end + 1 => {
                    if x1 > *end {
                        *end = x1;
                    }
                }
                _ => merged.push((x0, x1)),
            }
        }
        *intervals = merged;
    }
    by_row
}

/// Splits every zone into raw runs and rebuilds the geometry from
/// scratch (used by the difference below). Not order-preserving.
fn zone_runs(zone: &Zone) -> BTreeMap<u32, Vec<(u32, u32)>> {
    merge_runs(&[zone])
}

/// Difference: the cells of `zone` that are not covered by `mask`.
/// Returns the raw surviving runs (row → disjoint intervals), NOT yet
/// split into connected components.
fn difference_runs(zone: &Zone, mask: &Zone) -> BTreeMap<u32, Vec<(u32, u32)>> {
    let mut out = BTreeMap::new();
    for r in &zone.runs {
        let mut segments = vec![(r.x0, r.x1)];
        // Subtract every masking run of the same row (runs are sorted
        // by y and unique per row in a normalized zone, so a linear
        // scan over the mask's runs of this row is fine)
        for m in &mask.runs {
            if m.y != r.y {
                continue;
            }
            let mut next = Vec::with_capacity(segments.len());
            for (x0, x1) in segments {
                if m.x1 < x0 || m.x0 > x1 {
                    next.push((x0, x1)); // no overlap
                    continue;
                }
                if m.x0 > x0 {
                    next.push((x0, m.x0 - 1));
                }
                if m.x1 < x1 {
                    next.push((m.x1 + 1, x1));
                }
            }
            segments = next;
        }
        if !segments.is_empty() {
            out.insert(r.y, segments);
        }
    }
    out
}

/// Intersection: the cells covered by both `a` and `b`. Returns raw
/// runs (row → disjoint intervals).
fn intersection_runs(a: &Zone, b: &Zone) -> BTreeMap<u32, Vec<(u32, u32)>> {
    let mut out: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    // Walk both zones' runs in step (each is sorted by y, one run per
    // row at most per zone)
    let mut ai = 0;
    let mut bi = 0;
    while ai < a.runs.len() && bi < b.runs.len() {
        let ra = a.runs[ai];
        let rb = b.runs[bi];
        match ra.y.cmp(&rb.y) {
            std::cmp::Ordering::Less => ai += 1,
            std::cmp::Ordering::Greater => bi += 1,
            std::cmp::Ordering::Equal => {
                let lo = ra.x0.max(rb.x0);
                let hi = ra.x1.min(rb.x1);
                if lo <= hi {
                    out.entry(ra.y).or_default().push((lo, hi));
                }
                ai += 1;
                bi += 1;
            }
        }
    }
    out
}

/// Rebuilds connected components from raw runs (row → disjoint
/// intervals). Connectivity is 4-adjacency: two runs on consecutive
/// rows belong to the same component when their column intervals
/// overlap (a single shared column is enough; a corner touch —
/// intervals merely adjacent in X — is NOT contiguous).
///
/// `order` is assigned to every component (fusions and splits both
/// reuse the parent's order; the canonical tie-break between
/// same-order components is the top-left corner, applied by the
/// caller's sort or by `sorted_components`).
pub fn components(order: u64, runs: &BTreeMap<u32, Vec<(u32, u32)>>) -> Vec<Zone> {
    // Union-find over the flattened runs
    let flat: Vec<(u32, u32, u32)> = runs
        .iter()
        .flat_map(|(&y, ivs)| ivs.iter().map(move |&(x0, x1)| (y, x0, x1)))
        .collect();
    let mut parent: Vec<usize> = (0..flat.len()).collect();

    fn find(parent: &mut [usize], i: usize) -> usize {
        let mut root = i;
        while parent[root] != root {
            root = parent[root];
        }
        // Path compression
        let mut cur = i;
        while parent[cur] != root {
            let next = parent[cur];
            parent[cur] = root;
            cur = next;
        }
        root
    }

    // Union runs of consecutive rows whose intervals overlap. Runs on
    // the same row never overlap (disjoint by construction). The rows
    // are processed in ascending y thanks to BTreeMap ordering.
    let row_starts: Vec<(u32, usize, usize)> = {
        let mut starts = Vec::new();
        let mut offset = 0;
        for (&y, ivs) in runs {
            starts.push((y, offset, offset + ivs.len()));
            offset += ivs.len();
        }
        starts
    };
    for w in row_starts.windows(2) {
        let (y0, s0, e0) = w[0];
        let (y1, s1, e1) = w[1];
        if y1 != y0 + 1 {
            continue; // rows further apart cannot touch
        }
        let mut i = s0;
        let mut j = s1;
        while i < e0 && j < e1 {
            let a = flat[i];
            let b = flat[j];
            // 4-adjacency: intervals must share at least one column
            if a.1 <= b.2 && b.1 <= a.2 {
                let ra = find(&mut parent, i);
                let rb = find(&mut parent, j);
                if ra != rb {
                    parent[ra.max(rb)] = ra.min(rb);
                }
            }
            // Advance the run that ends first
            if a.2 < b.2 {
                i += 1;
            } else {
                j += 1;
            }
        }
    }

    // Gather the runs per root, keeping the component's creation order
    let mut groups: BTreeMap<usize, Vec<RowRun>> = BTreeMap::new();
    for (idx, &(y, x0, x1)) in flat.iter().enumerate() {
        let root = find(&mut parent, idx);
        groups.entry(root).or_default().push(RowRun { y, x0, x1 });
    }
    groups
        .into_values()
        .map(|mut runs| {
            runs.sort_by_key(|r| (r.y, r.x0));
            Zone { order, runs }
        })
        .collect()
}

/// Same as [`components`], with the result sorted canonically:
/// ascending creation order, then top-left corner.
pub fn sorted_components(order: u64, runs: &BTreeMap<u32, Vec<(u32, u32)>>) -> Vec<Zone> {
    let mut zones = components(order, runs);
    zones.sort_by_key(|z| (z.order, z.top_left()));
    zones
}

/// Splits a zone into its connected components (an erase can cut a
/// zone in several pieces). Every fragment inherits the parent's
/// creation order.
pub fn split_components(zone: &Zone) -> Vec<Zone> {
    sorted_components(zone.order, &zone_runs(zone))
}

/// Union of several zones, recomposed into connected components: two
/// zones that touch (edge adjacency, or overlap) yield one component
/// — the contiguity-is-one-zone semantics. The fused components keep
/// the eldest of the merged zones' creation orders.
pub fn union_zones(zones: &[Zone]) -> Vec<Zone> {
    if zones.is_empty() {
        return Vec::new();
    }
    let refs: Vec<&Zone> = zones.iter().collect();
    let runs = merge_runs(&refs);
    let merged = components(zones.iter().map(|z| z.order).min().unwrap(), &runs);
    // Fragments that did not fuse keep their own (elder) order: the
    // blanket order above is only correct for the fused ones. Recompose
    // honestly: assign each output component the eldest order among
    // the input zones that intersect it.
    let mut out = Vec::with_capacity(merged.len());
    for comp in merged {
        let order = zones
            .iter()
            .filter(|z| !intersection_runs(z, &comp).is_empty())
            .map(|z| z.order)
            .min()
            .unwrap_or(comp.order);
        out.push(Zone { order, ..comp });
    }
    out.sort_by_key(|z| (z.order, z.top_left()));
    out
}

/// Difference of a zone by a mask zone, recomposed into connected
/// components inheriting the parent's order: the exact replacement of
/// the historical band-cutting rectangle subtraction.
pub fn subtract_zones(zone: &Zone, mask: &Zone) -> Vec<Zone> {
    sorted_components(zone.order, &difference_runs(zone, mask))
}

/// Intersection of two zones as a single raw-run map (used to clip the
/// manual silences to the selection exactly).
pub fn intersect_zones(zone: &Zone, other: &Zone) -> BTreeMap<u32, Vec<(u32, u32)>> {
    intersection_runs(zone, other)
}

/// Merges several raw run maps into one normalized map (intervals
/// sorted and fused per row). Used to combine partial intersections.
pub fn merge_run_maps(
    maps: Vec<BTreeMap<u32, Vec<(u32, u32)>>>,
) -> BTreeMap<u32, Vec<(u32, u32)>> {
    let mut out: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    for map in maps {
        for (y, intervals) in map {
            out.entry(y).or_default().extend(intervals);
        }
    }
    normalize_runs(&mut out);
    out
}

/// Intersection of a zone with a whole selection (several disjoint
/// zones): the raw normalized runs of the cells the zone shares with
/// the selection. Used to keep the manual silences inside the selected
/// pixels exactly.
pub fn intersect_zone_selection(zone: &Zone, selection: &[Zone]) -> BTreeMap<u32, Vec<(u32, u32)>> {
    let maps = selection
        .iter()
        .map(|sel| intersection_runs(zone, sel))
        .collect();
    merge_run_maps(maps)
}

/// Builds zones from a raw run map with an explicit order (wire format
/// entry point: the frontend sends normalized runs).
pub fn zone_from_runs(order: u64, runs: Vec<RowRun>) -> Zone {
    let mut runs = runs;
    runs.sort_by_key(|r| (r.y, r.x0));
    Zone { order, runs }
}

/// Total exact pixel count of a zone list.
pub fn total_pixel_count(zones: &[Zone]) -> u64 {
    zones.iter().map(|z| z.pixel_count()).sum()
}

/// Repositions a zone onto a resized grid, run by run: each run keeps
/// its length in cells while its row and start column keep their
/// relative position in the image (`y' = round(y * new_h / old_h)`,
/// `x0' = round(x0 * new_w / old_w)`). A run longer than the new grid
/// is capped to the grid width; a run that would stick out slides
/// against the edge instead of being amputated. Runs fully outside
/// the new grid disappear. Runs landing on the same row after the
/// vertical compression fuse, then the result is recomposed into
/// connected components (fragments inherit the parent's order).
///
/// On the vertical axis the shape compresses: several source rows can
/// land on one target row, so a complex shape gets vertically packed —
/// this is the fixed-run-length policy, chosen for consistency with
/// the historical per-rectangle behavior on plain rectangles.
/// Normalizes a raw run map: sorts each row's intervals and merges the
/// overlapping or adjacent ones, so downstream consumers (components,
/// serialization) never see two runs of the same row that could fuse.
fn normalize_runs(runs: &mut BTreeMap<u32, Vec<(u32, u32)>>) {
    for intervals in runs.values_mut() {
        if intervals.len() < 2 {
            continue;
        }
        intervals.sort_unstable();
        let mut merged: Vec<(u32, u32)> = Vec::with_capacity(intervals.len());
        for &(x0, x1) in intervals.iter() {
            match merged.last_mut() {
                Some((_, end)) if x0 <= *end + 1 => {
                    if x1 > *end {
                        *end = x1;
                    }
                }
                _ => merged.push((x0, x1)),
            }
        }
        *intervals = merged;
    }
}

pub fn remap_zone_fixed_runs(
    zone: &Zone,
    old_w: u32,
    old_h: u32,
    new_w: u32,
    new_h: u32,
) -> Vec<Zone> {
    let scale = |v: u32, from: u32, to: u32| -> u32 {
        if from == 0 || to == 0 {
            return 0;
        }
        ((v as f64) * (to as f64) / (from as f64)).round() as u32
    };

    let mut out: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    for r in &zone.runs {
        let len = (r.x1 - r.x0 + 1).min(new_w);
        let x0 = scale(r.x0, old_w, new_w).min(new_w.saturating_sub(len));
        let y = scale(r.y, old_h, new_h);
        if y >= new_h {
            continue; // row outside the new grid
        }
        out.entry(y).or_default().push((x0, x0 + len - 1));
    }
    // Sort and merge each row's intervals so `components` sees
    // normalized input — several source rows landing on the same
    // target row produce overlapping runs that must fuse first
    normalize_runs(&mut out);
    sorted_components(zone.order, &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(order: u64, x: u32, y: u32, w: u32, h: u32) -> Zone {
        Zone::from_rect(order, x, y, w, h)
    }

    fn runs_of(zone: &Zone) -> Vec<(u32, u32, u32)> {
        zone.runs.iter().map(|r| (r.y, r.x0, r.x1)).collect()
    }

    // --- Constructors ---

    #[test]
    fn from_rect_builds_one_run_per_row() {
        let z = rect(0, 2, 1, 3, 2);
        assert_eq!(runs_of(&z), vec![(1, 2, 4), (2, 2, 4)]);
        assert_eq!(z.pixel_count(), 6);
    }

    #[test]
    fn from_cells_merges_and_sorts() {
        // Cells given in arbitrary order, with a gap on one row
        let cells = vec![(5, 1), (3, 1), (4, 1), (9, 1), (0, 0)];
        let z = Zone::from_cells(0, &cells);
        // Row 1: 3,4,5 fuse into one run; 9 stays apart; row 0: single
        assert_eq!(runs_of(&z), vec![(0, 0, 0), (1, 3, 5), (1, 9, 9)]);
        assert_eq!(z.pixel_count(), 5);
    }

    #[test]
    fn from_cells_empty_yields_empty_zone() {
        let z = Zone::from_cells(0, &[]);
        assert!(z.runs.is_empty());
        assert_eq!(z.pixel_count(), 0);
        assert!(z.top_left().is_none());
    }

    // --- Containment ---

    #[test]
    fn contains_checks_row_then_interval() {
        let z = rect(0, 2, 1, 3, 2); // rows 1-2, cols 2-4
        assert!(z.contains(2, 1));
        assert!(z.contains(4, 2));
        assert!(!z.contains(5, 1)); // right of the run
        assert!(!z.contains(1, 1)); // left of the run
        assert!(!z.contains(2, 0)); // above
        assert!(!z.contains(2, 3)); // below
    }

    // --- Union / fusions ---

    #[test]
    fn union_fuses_edge_adjacent_zones_into_one() {
        // Two rectangles side by side, sharing an edge: one zone
        let merged = union_zones(&[rect(1, 0, 0, 2, 2), rect(2, 2, 0, 2, 2)]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].order, 1); // eldest order wins
        assert_eq!(merged[0].pixel_count(), 8); // exact: no double count
        assert_eq!(runs_of(&merged[0]), vec![(0, 0, 3), (1, 0, 3)]);
    }

    #[test]
    fn union_fuses_overlapping_zones_exactly() {
        // Overlapping L-shapes: the union is exact, not a bounding box
        let a = rect(1, 0, 0, 4, 1); // row 0, cols 0-3
        let b = rect(2, 3, 0, 1, 4); // col 3, rows 0-3
        let merged = union_zones(&[a, b]);
        assert_eq!(merged.len(), 1);
        // A bounding-box fusion would cover 16 cells; the exact union:
        assert_eq!(merged[0].pixel_count(), 7);
    }

    #[test]
    fn union_keeps_disjoint_zones_apart() {
        let merged = union_zones(&[rect(1, 0, 0, 2, 2), rect(2, 10, 10, 2, 2)]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].order, 1);
        assert_eq!(merged[1].order, 2);
    }

    #[test]
    fn corner_touch_is_not_contiguity() {
        // Diagonal cells do NOT merge (4-connectivity)
        let a = rect(1, 0, 0, 1, 1);
        let b = rect(2, 1, 1, 1, 1);
        let merged = union_zones(&[a, b]);
        assert_eq!(merged.len(), 2, "corner touch must stay two zones");
    }

    // --- Difference ---

    #[test]
    fn subtract_splits_a_zone_in_two() {
        // A 5x1 band, erased in its middle: two fragments, same order
        let z = rect(3, 0, 0, 5, 1);
        let mask = rect(0, 2, 0, 1, 1);
        let fragments = subtract_zones(&z, &mask);
        assert_eq!(fragments.len(), 2);
        assert!(fragments.iter().all(|f| f.order == 3));
        assert_eq!(runs_of(&fragments[0]), vec![(0, 0, 1)]);
        assert_eq!(runs_of(&fragments[1]), vec![(0, 3, 4)]);
    }

    #[test]
    fn subtract_band_cutting_is_exact_on_rectangles() {
        // Erasing a sub-rectangle of a bigger one leaves an exact ring
        let z = rect(1, 0, 0, 5, 5);
        let mask = rect(0, 1, 1, 3, 3);
        let fragments = subtract_zones(&z, &mask);
        assert_eq!(fragments.len(), 1); // the ring is connected
        assert_eq!(fragments[0].pixel_count(), 25 - 9);
    }

    #[test]
    fn subtract_full_mask_empties_the_zone() {
        let z = rect(1, 0, 0, 3, 3);
        let fragments = subtract_zones(&z, &rect(0, 0, 0, 3, 3));
        assert!(fragments.is_empty());
    }

    // --- Intersection ---

    #[test]
    fn intersect_is_exact_pairwise() {
        let a = rect(1, 0, 0, 4, 4);
        let b = rect(2, 2, 2, 4, 4);
        let runs = intersect_zones(&a, &b);
        assert_eq!(
            runs,
            BTreeMap::from([(2, vec![(2, 3)]), (3, vec![(2, 3)])])
        );
    }

    #[test]
    fn intersect_disjoint_is_empty() {
        let runs = intersect_zones(&rect(1, 0, 0, 2, 2), &rect(2, 5, 5, 2, 2));
        assert!(runs.is_empty());
    }

    // --- Components ---

    #[test]
    fn components_group_4_adjacent_rows() {
        // A plus-shaped cell set: center (1,1), arms touch by edges
        let cells = vec![(1, 0), (0, 1), (1, 1), (2, 1), (1, 2)];
        let z = Zone::from_cells(0, &cells);
        // from_cells keeps raw runs; split_components must find 1 group
        let split = split_components(&z);
        assert_eq!(split.len(), 1);
        assert_eq!(split[0].pixel_count(), 5);
    }

    #[test]
    fn sorted_components_break_ties_by_top_left() {
        let runs = BTreeMap::from([
            (0, vec![(5, 6)]),
            (1, vec![(5, 6)]),
        ]);
        let zones = sorted_components(7, &runs);
        assert_eq!(zones.len(), 1);
        assert_eq!(zones[0].order, 7);
        assert_eq!(zones[0].top_left(), Some((5, 0)));
    }

    // --- Bounding box / top-left ---

    #[test]
    fn bounding_box_covers_the_shape() {
        let z = Zone::from_cells(0, &[(5, 0), (0, 2), (5, 2)]);
        assert_eq!(z.bounding_box(), Some((0, 0, 6, 3)));
        // Top-left = the first run's start: the highest row, leftmost
        // cell ON that row (there is no cell at (0, 0) in this shape)
        assert_eq!(z.top_left(), Some((5, 0)));
    }

    // --- Fixed-run remap ---

    #[test]
    fn remap_keeps_relative_position_and_run_length() {
        // The historical rectangle behavior: proportional corner, fixed
        // run length. Vertical scale 25/50 = 0.5: rows 20-24 land on
        // 10-12 (round of the half-step arithmetic)
        let z = rect(0, 40, 20, 10, 5);
        let out = remap_zone_fixed_runs(&z, 100, 50, 50, 25);
        assert_eq!(out.len(), 1);
        assert_eq!(runs_of(&out[0]), vec![(10, 20, 29), (11, 20, 29), (12, 20, 29)]);
        assert_eq!(out[0].pixel_count(), 30);
    }

    #[test]
    fn remap_is_identity_on_same_grid() {
        let z = rect(0, 7, 13, 4, 9);
        let out = remap_zone_fixed_runs(&z, 64, 32, 64, 32);
        assert_eq!(out.len(), 1);
        assert_eq!(runs_of(&out[0]), runs_of(&z));
    }

    #[test]
    fn remap_clamps_runs_sticking_out() {
        // Run at the right edge of a shrinking grid slides against it
        let z = rect(0, 90, 0, 10, 1); // cols 90-99 on a 100-wide grid
        let out = remap_zone_fixed_runs(&z, 100, 10, 50, 5);
        assert_eq!(out.len(), 1);
        assert_eq!(runs_of(&out[0]), vec![(0, 40, 49)]); // x0'=45 → clamped to 50-10
    }

    #[test]
    fn remap_caps_run_wider_than_the_grid() {
        let z = rect(0, 10, 10, 40, 1);
        let out = remap_zone_fixed_runs(&z, 100, 100, 20, 20);
        assert_eq!(out.len(), 1);
        assert_eq!(runs_of(&out[0]), vec![(2, 0, 19)]); // capped to 20, slid to 0
    }

    #[test]
    fn remap_vertical_landing_math() {
        // Dedicated check of the vertical compression: rows 0..4 of a
        // 50-row grid land on rows 0..0 (scale 5/50 = 0.1: rounds to 0)
        let z = rect(0, 0, 0, 3, 5); // rows 0-4
        let out = remap_zone_fixed_runs(&z, 10, 50, 10, 5);
        assert_eq!(out.len(), 1);
        // All five source rows round to target row 0: the runs pile up
        assert_eq!(runs_of(&out[0]), vec![(0, 0, 2)]);
    }

    #[test]
    fn remap_preserves_the_order_across_fragments() {
        let z = rect(42, 0, 0, 5, 1);
        let out = remap_zone_fixed_runs(&z, 10, 2, 10, 1);
        assert!(out.iter().all(|f| f.order == 42));
    }

    #[test]
    fn remap_drops_runs_outside_the_grid() {
        // A run whose row lands beyond the new height disappears
        let z = rect(0, 0, 9, 3, 1);
        let out = remap_zone_fixed_runs(&z, 10, 10, 10, 3); // y'=round(9*3/10)=3 → outside
        assert!(out.is_empty());
    }

    // --- Totals ---

    #[test]
    fn total_pixel_count_sums_exactly() {
        let zones = [rect(0, 0, 0, 3, 3), rect(1, 10, 10, 2, 2)];
        assert_eq!(total_pixel_count(&zones), 13);
    }
}

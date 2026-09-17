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

/// One connected component of cells, encoded as runs sorted by
/// `(y, x0)`; the runs of a row are disjoint (a lasso shape can carry
/// several of them — the gaps of a U-shape's bottom row, for instance).
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
        // Runs are sorted by (y, x0) and a row may carry SEVERAL runs
        // (a U-shaped lasso has disjoint segments on its bottom row):
        // skip to the row's first run, then scan the row's runs
        let start = self.runs.partition_point(|r| r.y < y);
        self.runs[start..]
            .iter()
            .take_while(|r| r.y == y)
            .any(|r| x >= r.x0 && x <= r.x1)
    }

    /// Exact number of cells covered (runs never overlap, so a plain
    /// sum of lengths is exact — unlike the historical rectangle
    /// model where overlapping zones double-counted).
    pub fn pixel_count(&self) -> u64 {
        self.runs.iter().map(|r| (r.x1 - r.x0 + 1) as u64).sum()
    }

    /// Top-left cell of the bounding box as (row, column) — the
    /// canonical tie-break between fragments of the same creation
    /// order, row first like the reading order (the frontend's zone
    /// sort uses the same convention).
    pub fn top_left(&self) -> Option<(u32, u32)> {
        self.runs.first().map(|r| (r.y, r.x0))
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

    #[test]
    fn contains_scans_every_run_of_a_row() {
        // A U-shaped component: the bottom row carries TWO disjoint runs
        // (cols 0-1 and cols 4-5, joined through the rows above). The
        // historical binary-search-on-y containment stopped at the
        // first matching run and missed the second one.
        let cells = [
            (0, 0), (1, 0),
            (0, 1), (1, 1), (4, 1), (5, 1),
            (0, 2), (1, 2), (2, 2), (3, 2), (4, 2), (5, 2),
        ];
        let u = Zone::from_cells(0, &cells);
        // Both arms of the U on the middle row must be found
        assert!(u.contains(0, 1));
        assert!(u.contains(1, 1));
        assert!(u.contains(4, 1));
        assert!(u.contains(5, 1));
        // The gap between them must not
        assert!(!u.contains(2, 1));
        assert!(!u.contains(3, 1));
        // And the bridge below still works
        assert!(u.contains(2, 2));
        assert!(!u.contains(2, 0));
    }

    #[test]
    fn bounding_box_covers_the_shape() {
        let z = Zone::from_cells(0, &[(5, 0), (0, 2), (5, 2)]);
        assert_eq!(z.bounding_box(), Some((0, 0, 6, 3)));
        // Top-left as (row, column): the highest row, leftmost cell ON
        // that row (there is no cell at (0, 0) in this shape)
        assert_eq!(z.top_left(), Some((0, 5)));
    }
}

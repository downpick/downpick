import { stringifyCellValue } from './resultExport';
import type { QueryResult } from './store';

/**
 * Column widths for the results grid, measured once per result.
 *
 * The grid virtualizes its rows, so only a window of them is ever in the DOM. Under the
 * browser's automatic table layout that makes column widths a function of whatever rows
 * happen to be mounted — they shift on every scroll. The grid therefore uses
 * `table-layout: fixed` and needs a width per column up front; that is what this computes,
 * from the header plus a sample of the rows, using a canvas to measure text.
 */

// Matches what the grid actually paints: cells are `text-xs` (12px), headers are
// `text-xs font-semibold`, the type line under a header name is 10px. Family comes from
// the `html, body, #root` rule in index.css.
const FONT_FAMILY = "'Inter', system-ui, -apple-system, sans-serif";
const CELL_FONT = `400 12px ${FONT_FAMILY}`;
const HEADER_FONT = `600 12px ${FONT_FAMILY}`;
const TYPE_FONT = `400 10px ${FONT_FAMILY}`;

// `px-2` on both sides, plus a couple of px so text doesn't sit flush against the border.
const PADDING = 20;
const MIN_WIDTH = 64;
const MAX_WIDTH = 400;

// Rows are sampled rather than scanned: a result can hold tens of thousands of them, and
// the first screenfuls are what the initial widths need to look right for.
const SAMPLE_ROWS = 100;
// Long values saturate MAX_WIDTH well before this; measuring the whole string is wasted work.
const MAX_MEASURED_CHARS = 200;

let ctx: CanvasRenderingContext2D | null = null;

function getContext(): CanvasRenderingContext2D | null {
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d');
  }
  return ctx;
}

function measure(c: CanvasRenderingContext2D, text: string, font: string): number {
  c.font = font;
  return c.measureText(text.slice(0, MAX_MEASURED_CHARS)).width;
}

/** One width in px per column of `result`, in column order. */
export function measureColumnWidths(result: QueryResult): number[] {
  const c = getContext();
  // No canvas (jsdom, exotic environments): fall back to a uniform width rather than
  // leaving the columns unsized, which would put automatic layout back in charge.
  if (!c) return result.columns.map(() => 160);

  const sampled = result.rows.slice(0, SAMPLE_ROWS);

  return result.columns.map((col, i) => {
    let width = measure(c, col, HEADER_FONT);

    const type = result.columnTypes?.[i];
    if (type) {
      width = Math.max(width, measure(c, type, TYPE_FONT));
    }

    for (const row of sampled) {
      const val = row[i];
      // Mirrors the cell renderer in ResultsGrid: nullish shows as NULL, line breaks
      // collapse to a single ↵ glyph.
      const text =
        val === null || val === undefined
          ? 'NULL'
          : stringifyCellValue(val).replace(/\r\n|\r|\n/g, '↵');
      width = Math.max(width, measure(c, text, CELL_FONT));
    }

    return Math.min(Math.max(Math.ceil(width) + PADDING, MIN_WIDTH), MAX_WIDTH);
  });
}

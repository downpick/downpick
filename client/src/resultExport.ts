import * as XLSX from 'xlsx';
import { copyToClipboard, saveFile } from './api';
import type { QueryResult } from './store';

/**
 * Turning a result set into something outside the app: the clipboard, a CSV, a workbook.
 *
 * Lives apart from ResultsGrid because the controls that trigger it sit in the status bar
 * while the grid still needs `stringifyCellValue` to render cells — one definition of how
 * a value becomes text, shared by what is shown and what is exported.
 */

// JSONB/json columns arrive as parsed JS objects/arrays (pg driver default).
// String(val) on those yields "[object Object]"; JSON.stringify shows the actual value.
export function stringifyCellValue(val: unknown): string {
  if (typeof val === 'object' && val !== null) {
    return JSON.stringify(val);
  }
  return String(val);
}

function cellText(row: unknown[], i: number): string {
  const val = row[i];
  return val === null || val === undefined ? '' : stringifyCellValue(val);
}

// Exports go through the main process: it owns the save dialog and the write. The old
// synthetic `<a download>` click depended on a browser download manager the app no longer
// has, and would silently do nothing under the app:// protocol.
async function writeExport(
  defaultName: string,
  filters: { name: string; extensions: string[] }[],
  data: Uint8Array,
): Promise<void> {
  try {
    await saveFile({ defaultName, filters, data });
  } catch (e) {
    console.error(`Failed to export ${defaultName}`, e);
  }
}

export function exportCsv(result: QueryResult): void {
  const header = result.columns.join(',');
  const rowLines = result.rows.map((row) =>
    result.columns
      .map((_col, i) => {
        const val = row[i];
        if (val === null || val === undefined) return '';
        const s = stringifyCellValue(val);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      })
      .join(','),
  );
  const csv = [header, ...rowLines].join('\n');
  void writeExport(
    'results.csv',
    [{ name: 'CSV', extensions: ['csv'] }],
    new TextEncoder().encode(csv),
  );
}

export function exportXlsx(result: QueryResult): void {
  // Build rows as arrays to preserve column order and map native JS types
  // directly to Excel cell types (numbers stay numeric, booleans stay boolean,
  // ISO date strings become Excel date serials so they render as dates).
  const header = result.columns;
  const dataRows = result.rows.map((row) =>
    result.columns.map((_col, i) => {
      const val = row[i];
      if (val === null || val === undefined) return '';
      // ISO 8601 strings from the server (Date.toISOString()) → Excel date
      if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) {
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d;
      }
      // jsonb/json columns arrive as objects/arrays — SheetJS can't write those
      // as a cell value directly, so serialize to a JSON string like other exports.
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    }),
  );

  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);

  // Auto-fit column widths based on header length (rough heuristic)
  ws['!cols'] = header.map((h) => ({ wch: Math.max(h.length + 2, 10) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  // `write` to an array rather than `writeFile`, which would try to trigger a download.
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  void writeExport(
    'results.xlsx',
    [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    new Uint8Array(bytes),
  );
}

/** Resolves false when the clipboard refused the write, so the caller can say so. */
export async function copyResult(result: QueryResult): Promise<boolean> {
  // text/plain fallback as TSV (pastes as columns in editors/spreadsheets)
  const text = [
    result.columns.join('\t'),
    ...result.rows.map((row) => result.columns.map((_col, i) => cellText(row, i)).join('\t')),
  ].join('\n');

  // text/html as a real <table> so Teams/Slack/Word/Sheets paste it formatted
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const headerHtml = result.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const rowsHtml = result.rows
    .map(
      (row) =>
        `<tr>${result.columns.map((_col, i) => `<td>${escapeHtml(cellText(row, i))}</td>`).join('')}</tr>`,
    )
    .join('');
  const html = `<table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;

  // Deliberately not `navigator.clipboard`: the session denies every permission, so the web
  // API rejects here no matter what. Main owns the clipboard, as it owns the save dialog.
  try {
    await copyToClipboard({ text, html });
    return true;
  } catch (e) {
    console.error('Failed to copy table to clipboard', e);
    return false;
  }
}

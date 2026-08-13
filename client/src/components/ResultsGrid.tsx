import React, { useRef, useMemo, useState, useEffect } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  ColumnDef,
  ColumnSizingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { QueryResult } from '../store';
import { stringifyCellValue } from '../resultExport';
import { measureColumnWidths } from '../columnWidths';
import { DocumentView } from './DocumentView';

/** The `#` column. Not resizable, so its width lives here rather than in column state. */
const ROW_NUMBER_WIDTH = 48;

interface ResultsGridProps {
  result: QueryResult | null;
  error: string | null;
  /** Owned by the tab — the control that switches it lives in the status bar. */
  viewMode: 'table' | 'documents';
}

// React.memo: ResultsGrid receives result/error from the active tab. Without memo,
// it re-renders every time App re-renders (e.g. on setActiveTab, tab-bar changes).
// Custom comparator: re-render only when the actual data changes, not on parent cycles.
export const ResultsGrid = React.memo(function ResultsGrid({
  result,
  error,
  viewMode,
}: ResultsGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const columns = useMemo<ColumnDef<unknown[]>[]>(() => {
    if (!result) return [];
    // Measured up front so the table can use `table-layout: fixed`: with automatic layout
    // the browser sizes columns from the rows currently in the DOM, and virtualization
    // swaps those on every scroll, making the columns jump. See columnWidths.ts.
    const widths = measureColumnWidths(result);
    return result.columns.map((col, i) => ({
      // Explicit id (with index) keeps columns unique even when the query returns
      // unnamed columns (SQL Server names them '') or duplicate column names, both
      // of which break TanStack's automatic id derivation from accessorKey.
      id: `${i}:${col}`,
      // Rows are positional arrays, so cells are read by index — reading by name
      // would show the same value under every column that shares that name.
      accessorFn: (row: unknown[]) => row[i],
      header: () => (
        // min-w-0 + truncate: the th clips its own overflow, but that doesn't reach these
        // spans, so without it a long name would keep the header from shrinking on resize.
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="truncate">{col}</span>
          {result.columnTypes?.[i] && (
            <span className="text-[10px] font-normal text-text-dim leading-none truncate">
              {result.columnTypes[i]}
            </span>
          )}
        </div>
      ),
      cell: (info) => {
        const val = info.getValue();
        if (val === null || val === undefined) {
          return <span className="text-text-dim italic">NULL</span>;
        }
        // Line breaks are shown as ↵ instead of rendered literally: the grid is
        // virtualized with a fixed row height, so an actual line break would make
        // the row taller than the virtualizer expects and overlap the next row.
        return stringifyCellValue(val).replace(/\r\n|\r|\n/g, '↵');
      },
      size: widths[i],
    }));
  }, [result]);

  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});

  // A new result brings its own measured widths; widths the user dragged belonged to the
  // previous set of columns, so they're dropped rather than carried over by position.
  useEffect(() => setColumnSizing({}), [result]);

  const table = useReactTable({
    data: result?.rows ?? [],
    columns,
    defaultColumn: { minSize: 48, maxSize: 800 },
    columnResizeMode: 'onChange',
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
  });

  const { rows } = table.getRowModel();

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 20,
  });

  // Data columns plus the `#` column and the filler — the span the padding rows must cover.
  const totalColumnCount = columns.length + 2;

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - (virtualRows[virtualRows.length - 1].end ?? 0) : 0;

  if (error) {
    return (
      <div className="p-4 bg-error/10 border-t border-error/30">
        <p className="text-sm text-error font-mono whitespace-pre-wrap">{error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-text-dim text-sm">
        Run a query to see results
      </div>
    );
  }

  return (
    // Nothing sits above the results anymore: the run stats, the exports and the view
    // toggle all moved to the window's status bar, so a result opens straight onto its data.
    <div className="flex flex-col h-full">
      {viewMode === 'documents' && result.documents ? (
        <DocumentView documents={result.documents} />
      ) : (
        /* Virtualized table */
        <div ref={parentRef} className="flex-1 overflow-auto min-h-0">
          {/* table-layout: fixed is what freezes the columns: widths come from the
              colgroup below and stop depending on which virtual rows are mounted. */}
          <table
            className="results-table text-xs w-full border-collapse"
            style={{ tableLayout: 'fixed' }}
          >
            <colgroup>
              <col style={{ width: ROW_NUMBER_WIDTH }} />
              {table.getVisibleLeafColumns().map((column) => (
                <col key={column.id} style={{ width: column.getSize() }} />
              ))}
              {/* Widthless filler: soaks up the leftover space when the columns don't fill
                  the container. When they overflow it instead, it collapses to nothing and
                  the scroll container handles the horizontal scroll. */}
              <col />
            </colgroup>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  <th className="text-right px-2 py-2 text-text-dim font-normal">#</th>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="relative text-left px-2 py-2 text-text-muted font-semibold"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onDoubleClick={() => header.column.resetSize()}
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-accent/60 active:bg-accent"
                      />
                    </th>
                  ))}
                  <th />
                </tr>
              ))}
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr>
                  <td colSpan={totalColumnCount} style={{ height: paddingTop }} />
                </tr>
              )}
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <tr key={row.id} className="border-b border-surface-2">
                    <td className="px-2 py-1 text-right text-text-dim select-none">
                      {virtualRow.index + 1}
                    </td>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-2 py-1 text-text">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                    <td />
                  </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr>
                  <td colSpan={totalColumnCount} style={{ height: paddingBottom }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.result === next.result && prev.error === next.error && prev.viewMode === next.viewMode);

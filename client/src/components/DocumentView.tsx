import React, { useState } from 'react';
import { Icon } from './Icon';

interface DocumentViewProps {
  documents: Record<string, unknown>[];
}

/** Same affordance as the explorer tree, so it reads as the same control. */
function Chevron({ open }: { open: boolean | null }) {
  return (
    <span className="flex items-center justify-center w-3.5 flex-shrink-0 text-text-muted">
      {open !== null && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />}
    </span>
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyLeaf(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-text-dim italic">NULL</span>;
  }
  return <span className="text-text">{stringifyLeaf(value)}</span>;
}

function summarize(doc: Record<string, unknown>): string {
  const keys = Object.keys(doc);
  const fieldCount = `${keys.length} field${keys.length !== 1 ? 's' : ''}`;
  return '_id' in doc ? `_id: ${stringifyLeaf(doc._id)}  ·  ${fieldCount}` : fieldCount;
}

// Recursively renders one key/value pair. Objects and arrays are independently
// collapsible (expanded by default once their parent document is opened); leaf
// values render inline.
function FieldRow({ keyName, value }: { keyName: string; value: unknown }) {
  const [open, setOpen] = useState(true);

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return (
      <div>
        <div
          className="flex items-center gap-1.5 px-2 py-0.5 tree-item cursor-pointer select-none"
          onClick={() => keys.length > 0 && setOpen((v) => !v)}
        >
          <Chevron open={keys.length > 0 ? open : null} />
          <span className="text-accent">{keyName}:</span>
          <span className="text-text-dim">
            {'{ }'} {keys.length} field{keys.length !== 1 ? 's' : ''}
          </span>
        </div>
        {open && keys.length > 0 && (
          <div className="pl-4">
            {keys.map((k) => (
              <FieldRow key={k} keyName={k} value={value[k]} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div>
        <div
          className="flex items-center gap-1.5 px-2 py-0.5 tree-item cursor-pointer select-none"
          onClick={() => value.length > 0 && setOpen((v) => !v)}
        >
          <Chevron open={value.length > 0 ? open : null} />
          <span className="text-accent">{keyName}:</span>
          <span className="text-text-dim">
            [ ] {value.length} item{value.length !== 1 ? 's' : ''}
          </span>
        </div>
        {open && value.length > 0 && (
          <div className="pl-4">
            {value.map((item, i) =>
              isPlainObject(item) || Array.isArray(item) ? (
                <FieldRow key={i} keyName={`[${i}]`} value={item} />
              ) : (
                <div key={i} className="flex items-center gap-1.5 px-2 py-0.5">
                  <span className="w-3.5 flex-shrink-0" />
                  <span className="text-text-dim">[{i}]:</span>
                  <Leaf value={item} />
                </div>
              ),
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5">
      <span className="w-3.5 flex-shrink-0" />
      <span className="text-accent">{keyName}:</span>
      <Leaf value={value} />
    </div>
  );
}

function DocumentCard({ doc, index }: { doc: Record<string, unknown>; index: number }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(doc);

  return (
    <div className="border-b border-surface-2">
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 tree-item cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        <span className="text-text-dim w-8 text-right flex-shrink-0">{index + 1}</span>
        <span className="text-text truncate flex-1">{summarize(doc)}</span>
      </div>
      {open && (
        <div className="pl-4 pb-2">
          {keys.map((k) => (
            <FieldRow key={k} keyName={k} value={doc[k]} />
          ))}
        </div>
      )}
    </div>
  );
}

// Expandable per-document view: each document renders collapsed (summary line
// only) by default so large result sets stay cheap to render, expanding to a
// recursive key/value tree that mirrors the SchemaTree's collapsible-tree style.
export const DocumentView = React.memo(function DocumentView({ documents }: DocumentViewProps) {
  if (documents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-dim text-sm">
        No documents returned
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto min-h-0 text-xs font-mono">
      {documents.map((doc, i) => (
        <DocumentCard key={i} doc={doc} index={i} />
      ))}
    </div>
  );
});

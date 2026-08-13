import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // When true, the confirm button is styled as a destructive action.
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Autofocus Cancel — the safe choice for a destructive prompt, and lets Enter
  // resolve immediately to "cancel" unless the user deliberately tabs to confirm.
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onMouseDown={onCancel}
    >
      <div
        className="bg-surface rounded-lg shadow-2xl w-[440px] p-6 border border-surface-3"
        // Stop backdrop click from closing when interacting inside the dialog.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text mb-3 flex items-center gap-2">
          {danger && <span className="text-warning">⚠️</span>}
          {title}
        </h2>
        <p className="text-sm text-text-muted whitespace-pre-line leading-relaxed">{message}</p>

        <div className="flex justify-end gap-2 mt-6">
          <button ref={cancelRef} className="btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={
              danger
                ? 'text-sm px-4 py-1.5 rounded bg-error/90 hover:bg-error text-white font-medium'
                : 'btn-primary'
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

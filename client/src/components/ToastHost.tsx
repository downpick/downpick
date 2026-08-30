import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Toast, useStore } from '../store';

/** Long enough to read two lines and glance back, short enough not to sit in the way. */
const TOAST_MS = 6000;

/**
 * The in-app half of query notifications.
 *
 * Only ever shows what main told the renderer to show: when the window is in the background
 * the desktop gets a native notification instead, and nothing lands here. See
 * `electron/notifications.ts` for where that fork is made.
 *
 * Portalled to the body and pinned above the status bar, so it does not have to thread
 * through the flex layout the editor and results panes are laid out with.
 */
export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-10 right-4 z-[60] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const { dismissToast, setActiveTab } = useStore.getState();

  // One timer per toast, keyed by its id, so a new toast arriving never resets an older
  // one's countdown.
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast.id, dismissToast]);

  // The tab may have been closed while the query ran; without it the card is still worth
  // reading, it just has nowhere to take you.
  function reveal() {
    if (toast.tabId && useStore.getState().tabs.some((t) => t.id === toast.tabId)) {
      setActiveTab(toast.tabId);
    }
    dismissToast(toast.id);
  }

  return (
    <div
      className="pointer-events-auto w-[320px] bg-surface border border-surface-3 rounded-lg shadow-2xl px-3.5 py-3 flex items-start gap-2.5 cursor-pointer hover:border-accent/50 transition-colors"
      onClick={reveal}
      role="status"
    >
      <span
        className={`text-sm leading-5 flex-shrink-0 ${
          toast.kind === 'warning' ? 'text-warning' : 'text-success'
        }`}
        aria-hidden
      >
        {toast.kind === 'warning' ? '⚠' : '✓'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text m-0 font-medium">{toast.title}</p>
        <p className="text-xs text-text-dim m-0 mt-0.5 break-words">{toast.body}</p>
      </div>
      <button
        className="text-text-dim hover:text-text text-sm leading-none flex-shrink-0 -mt-0.5 cursor-pointer"
        title="Dismiss"
        aria-label="Dismiss"
        // Dismiss without switching tabs — the card as a whole is the "take me there" target.
        onClick={(e) => {
          e.stopPropagation();
          dismissToast(toast.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

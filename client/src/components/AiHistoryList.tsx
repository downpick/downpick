import React, { useCallback, useEffect, useState } from 'react';
import { AiConversationSummary, AiHistoryCursor, api } from '../api';
import { useStore } from '../store';
import { ConfirmDialog } from './ConfirmDialog';

function TrashIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M2.6 4.2h10.8" />
      <path d="M6.3 4.2V3a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1.2" />
      <path d="M4 4.2l.55 8.3a1.3 1.3 0 0 0 1.3 1.2h4.3a1.3 1.3 0 0 0 1.3-1.2L12 4.2" />
      <path d="M6.7 6.9v4" />
      <path d="M9.3 6.9v4" />
    </svg>
  );
}

/** How many conversations to fetch at a time. */
const PAGE_SIZE = 30;

/** How close to the bottom of the list counts as "load the next page". */
const LOAD_MORE_SLACK_PX = 200;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse relative time, precise enough for "when did I ask this" and no more. Local to this
 * file until something else needs it — there is no shared date helper in the client yet.
 */
function relativeTime(ms: number): string {
  const elapsed = Date.now() - ms;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return 'yesterday';
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Saved conversations, newest first, as an overlay inside the AI panel.
 *
 * The list is global rather than scoped to the current tab's database — a question asked
 * against staging is usually worth finding again from prod — so every row carries its
 * connection and database as the thing that tells them apart.
 */
export function AiHistoryList({
  activeConversationId,
  onResume,
  onClose,
}: {
  activeConversationId: string | null;
  onResume: (id: string) => void;
  onClose: () => void;
}) {
  const { forgetAiConversation, forgetAllAiConversations } = useStore.getState();

  const [items, setItems] = useState<AiConversationSummary[]>([]);
  const [cursor, setCursor] = useState<AiHistoryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  // Three separate states on purpose: an empty list, a database that would not open, and a
  // call that failed all look identical if they collapse into one "nothing here" message.
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const load = useCallback(async (before: AiHistoryCursor | null) => {
    setLoading(true);
    try {
      const page = await api.aiHistoryList({ limit: PAGE_SIZE, before });
      setAvailable(page.available);
      setError(null);
      setCursor(page.nextCursor);
      setItems((prev) => {
        if (!before) return page.items;
        // A conversation whose updated_at bumps mid-pagination can be handed back on a
        // later page too; without this it would appear twice with the same key.
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load chat history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!cursor || loading) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_SLACK_PX) {
        void load(cursor);
      }
    },
    [cursor, loading, load],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.aiHistoryDelete(id);
      } catch {
        // Already gone. Dropping it from the list is still the right outcome.
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      // Without this the tab still holding the id would upsert the conversation straight
      // back into existence on its next question.
      forgetAiConversation(id);
    },
    [forgetAiConversation],
  );

  const handleClearAll = useCallback(async () => {
    setConfirmingClear(false);
    try {
      await api.aiHistoryClear();
      setItems([]);
      setCursor(null);
      forgetAllAiConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear chat history.');
    }
  }, [forgetAllAiConversations]);

  return (
    <div className="absolute inset-0 z-10 bg-surface flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-2 flex-shrink-0">
        <p className="text-[11.5px] font-semibold text-text m-0 flex-1">Past chats</p>
        <button
          className="text-text-muted hover:text-text text-base leading-none px-1"
          onClick={onClose}
          title="Back to chat"
          aria-label="Back to chat"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0" onScroll={onScroll}>
        {error ? (
          <p className="text-[11.5px] text-error px-3 py-4 leading-relaxed m-0">{error}</p>
        ) : !available ? (
          <p className="text-[11.5px] text-text-dim px-3 py-4 leading-relaxed m-0">
            Chat history is unavailable — <code>~/.downpick/chats.db</code> could not be opened.
            Asking questions still works; they just are not being saved.
          </p>
        ) : items.length === 0 && !loading ? (
          <p className="text-[11.5px] text-text-dim px-3 py-4 leading-relaxed m-0">
            No past chats yet. Conversations are saved as you go.
          </p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => onResume(item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onResume(item.id);
                }
              }}
              className={`group w-full text-left flex items-start gap-2 px-3 py-2 border-b border-surface-2 cursor-pointer ${
                item.id === activeConversationId
                  ? 'bg-surface-1 border-l-2 border-l-accent'
                  : 'hover:bg-surface-1'
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text leading-snug m-0 line-clamp-2">{item.title}</p>
                <p className="text-[10.5px] text-text-dim leading-snug mt-1 m-0 truncate">
                  {item.connectionName} · {item.database} · {relativeTime(item.updatedAt)}
                </p>
              </div>
              <button
                className="text-text-dim hover:text-error px-1 mt-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 flex items-center justify-center transition-colors"
                onClick={(e) => {
                  // Without this the row underneath would resume the chat being deleted.
                  e.stopPropagation();
                  void handleDelete(item.id);
                }}
                title="Delete this chat"
                aria-label={`Delete chat: ${item.title}`}
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}

        {loading && (
          <p className="text-[11px] text-text-dim px-3 py-2 m-0">Loading…</p>
        )}
      </div>

      {items.length > 0 && (
        <div className="px-3 py-2 border-t border-surface-2 flex-shrink-0">
          <button
            className="text-[11px] text-text-dim hover:text-error transition-colors"
            onClick={() => setConfirmingClear(true)}
          >
            Clear all history
          </button>
        </div>
      )}

      {confirmingClear && (
        <ConfirmDialog
          danger
          title="Delete all chat history?"
          message="Every saved Ask AI conversation will be removed from this machine. This cannot be undone."
          confirmLabel="Delete all"
          onConfirm={() => void handleClearAll()}
          onCancel={() => setConfirmingClear(false)}
        />
      )}
    </div>
  );
}

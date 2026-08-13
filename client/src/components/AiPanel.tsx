import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiChatStream, api, AiHistoryEntry, AiProviderInfo } from '../api';
import { AiMessage, emptyAiChat, Tab, useStore } from '../store';

/** Starter prompts, mirroring the design's chip row. */
const SQL_CHIPS = [
  'Top 5 orders from recent signups',
  'Most common event types',
  'Columns in the users table',
];
const MONGO_CHIPS = [
  'Five most recent documents',
  'Count documents by status',
  'Fields in the users collection',
];

/** How long the "Inserted ✓" confirmation stays up. */
const INSERTED_FLASH_MS = 2400;

/** Shared fallback for a tab with no conversation yet — a fresh object every render would
 *  give the scroll effect new array identities and re-run it continuously. */
const NO_CHAT = emptyAiChat();

let messageCounter = 0;
function newMessageId() {
  return `ai-${++messageCounter}`;
}

function Sparkle({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0.5l1.6 4.4L14 6.5l-4.4 1.6L8 12.5l-1.6-4.4L2 6.5l4.4-1.6L8 0.5z" />
      <path d="M13 10l.7 1.8L15.5 12.5l-1.8.7L13 15l-.7-1.8L10.5 12.5l1.8-.7L13 10z" opacity="0.7" />
    </svg>
  );
}

/** The compose mark most chat UIs use for "start a new one". */
function NewChatIcon({ className = '' }: { className?: string }) {
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
      <path d="M7.5 2.5H3.6A1.6 1.6 0 0 0 2 4.1v8.3A1.6 1.6 0 0 0 3.6 14h8.3a1.6 1.6 0 0 0 1.6-1.6V8.5" />
      <path d="M11.6 1.9a1.55 1.55 0 0 1 2.2 2.2L8.5 9.4l-2.8.6.6-2.8 5.3-5.3z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3 animate-spin text-accent" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M8 2a6 6 0 016 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TraceLine({ label, active }: { label: string; active?: boolean }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] font-mono text-text-dim">
      {active ? (
        <span className="mt-0.5 flex-shrink-0">
          <Spinner />
        </span>
      ) : (
        <span className="text-success flex-shrink-0">✓</span>
      )}
      <span className="min-w-0 break-words">{label}</span>
    </div>
  );
}

function AssistantMessage({
  message,
  onInsert,
}: {
  message: AiMessage;
  onInsert: (message: AiMessage) => void;
}) {
  if (message.isError) {
    return (
      <p className="text-xs text-error bg-error/10 rounded px-2.5 py-2 leading-relaxed">
        {message.text}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {message.trace?.map((step, i) => (
        <TraceLine key={i} label={step.label} />
      ))}
      {message.text && (
        <p className="text-xs text-text-muted leading-relaxed whitespace-pre-wrap">
          {message.text}
        </p>
      )}
      {message.sql && (
        <>
          <div className="bg-surface-1 border border-surface-2 rounded-lg p-2.5 overflow-x-auto">
            <pre className="font-mono text-[11.5px] text-text leading-relaxed whitespace-pre m-0">
              {message.sql}
            </pre>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              className="btn-primary text-[11px] px-2.5 py-1"
              onClick={() => onInsert(message)}
            >
              Insert into editor
            </button>
            {message.justInserted && (
              <span className="text-[11px] text-success">Inserted ✓</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function AiPanel({ tab, width }: { tab: Tab; width: number }) {
  const chat = useStore((s) => s.aiChats[tab.id]) ?? NO_CHAT;
  const connType = useStore((s) => s.savedConnections.find((c) => c.id === tab.connectionId)?.type);
  const { setAiPanelOpen, updateAiChat, clearAiChat, insertAiSql, clearInsertedFlag, openSettings } =
    useStore.getState();

  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const settingsOpen = useStore((s) => s.showSettingsDialog);

  // Refetch on mount and every time the Settings dialog closes. Without the second half,
  // the panel's own "Configure AI provider" button would send the user to Settings, they
  // would add a provider, come back — and still be looking at the empty state.
  useEffect(() => {
    if (settingsOpen) return;
    api
      .aiProviders()
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
  }, [settingsOpen]);

  // Every enabled model across every provider — the picker's options, flattened.
  const modelOptions = useMemo(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({ value: `${p.id}::${m}`, label: `${p.label} — ${m}` })),
      ),
    [providers],
  );

  const configured = modelOptions.length > 0;
  const effectiveModel =
    modelOptions.find((o) => o.value === selectedModel)?.value ?? modelOptions[0]?.value ?? '';

  // Keep the newest message in view as the answer streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.liveTrace, chat.thinking]);

  // Abandon an in-flight answer if the panel unmounts or the tab is closed.
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      const current = useStore.getState().aiChats[tab.id] ?? emptyAiChat();
      if (!trimmed || current.thinking || !effectiveModel) return;

      const [providerId, ...modelParts] = effectiveModel.split('::');
      const model = modelParts.join('::');

      // Only the durable part of the conversation is replayed — trace lines are UI detail.
      const history: AiHistoryEntry[] = current.messages
        .filter((m) => !m.isError)
        .map((m) => ({ role: m.role, text: m.text, sql: m.sql ?? null }));

      updateAiChat(tab.id, (c) => ({
        messages: [...c.messages, { id: newMessageId(), role: 'user' as const, text: trimmed }],
        draft: '',
        thinking: true,
        liveTrace: [],
      }));

      const controller = new AbortController();
      abortRef.current = controller;

      const finish = (message: AiMessage) =>
        updateAiChat(tab.id, (c) => ({
          messages: [...c.messages, message],
          thinking: false,
          liveTrace: [],
        }));

      try {
        let answered = false;
        for await (const event of aiChatStream(
          { providerId, model, connectionId: tab.connectionId, database: tab.database, question: trimmed, history },
          controller.signal,
        )) {
          if (event.type === 'step') {
            updateAiChat(tab.id, (c) => ({ liveTrace: [...c.liveTrace, { label: event.label }] }));
          } else if (event.type === 'message') {
            answered = true;
            finish({
              id: newMessageId(),
              role: 'assistant',
              text: event.note,
              sql: event.sql,
              trace: event.trace,
            });
          } else {
            answered = true;
            finish({ id: newMessageId(), role: 'assistant', text: event.message, isError: true });
          }
        }
        // A stream that ends without either a message or an error means the connection
        // dropped mid-answer; say so rather than leaving the spinner running forever.
        if (!answered) {
          finish({
            id: newMessageId(),
            role: 'assistant',
            text: 'The answer was cut off before it finished.',
            isError: true,
          });
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          updateAiChat(tab.id, () => ({ thinking: false, liveTrace: [] }));
          return;
        }
        finish({
          id: newMessageId(),
          role: 'assistant',
          text: err instanceof Error ? err.message : 'The request failed.',
          isError: true,
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [tab.id, tab.connectionId, tab.database, effectiveModel, updateAiChat],
  );

  const handleInsert = useCallback(
    (message: AiMessage) => {
      if (!message.sql) return;
      insertAiSql(tab.id, message.id, message.sql);
      setTimeout(() => clearInsertedFlag(tab.id, message.id), INSERTED_FLASH_MS);
    },
    [tab.id, insertAiSql, clearInsertedFlag],
  );

  // Starting a new chat has to drop the request still in flight too. Without the abort, an
  // answer to the old question would arrive and land in the empty conversation.
  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    clearAiChat(tab.id);
  }, [tab.id, clearAiChat]);

  const chips = connType === 'mongodb' ? MONGO_CHIPS : SQL_CHIPS;

  // Nothing said yet, nothing in flight. Both the intro blurb and the starter chips are
  // cold-start scaffolding — once there is a conversation to read they are in the way, and
  // the composer should be the only thing under it. Clearing the chat brings them back.
  const isFresh = chat.messages.length === 0 && !chat.thinking;

  return (
    <div
      style={{ width }}
      className="flex-shrink-0 flex flex-col border-l border-surface-2 bg-surface min-w-0"
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-surface-2 flex-shrink-0">
        <Sparkle className="w-4 h-4 text-accent flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-text m-0">Ask AI</p>
          <p className="text-[11px] text-text-dim m-0">Reads your schema · never runs queries</p>
        </div>
        <button
          className="text-text-muted hover:text-text flex items-center justify-center px-1"
          onClick={handleNewChat}
          title="New chat"
          aria-label="New chat"
        >
          <NewChatIcon className="w-4 h-4" />
        </button>
        <button
          className="text-text-muted hover:text-text text-base leading-none px-1"
          onClick={() => setAiPanelOpen(false)}
          title="Close"
          aria-label="Close Ask AI"
        >
          ×
        </button>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-3.5 min-h-0">
        {!configured ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2.5 text-center px-2 py-5">
            <span className="text-2xl text-text-dim leading-none">⚡</span>
            <p className="text-xs font-semibold text-text m-0">No AI provider configured</p>
            <p className="text-[11.5px] text-text-dim leading-relaxed max-w-[240px] m-0">
              Add a provider and API key so Ask AI can generate queries from your schema.
            </p>
            <button className="btn-primary text-xs mt-1" onClick={() => openSettings('ai')}>
              Configure AI provider
            </button>
          </div>
        ) : (
          <>
            {chat.messages.map((message) =>
              message.role === 'user' ? (
                <div
                  key={message.id}
                  className="self-end max-w-[88%] bg-surface-2 border border-surface-3 rounded-lg px-2.5 py-2"
                >
                  <p className="text-xs text-text leading-relaxed m-0 whitespace-pre-wrap">
                    {message.text}
                  </p>
                </div>
              ) : (
                <AssistantMessage key={message.id} message={message} onInsert={handleInsert} />
              ),
            )}

            {chat.thinking && (
              <div className="flex flex-col gap-1.5">
                {chat.liveTrace.map((step, i) => (
                  <TraceLine key={i} label={step.label} />
                ))}
                <TraceLine label="Thinking…" active />
              </div>
            )}

            {isFresh && (
              <p className="text-[11.5px] text-text-dim leading-relaxed m-0">
                Ask a question about your data. I can see the tables, columns, and schemas
                you&rsquo;re connected to — I only write queries into the editor for you to
                review and run.
              </p>
            )}
          </>
        )}
      </div>

      {/* Composer */}
      {configured && (
        <div className="p-3 border-t border-surface-2 flex flex-col gap-2 flex-shrink-0">
          {isFresh && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <button
                  key={chip}
                  className="text-[11px] text-text-muted hover:text-text border border-surface-3 hover:border-accent rounded-lg px-2 py-1 transition-colors"
                  onClick={() => void send(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          <textarea
            className="input resize-none text-xs leading-relaxed"
            rows={2}
            placeholder="Ask about your data…"
            value={chat.draft}
            onChange={(e) => {
              const draft = e.target.value;
              updateAiChat(tab.id, () => ({ draft }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(chat.draft);
              }
            }}
          />

          <div className="flex items-center gap-2">
            <select
              className="input text-[11.5px] py-1 flex-1 min-w-0"
              value={effectiveModel}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              className="w-8 h-8 flex-shrink-0 rounded-lg bg-accent hover:bg-accent-hover text-surface-1 flex items-center justify-center transition-colors disabled:opacity-50"
              onClick={() => void send(chat.draft)}
              disabled={chat.thinking || !chat.draft.trim()}
              title="Send (Enter)"
              aria-label="Send"
            >
              ➤
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

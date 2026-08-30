import React, { useEffect, useRef, useState } from 'react';
import { api, AppSettings, ValidationResult } from '../api';
import { IS_MAC, IS_WINDOWS } from '../platform';
import { SettingsSection, useStore } from '../store';
import { AiProviderSettings } from './AiProviderSettings';

type Status =
  | { state: 'idle' }
  | { state: 'validating' }
  | { state: 'ok'; fileExists: boolean }
  | { state: 'warn'; message: string };

/** Rail order, with the heading each pane shows above its fields. */
const SECTIONS: {
  id: SettingsSection;
  label: string;
  title: string;
  description: string;
}[] = [
  {
    id: 'general',
    label: 'General',
    title: 'General',
    description: 'How Downpick behaves between launches, and limits every query runs under.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    title: 'Notifications',
    description: 'Whether Downpick tells you a query has finished, and how loudly.',
  },
  {
    id: 'security',
    label: 'Security',
    title: 'Security',
    description: 'Where the vault lives, what guards it, and when it locks itself again.',
  },
  {
    id: 'ai',
    label: 'AI providers',
    title: 'AI providers',
    description: 'Providers Ask AI can use to generate queries.',
  },
];

/**
 * Where this OS keeps the per-app notification switch.
 *
 * Named rather than described, because a blocked notification is indistinguishable from a
 * working one from inside the app — macOS swallows `show()` in silence when the app is
 * denied — so the only help worth offering is the exact place to go and look.
 */
const OS_NOTIFICATION_SETTINGS = IS_MAC
  ? 'System Settings ▸ Notifications'
  : IS_WINDOWS
    ? 'Settings ▸ System ▸ Notifications'
    : "your desktop's notification settings";

type TestStatus = 'idle' | 'sending' | 'sent' | 'unsupported' | 'error';

function StatusBadge({ status }: { status: Status }) {
  if (status.state === 'idle') return null;
  if (status.state === 'validating') {
    return <p className="text-xs text-text-dim mt-1.5">Checking…</p>;
  }
  if (status.state === 'ok') {
    // The connection count is unknowable from here: it is inside the encrypted payload.
    return status.fileExists ? (
      <p className="text-xs text-success mt-1.5">✓ A readable Downpick vault</p>
    ) : (
      <p className="text-xs text-text-dim mt-1.5">
        File not found — a new vault will be created there
      </p>
    );
  }
  return (
    <p className="text-xs text-warning mt-1.5">
      ⚠ {status.message}
    </p>
  );
}

/**
 * What came of the test button.
 *
 * "Sent" is as far as the app can honestly go: the OS reports nothing back when it decides
 * not to show a notification, so the only truthful follow-up is to ask. What to do about a
 * "no" is in the paragraph right above the button — repeating it here would say the same
 * thing twice and crowd the button off its own line.
 */
function TestStatusNote({ status }: { status: TestStatus }) {
  if (status === 'idle') return null;
  if (status === 'sending') return <span className="text-xs text-text-dim">Sending…</span>;
  if (status === 'unsupported') {
    return (
      <span className="text-xs text-warning">⚠ This system has no notification support</span>
    );
  }
  if (status === 'error') {
    return <span className="text-xs text-warning">⚠ Could not send it</span>;
  }
  return (
    <span className="text-xs text-text-dim">
      Sent — did it appear?
    </span>
  );
}

export function SettingsDialog({
  onClose,
  onChangeMasterPassword,
  initialTab = 'general',
}: {
  onClose: () => void;
  onChangeMasterPassword: () => void;
  initialTab?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialTab);
  const persistTabs = useStore((s) => s.persistTabs);
  const setPersistTabs = useStore.getState().setPersistTabs;

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [inputPath, setInputPath] = useState('');
  // Pending value for the toggle — applied to the store only on Save, so the
  // checkbox participates in the dialog's dirty/Save flow like the path field.
  const [pendingPersistTabs, setPendingPersistTabs] = useState(persistTabs);
  const [timeoutInput, setTimeoutInput] = useState('');
  const [pendingNotify, setPendingNotify] = useState(true);
  const [notifyAfterInput, setNotifyAfterInput] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [autoLockInput, setAutoLockInput] = useState('');
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load current settings on mount
  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setInputPath(s.vaultFilePath);
      setTimeoutInput(String(s.queryTimeoutSeconds));
      setPendingNotify(s.notifyOnQueryFinish);
      setNotifyAfterInput(String(s.notifyAfterSeconds));
      setAutoLockInput(String(s.autoLockMinutes));
      // Show initial validation state from server
      applyValidation(s);
    }).catch(() => {});
  }, []);

  function applyValidation(v: ValidationResult) {
    if (!v.valid) {
      setStatus({ state: 'warn', message: v.error ?? 'Invalid file' });
    } else {
      setStatus({ state: 'ok', fileExists: v.fileExists });
    }
  }

  function handlePathChange(value: string) {
    setInputPath(value);
    setSaveError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim()) {
      setStatus({ state: 'idle' });
      return;
    }

    setStatus({ state: 'validating' });
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await api.validateSettingsPath(value.trim());
        applyValidation(result);
      } catch {
        setStatus({ state: 'idle' });
      }
    }, 400);
  }

  /**
   * Native file dialog for the path field.
   *
   * Two modes rather than one button, because the field legitimately accepts both an existing
   * vault and a location where one will be created, and the dialogs are not interchangeable: a
   * save panel asks whether to replace the vault you were trying to point at, and an open
   * panel cannot name a file that does not exist yet.
   *
   * Whatever comes back goes through handlePathChange, so a picked path is validated and
   * badged exactly like a typed one.
   */
  async function browseForVault(mode: 'open' | 'create') {
    setSaveError(null);
    try {
      const result = await api.pickVaultFile({
        mode,
        defaultPath: inputPath.trim() || settings?.defaultVaultPath,
      });
      if (result.canceled || !result.path) return;
      handlePathChange(result.path);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'The file dialog could not be opened.');
    }
  }

  /**
   * Raise a notification on demand. There is nothing to assert about the result: a denied
   * notification is swallowed by the OS without an error, so all this can honestly report is
   * that it was handed over — the user's own screen is the assertion.
   */
  async function sendTestNotification() {
    setTestStatus('sending');
    try {
      const { supported } = await api.sendTestNotification();
      setTestStatus(supported ? 'sent' : 'unsupported');
    } catch {
      setTestStatus('error');
    }
  }

  function resetToDefault() {
    if (settings) handlePathChange(settings.defaultVaultPath);
  }

  const parsedTimeout = Number(timeoutInput.trim());
  const timeoutValid = Number.isInteger(parsedTimeout) && parsedTimeout >= 0 && parsedTimeout <= 3600;
  const parsedNotifyAfter = Number(notifyAfterInput.trim());
  // Only gates Save while notifications are on: a stale number behind a switched-off toggle
  // is not something to stop the user over.
  const notifyAfterValid =
    !pendingNotify ||
    (Number.isInteger(parsedNotifyAfter) && parsedNotifyAfter >= 0 && parsedNotifyAfter <= 3600);
  const parsedAutoLock = Number(autoLockInput.trim());
  const autoLockValid =
    Number.isInteger(parsedAutoLock) && parsedAutoLock >= 0 && parsedAutoLock <= 1440;
  const pathValid = inputPath.trim().length > 0;

  async function handleSave() {
    const trimmed = inputPath.trim();
    if (!trimmed || !timeoutValid || !autoLockValid || !notifyAfterValid) return;

    setSaving(true);
    setSaveError(null);
    try {
      // Apply the client-side tab persistence preference.
      if (pendingPersistTabs !== persistTabs) {
        setPersistTabs(pendingPersistTabs);
      }
      const pathChanged = settings != null && trimmed !== settings.vaultFilePath;
      const timeoutChanged = settings != null && parsedTimeout !== settings.queryTimeoutSeconds;
      const autoLockChanged = settings != null && parsedAutoLock !== settings.autoLockMinutes;
      const notifyChanged = settings != null && pendingNotify !== settings.notifyOnQueryFinish;
      // A threshold typed while the toggle is off is not worth sending, and may not even be
      // a number — keep the stored value in that case.
      const notifyAfter = notifyAfterValid && pendingNotify ? parsedNotifyAfter : undefined;
      const notifyAfterChanged =
        settings != null && notifyAfter != null && notifyAfter !== settings.notifyAfterSeconds;
      // Only hit the server when something server-side actually changed.
      if (
        settings &&
        (pathChanged || timeoutChanged || autoLockChanged || notifyChanged || notifyAfterChanged)
      ) {
        const result = await api.updateSettings({
          vaultFilePath: trimmed,
          queryTimeoutSeconds: parsedTimeout,
          autoLockMinutes: parsedAutoLock,
          notifyOnQueryFinish: pendingNotify,
          notifyAfterSeconds: notifyAfter,
        });
        applyValidation(result);
      }
      onClose();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  const isDirty =
    settings !== null &&
    (inputPath.trim() !== settings.vaultFilePath ||
      pendingPersistTabs !== persistTabs ||
      parsedTimeout !== settings.queryTimeoutSeconds ||
      parsedAutoLock !== settings.autoLockMinutes ||
      pendingNotify !== settings.notifyOnQueryFinish ||
      (pendingNotify && notifyAfterValid && parsedNotifyAfter !== settings.notifyAfterSeconds));
  const canSave =
    pathValid &&
    timeoutValid &&
    autoLockValid &&
    notifyAfterValid &&
    !saving &&
    status.state !== 'validating';

  // Save is dialog-wide, so a bad value in a pane you are not looking at still blocks it.
  // The rail carries the marker back to the pane that owns the problem.
  const invalidSections: Partial<Record<SettingsSection, boolean>> = {
    general: !timeoutValid,
    notifications: !notifyAfterValid,
    security: !pathValid || !autoLockValid,
  };

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface rounded-lg shadow-2xl w-[720px] border border-surface-3 flex overflow-hidden">
        {/* Left rail */}
        <nav className="w-[184px] flex-shrink-0 bg-surface-1 border-r border-surface-2 py-5 px-3 flex flex-col gap-0.5">
          <div className="px-2 pb-3.5">
            <h2 className="text-[15px] font-semibold text-text m-0 mb-0.5">Settings</h2>
            <p className="text-[11px] text-text-dim m-0">Application preferences</p>
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`flex items-center gap-2 text-[13px] rounded-md px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                section === s.id
                  ? 'text-text bg-accent/15'
                  : 'text-text-muted hover:text-text hover:bg-accent/5'
              }`}
              onClick={() => setSection(s.id)}
            >
              <span className="flex-1 min-w-0 truncate">{s.label}</span>
              {invalidSections[s.id] && (
                <span className="text-warning text-[11px] flex-shrink-0" title="Needs attention">
                  ⚠
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-6 pt-5">
            <h3 className="text-sm font-semibold text-text m-0 mb-0.5">{current.title}</h3>
            <p className="text-xs text-text-dim m-0">{current.description}</p>
          </div>

          {/* Fixed height so switching sections doesn't make the dialog jump around. Sized to
              clear the tallest pane (Security) without scrolling on a normal window. */}
          <div className="h-[min(480px,60vh)] px-6 pt-5 flex flex-col min-h-0">
            {section === 'general' && (
              <div className="space-y-5 overflow-y-auto pr-1">
                {/* Restore open tabs */}
                <div>
                  <span className="text-xs text-text-muted uppercase tracking-wide">
                    Session
                  </span>
                  <label className="flex items-start gap-2.5 mt-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent w-4 h-4 cursor-pointer"
                      checked={pendingPersistTabs}
                      onChange={(e) => setPendingPersistTabs(e.target.checked)}
                    />
                    <span>
                      <span className="text-sm text-text">Restore open tabs on launch</span>
                      <span className="block text-xs text-text-dim mt-0.5">
                        Remember which tabs were open and reopen them next time you start the app.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="h-px bg-surface-2" />

                {/* Query timeout */}
                <div>
                  <span className="text-xs text-text-muted uppercase tracking-wide">
                    Query timeout
                  </span>
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      step={1}
                      className="input font-mono text-xs w-24"
                      value={timeoutInput}
                      onChange={(e) => setTimeoutInput(e.target.value)}
                    />
                    <span className="text-sm text-text-dim">seconds</span>
                  </div>
                  {!timeoutValid && (
                    <p className="text-xs text-warning mt-1.5">
                      ⚠ Enter a whole number between 0 and 3600
                    </p>
                  )}
                  <p className="text-xs text-text-dim mt-2">
                    Queries running longer than this are cancelled automatically. Use 0 for no
                    limit.
                  </p>
                </div>

              </div>
            )}

            {section === 'notifications' && (
              <div className="space-y-5 overflow-y-auto pr-1">
                {/* When to notify */}
                <div>
                  <span className="text-xs text-text-muted uppercase tracking-wide">
                    When to notify
                  </span>
                  <label className="flex items-start gap-2.5 mt-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent w-4 h-4 cursor-pointer"
                      checked={pendingNotify}
                      onChange={(e) => setPendingNotify(e.target.checked)}
                    />
                    <span>
                      <span className="text-sm text-text">Notify me when a query finishes</span>
                      <span className="block text-xs text-text-dim mt-0.5">
                        A system notification when Downpick is in the background, an in-app
                        notice when it is not. A query you cancelled, or one the database
                        rejected, is not announced — you are already looking at it.
                      </span>
                    </span>
                  </label>

                  <div className="flex items-center gap-2 mt-3">
                    <span className="text-sm text-text-dim">Only after</span>
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      step={1}
                      className="input font-mono text-xs w-24"
                      value={notifyAfterInput}
                      disabled={!pendingNotify}
                      onChange={(e) => setNotifyAfterInput(e.target.value)}
                    />
                    <span className="text-sm text-text-dim">seconds</span>
                  </div>
                  {!notifyAfterValid && (
                    <p className="text-xs text-warning mt-1.5">
                      ⚠ Enter a whole number between 0 and 3600
                    </p>
                  )}
                  <p className="text-xs text-text-dim mt-2">
                    Anything that finishes sooner is not announced. Use 0 to announce every
                    query. A query stopped by the query timeout in General is always
                    announced, however quickly it fired.
                  </p>
                </div>

                <div className="h-px bg-surface-2" />

                {/* System permission */}
                <div>
                  <span className="text-xs text-text-muted uppercase tracking-wide">
                    System permission
                  </span>
                  <p className="text-xs text-text-dim mt-2 mb-0">
                    {OS_NOTIFICATION_SETTINGS} has to allow notifications from Downpick as
                    well. Downpick cannot tell whether it does — a blocked notification is
                    turned away without an error, which is what this button is for.
                  </p>
                  <div className="flex items-center gap-2.5 mt-2.5">
                    {/* Never shrink: the note beside it grows, and squeezing the button
                        wraps its label onto a second line. */}
                    <button
                      className="btn-ghost flex-shrink-0 whitespace-nowrap"
                      onClick={() => void sendTestNotification()}
                      disabled={testStatus === 'sending'}
                    >
                      Send a test notification
                    </button>
                    <TestStatusNote status={testStatus} />
                  </div>
                </div>
              </div>
            )}

            {section === 'security' && (
              <div className="space-y-5 overflow-y-auto pr-1">
                {/* Vault file path */}
                <div>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-xs text-text-muted uppercase tracking-wide">
                      Vault file path
                    </span>
                    <div className="flex items-baseline gap-3">
                      <button
                        className="text-xs text-accent hover:text-accent-hover"
                        onClick={() => void browseForVault('open')}
                      >
                        Browse…
                      </button>
                      <button
                        className="text-xs text-accent hover:text-accent-hover"
                        onClick={() => void browseForVault('create')}
                      >
                        New location…
                      </button>
                      {settings && inputPath !== settings.defaultVaultPath && (
                        <button
                          className="text-xs text-accent hover:text-accent-hover"
                          onClick={resetToDefault}
                        >
                          Reset to default
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    className="input font-mono text-xs"
                    value={inputPath}
                    onChange={(e) => handlePathChange(e.target.value)}
                    placeholder={settings?.defaultVaultPath ?? '~/.downpick/vault.enc'}
                    spellCheck={false}
                  />
                  <StatusBadge status={status} />
                  <p className="text-xs text-text-dim mt-2">
                    Encrypted file holding your connections, their passwords, and API keys.
                    Path must include the filename. Changing it locks the current vault — the
                    file at the new path has its own master password.
                  </p>
                </div>

                <div className="h-px bg-surface-2" />

                {/* Master password */}
                <div>
                  <span className="text-xs text-text-muted uppercase tracking-wide">
                    Master password
                  </span>
                  <div className="mt-2">
                    <button className="btn-ghost text-xs" onClick={onChangeMasterPassword}>
                      Change master password…
                    </button>
                  </div>
                  <p className="text-xs text-text-dim mt-2">
                    Re-encrypts the vault key under a new password and deletes the previous
                    backup file, which is still readable with the old password.
                  </p>
                </div>

                <div className="h-px bg-surface-2" />

                {/* Auto-lock */}
                <div>
                  <span className="text-xs text-text-muted uppercase tracking-wide">
                    Auto-lock
                  </span>
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="number"
                      min={0}
                      max={1440}
                      step={1}
                      className="input font-mono text-xs w-24"
                      value={autoLockInput}
                      onChange={(e) => setAutoLockInput(e.target.value)}
                    />
                    <span className="text-sm text-text-dim">minutes idle</span>
                  </div>
                  {!autoLockValid && (
                    <p className="text-xs text-warning mt-1.5">
                      ⚠ Enter a whole number between 0 and 1440
                    </p>
                  )}
                  <p className="text-xs text-text-dim mt-2">
                    Re-locks the vault and closes every open database connection after this much
                    inactivity. Use 0 to never auto-lock.
                  </p>
                </div>
              </div>
            )}

            {section === 'ai' && <AiProviderSettings />}
          </div>

          {saveError && section !== 'ai' && (
            <p className="mx-6 mt-4 text-sm text-error bg-error/10 rounded px-3 py-2">
              {saveError}
            </p>
          )}

          {/* Pinned footer, so Save never scrolls out of reach. The AI section writes each
              change as it is made — an API key half-entered in React state waiting on a Save
              click is worse than committing it on confirm — so it gets a plain Close instead
              of the Cancel/Save pair. */}
          <div className="flex justify-end gap-2 px-6 py-5 border-t border-surface-2">
            {section === 'ai' ? (
              <button className="btn-ghost" onClick={onClose}>
                Close
              </button>
            ) : (
              <>
                <button className="btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  className="btn-primary disabled:opacity-50"
                  onClick={handleSave}
                  disabled={!canSave || !isDirty}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

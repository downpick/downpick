import React, { useEffect, useState } from 'react';
import { api } from '../api';

export const MIN_MASTER_PASSWORD_LENGTH = 12;

export type VaultMode = 'choose' | 'setup' | 'unlock' | 'change';

interface Props {
  mode: VaultMode;
  /** The vault the app is currently pointed at. Prefills the path field and names the file. */
  vaultPath?: string;
  onDone: () => void;
  /** Only offered for 'change' — the first-run and unlock steps are gates, not dismissible dialogs. */
  onCancel?: () => void;
}

const COPY: Record<VaultMode, { title: string; blurb: string; submit: string }> = {
  choose: {
    title: 'Set up your vault',
    blurb:
      'Downpick keeps your database passwords and AI provider keys in one encrypted file. Open a vault you already have, or create a new one.',
    submit: '',
  },
  setup: {
    title: 'Create your master password',
    blurb:
      'Everything Downpick stores — database passwords and AI provider keys — is encrypted with this password.',
    submit: 'Create vault',
  },
  unlock: {
    title: 'Unlock your vault',
    blurb: 'Enter your master password to decrypt your saved connections.',
    submit: 'Unlock',
  },
  change: {
    title: 'Change master password',
    blurb: 'Your data is re-encrypted under the new password. Existing backups are removed.',
    submit: 'Change password',
  },
};

/**
 * The vault gate, and the one dialog behind Settings' "Change master password".
 *
 * `mode` is the step it opens on; the step it is *showing* is local state, so the first-run
 * screens can move between choosing a file, creating one, and unlocking it without the shell
 * re-deciding. The chosen path travels with the setup and unlock calls rather than through
 * `settings:update`, which is behind the vault gate and so unreachable before a vault is open.
 */
export function VaultDialog({ mode, vaultPath, onDone, onCancel }: Props) {
  const [step, setStep] = useState<VaultMode>(mode);
  /** The working path: what setup will create, or what unlock will open. */
  const [path, setPath] = useState(vaultPath ?? '');
  /** What settings.json actually points at, so the first screen reports it and not a draft. */
  const [configured, setConfigured] = useState(vaultPath ?? '');
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `settings:get` answers while locked, which is the whole reason the default path is
  // available to a screen that runs before any vault exists.
  useEffect(() => {
    if (mode === 'change') return;
    api
      .getSettings()
      .then((settings) => {
        setDefaultPath(settings.defaultVaultPath);
        setConfigured(settings.vaultFilePath);
        setPath((previous) => previous || settings.vaultFilePath);
      })
      .catch(() => {});
  }, [mode]);

  /** Moves between steps, dropping anything typed into the step being left. */
  function goTo(next: VaultMode) {
    if (next === 'choose') setPath(configured);
    setStep(next);
    setCurrent('');
    setPassword('');
    setConfirm('');
    setError(null);
  }

  async function browse(dialogMode: 'open' | 'create') {
    setError(null);
    try {
      const result = await api.pickVaultFile({ mode: dialogMode, defaultPath: path || undefined });
      if (result.canceled || !result.path) return;

      // Creating: the file does not exist yet, so there is nothing to validate. The path lands
      // in the field the user can still edit by hand.
      if (dialogMode === 'create') {
        setPath(result.path);
        return;
      }
      if (!result.fileExists) {
        setError('That file no longer exists.');
        return;
      }
      if (!result.valid) {
        setError(result.error ?? 'That file is not a Downpick vault.');
        return;
      }
      setPath(result.path);
      goTo('unlock');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'The file dialog could not be opened.');
    }
  }

  const needsConfirm = step === 'setup' || step === 'change';
  const tooShort = needsConfirm && password.length > 0 && password.length < MIN_MASTER_PASSWORD_LENGTH;
  const mismatch = needsConfirm && confirm.length > 0 && confirm !== password;

  const canSubmit =
    !busy &&
    password.length > 0 &&
    (!needsConfirm || (password.length >= MIN_MASTER_PASSWORD_LENGTH && confirm === password)) &&
    (step !== 'change' || current.length > 0) &&
    (step !== 'setup' || path.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (step === 'setup') {
        await api.vaultSetup(password, path.trim());
        onDone();
      } else if (step === 'unlock') {
        await api.vaultUnlock(password, path.trim() || undefined);
        onDone();
      } else {
        await api.vaultChangePassword(current, password);
        onDone();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[step];
  const errorBox = error ? (
    <p className="text-sm text-error bg-error/10 rounded px-3 py-2">{error}</p>
  ) : null;

  if (step === 'choose') {
    return (
      <Shell dismissible={false} wide>
        <h2 className="text-lg font-semibold text-text mb-1">
          {mode === 'unlock' ? 'Choose a vault file' : copy.title}
        </h2>
        <p className="text-xs text-text-dim mb-5">{copy.blurb}</p>

        <div className="space-y-2">
          <Choice
            title="Open an existing vault…"
            detail="Pick a vault file from a backup, an encrypted volume, or another machine."
            onClick={() => void browse('open')}
          />
          <Choice
            title="Create a new vault"
            detail="Choose where it lives and set a master password."
            onClick={() => goTo('setup')}
          />
        </div>

        {error && <div className="mt-4">{errorBox}</div>}

        {configured && (
          <p className="text-xs text-text-dim mt-5">
            Currently configured: <span className="font-mono break-all">{configured}</span>
          </p>
        )}

        {mode === 'unlock' && (
          <div className="flex justify-end pt-4">
            <button type="button" className="btn-ghost" onClick={() => goTo('unlock')}>
              Cancel
            </button>
          </div>
        )}
      </Shell>
    );
  }

  return (
    <Shell dismissible={step === 'change'} onDismiss={onCancel} wide={step === 'setup'}>
      <h2 className="text-lg font-semibold text-text mb-1">{copy.title}</h2>
      <p className="text-xs text-text-dim mb-5">{copy.blurb}</p>

      {step === 'setup' && (
        <p className="text-xs text-warning bg-warning/10 rounded px-3 py-2 mb-4">
          There is no recovery. If you forget this password, the saved credentials cannot be
          decrypted by anyone — including you.
        </p>
      )}

      {step === 'unlock' && path && (
        <p className="text-xs text-text-dim -mt-3 mb-4 font-mono break-all">{path}</p>
      )}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        {step === 'setup' && (
          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wide">Vault file</span>
            <div className="flex gap-2 mt-1">
              <input
                className="input font-mono text-xs"
                value={path}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setPath(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost whitespace-nowrap"
                onClick={() => void browse('create')}
              >
                Browse…
              </button>
            </div>
            <span className="block text-xs text-text-dim mt-1">
              Include the filename.{' '}
              {defaultPath && path.trim() !== defaultPath && (
                <button
                  type="button"
                  className="underline hover:text-text"
                  onClick={() => setPath(defaultPath)}
                >
                  Reset to default
                </button>
              )}
            </span>
          </label>
        )}

        {step === 'change' && (
          <Field
            label="Current master password"
            value={current}
            onChange={setCurrent}
            autoFocus
          />
        )}
        <Field
          label={needsConfirm ? 'New master password' : 'Master password'}
          value={password}
          onChange={setPassword}
          autoFocus={step !== 'change'}
          hint={
            needsConfirm ? `At least ${MIN_MASTER_PASSWORD_LENGTH} characters.` : undefined
          }
          warning={tooShort ? `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters.` : undefined}
        />
        {needsConfirm && (
          <Field
            label="Confirm"
            value={confirm}
            onChange={setConfirm}
            warning={mismatch ? 'The two passwords do not match.' : undefined}
          />
        )}

        {errorBox}

        <div className="flex items-center pt-2">
          {step !== 'change' && (
            <button
              type="button"
              className="text-xs text-text-dim underline hover:text-text"
              onClick={() => goTo('choose')}
            >
              {step === 'setup' ? 'Back' : 'Use a different vault file…'}
            </button>
          )}
          <div className="flex justify-end gap-2 ml-auto">
            {step === 'change' && onCancel && (
              <button type="button" className="btn-ghost" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn-primary disabled:opacity-50" disabled={!canSubmit}>
              {busy ? 'Working…' : copy.submit}
            </button>
          </div>
        </div>
      </form>
    </Shell>
  );
}

function Shell({
  children,
  dismissible,
  onDismiss,
  wide,
}: {
  children: React.ReactNode;
  dismissible: boolean;
  onDismiss?: () => void;
  /** The steps that show a filesystem path need the room to show it unwrapped. */
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onMouseDown={dismissible ? onDismiss : undefined}
    >
      <div
        className={`bg-surface rounded-lg shadow-2xl ${wide ? 'w-[540px]' : 'w-[440px]'} p-6 border border-surface-3`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** One of the two doors on the first-run screen. */
function Choice({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="block w-full text-left rounded border border-surface-3 bg-surface-2 hover:border-accent px-4 py-3 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <span className="block text-sm text-text">{title}</span>
      <span className="block text-xs text-text-dim mt-0.5">{detail}</span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  autoFocus,
  hint,
  warning,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  hint?: string;
  warning?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-text-muted uppercase tracking-wide">{label}</span>
      <input
        type="password"
        className="input mt-1"
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {warning ? (
        <span className="block text-xs text-warning mt-1">⚠ {warning}</span>
      ) : hint ? (
        <span className="block text-xs text-text-dim mt-1">{hint}</span>
      ) : null}
    </label>
  );
}

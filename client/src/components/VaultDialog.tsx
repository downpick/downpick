import React, { useEffect, useState } from 'react';
import { api } from '../api';

export const MIN_MASTER_PASSWORD_LENGTH = 12;

export type VaultMode = 'setup' | 'unlock' | 'change';

interface Props {
  mode: VaultMode;
  onDone: () => void;
  /** Only offered for 'change' — setup and unlock are gates, not dismissible dialogs. */
  onCancel?: () => void;
}

const COPY: Record<VaultMode, { title: string; blurb: string; submit: string }> = {
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

export function VaultDialog({ mode, onDone, onCancel }: Props) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [mode]);

  const needsConfirm = mode === 'setup' || mode === 'change';
  const tooShort = needsConfirm && password.length > 0 && password.length < MIN_MASTER_PASSWORD_LENGTH;
  const mismatch = needsConfirm && confirm.length > 0 && confirm !== password;

  const canSubmit =
    !busy &&
    password.length > 0 &&
    (!needsConfirm || (password.length >= MIN_MASTER_PASSWORD_LENGTH && confirm === password)) &&
    (mode !== 'change' || current.length > 0);

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') {
        await api.vaultSetup(password);
        onDone();
      } else if (mode === 'unlock') {
        await api.vaultUnlock(password);
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

  const copy = COPY[mode];

  return (
    <Shell dismissible={mode === 'change'} onDismiss={onCancel}>
      <h2 className="text-lg font-semibold text-text mb-1">{copy.title}</h2>
      <p className="text-xs text-text-dim mb-5">{copy.blurb}</p>

      {mode === 'setup' && (
        <p className="text-xs text-warning bg-warning/10 rounded px-3 py-2 mb-4">
          There is no recovery. If you forget this password, the saved credentials cannot be
          decrypted by anyone — including you.
        </p>
      )}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        {mode === 'change' && (
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
          autoFocus={mode !== 'change'}
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

        {error && <p className="text-sm text-error bg-error/10 rounded px-3 py-2">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          {mode === 'change' && onCancel && (
            <button type="button" className="btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn-primary disabled:opacity-50" disabled={!canSubmit}>
            {busy ? 'Working…' : copy.submit}
          </button>
        </div>
      </form>
    </Shell>
  );
}

function Shell({
  children,
  dismissible,
  onDismiss,
}: {
  children: React.ReactNode;
  dismissible: boolean;
  onDismiss?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onMouseDown={dismissible ? onDismiss : undefined}
    >
      <div
        className="bg-surface rounded-lg shadow-2xl w-[440px] p-6 border border-surface-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
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

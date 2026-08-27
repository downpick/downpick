import { useState } from 'react';
import { useStore, DbType, SavedConnection } from '../store';
import { api, TestConnectionResult } from '../api';

interface ConnectionFormData {
  name: string;
  type: DbType;
  host: string;
  port: string;
  /** Oracle only. Kept in the form for every type so `field()` can clear it on a type change. */
  serviceName: string;
  username: string;
  password: string;
}

const defaultForm = (): ConnectionFormData => ({
  name: '',
  type: 'postgres',
  host: 'localhost',
  port: '5432',
  serviceName: '',
  username: '',
  password: '',
});

export function ConnectionDialog({
  onClose,
  connection,
}: {
  onClose: () => void;
  connection?: SavedConnection;
}) {
  const isEdit = !!connection;
  const [form, setForm] = useState<ConnectionFormData>(
    connection
      ? {
          name: connection.name,
          type: connection.type,
          host: connection.host,
          port: String(connection.port),
          serviceName: connection.serviceName ?? '',
          username: connection.username,
          password: '',
        }
      : defaultForm(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const savedConnections = useStore((s) => s.savedConnections);
  const { setSavedConnections } = useStore.getState();

  const DEFAULT_PORTS: Record<DbType, string> = {
    postgres: '5432',
    sqlserver: '1433',
    mongodb: '27017',
    oracle: '1521',
  };

  function field(key: keyof ConnectionFormData, value: string) {
    // Any edit invalidates a previous test — the result no longer describes the form.
    setTestResult(null);
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === 'type') {
        next.port = DEFAULT_PORTS[value as DbType];
        // Clear the Oracle-only field alongside the port. Without this, a service name typed
        // under Oracle survives a switch to Postgres and gets persisted on a record that has no
        // use for it.
        if (value !== 'oracle') next.serviceName = '';
      }
      return next;
    });
  }

  async function handleTest() {
    const port = parseInt(form.port, 10);
    if (!form.host || !Number.isFinite(port)) {
      setError('Host and port are required to test the connection.');
      return;
    }
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await api.testConnection({
        // On edit, let the server fall back to the stored password when the field is blank
        ...(connection ? { id: connection.id } : {}),
        ...(form.type === 'oracle' ? { serviceName: form.serviceName } : {}),
        type: form.type,
        host: form.host,
        port,
        username: form.username,
        ...(form.password ? { password: form.password } : {}),
      });
      setTestResult(result);
    } catch (e: unknown) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : 'Test failed',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    // MongoDB commonly runs without authentication locally, so username isn't required for it.
    const usernameRequired = form.type !== 'mongodb';
    if (!form.name || !form.host || (usernameRequired && !form.username)) {
      setError(
        usernameRequired
          ? 'Name, host, and username are required.'
          : 'Name and host are required.',
      );
      return;
    }
    // Optional on the record because three engines have no use for it, but there is no Oracle
    // connection without one — it is part of the address, not a preference.
    if (form.type === 'oracle' && !form.serviceName) {
      setError('Service name is required for Oracle connections.');
      return;
    }
    setSaving(true);
    setError(null);
    const port = parseInt(form.port, 10);
    try {
      if (connection) {
        await api.updateConnection(connection.id, {
          name: form.name,
          type: form.type,
          host: form.host,
          port,
          serviceName: form.type === 'oracle' ? form.serviceName : undefined,
          username: form.username,
          // Only send a password when the user typed a new one
          ...(form.password ? { password: form.password } : {}),
        });
        // Built locally rather than refetched, so the field has to be set here too or the tree
        // holds a record without it until the next listConnections().
        const updated: SavedConnection = {
          id: connection.id,
          name: form.name,
          type: form.type,
          host: form.host,
          port,
          serviceName: form.type === 'oracle' ? form.serviceName : undefined,
          username: form.username,
        };
        setSavedConnections(
          savedConnections.map((c) => (c.id === connection.id ? updated : c)),
        );
      } else {
        const { id } = await api.createConnection({
          name: form.name,
          type: form.type,
          host: form.host,
          port,
          serviceName: form.type === 'oracle' ? form.serviceName : undefined,
          username: form.username,
          password: form.password,
        });
        const newConn: SavedConnection = {
          id,
          name: form.name,
          type: form.type,
          host: form.host,
          port,
          serviceName: form.type === 'oracle' ? form.serviceName : undefined,
          username: form.username,
        };
        setSavedConnections([...savedConnections, newConn]);
      }
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save connection');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface rounded-lg shadow-2xl w-[480px] p-6 border border-surface-3">
        <h2 className="text-lg font-semibold text-text mb-5">
          {isEdit ? 'Edit Connection' : 'New Connection'}
        </h2>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wide">Display Name</span>
            <input
              className="input mt-1"
              placeholder="My Server"
              value={form.name}
              onChange={(e) => field('name', e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wide">Type</span>
            <select
              className="input mt-1"
              value={form.type}
              onChange={(e) => field('type', e.target.value as DbType)}
            >
              <option value="postgres">PostgreSQL</option>
              <option value="sqlserver">SQL Server</option>
              <option value="oracle">Oracle</option>
              <option value="mongodb">MongoDB</option>
            </select>
          </label>

          <div className="grid grid-cols-3 gap-3">
            <label className="col-span-2 block">
              <span className="text-xs text-text-muted uppercase tracking-wide">Host</span>
              <input
                className="input mt-1"
                placeholder="localhost"
                value={form.host}
                onChange={(e) => field('host', e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-text-muted uppercase tracking-wide">Port</span>
              <input
                className="input mt-1"
                placeholder="5432"
                value={form.port}
                onChange={(e) => field('port', e.target.value)}
              />
            </label>
          </div>

          {/*
            The only per-type field in this form. Oracle is the one engine that cannot enumerate
            its databases — the service is part of the address — so it has to be asked for.
            Deliberately left blank rather than pre-filled with a guess: a wrong service produces
            ORA-12514, which connectionErrors.ts now explains and points back at this field.
          */}
          {form.type === 'oracle' && (
            <label className="block">
              <span className="text-xs text-text-muted uppercase tracking-wide">Service Name</span>
              <input
                className="input mt-1"
                placeholder="ORCLPDB1 / XEPDB1 / FREEPDB1"
                value={form.serviceName}
                onChange={(e) => field('serviceName', e.target.value)}
              />
              <p className="text-xs text-text-dim mt-1">
                The service the listener serves — not the SID. `lsnrctl status` on the server
                lists them.
              </p>
            </label>
          )}

          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wide">
              Username{form.type === 'mongodb' && ' (optional)'}
            </span>
            <input
              className="input mt-1"
              placeholder="postgres"
              value={form.username}
              onChange={(e) => field('username', e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wide">
              Password{form.type === 'mongodb' && ' (optional)'}
            </span>
            <input
              type="password"
              className="input mt-1"
              value={form.password}
              onChange={(e) => field('password', e.target.value)}
            />
            <p className="text-xs text-text-dim mt-1">
              {isEdit
                ? 'Leave blank to keep the current password'
                : form.type === 'mongodb'
                  ? 'Leave blank if the server requires no authentication. Stored in your encrypted vault.'
                  : 'Stored in your encrypted vault'}
            </p>
          </label>
        </div>

        {error && (
          <p className="mt-3 text-sm text-error bg-error/10 rounded px-3 py-2">{error}</p>
        )}

        {testResult && (
          <p
            className={`mt-3 text-sm rounded px-3 py-2 break-words ${
              testResult.ok ? 'text-success bg-success/10' : 'text-error bg-error/10'
            }`}
          >
            {testResult.ok
              ? `Connection successful${
                  testResult.elapsedMs != null ? ` (${testResult.elapsedMs} ms)` : ''
                }`
              : `Connection failed: ${testResult.error ?? 'Unknown error'}`}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 mt-6">
          <button className="btn-ghost" onClick={handleTest} disabled={testing || saving}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleSave} disabled={saving || testing}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Connection'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

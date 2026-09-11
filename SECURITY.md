# Security

How Downpick protects your credentials, and — just as importantly — what it does not protect
against.

## The vault

Everything sensitive — connection metadata, database passwords, and AI provider API keys — lives
in a single encrypted file, `~/.downpick/vault.enc` by default, created with mode `0600` inside a
`0700` directory. On first launch you can open a vault you already have instead, or place the new
one somewhere else — a removable disk or an encrypted volume; the path is remembered in
`~/.downpick/settings.json`, which holds no secrets. It is only written there once a vault at that
path has actually been created or unlocked, so a mistyped path or a file that turns out not to be a
vault never survives a restart.

- A master password is stretched with **scrypt** (N=2^17, r=8, p=1) into a key-encryption key.
- That key wraps a random data key with **AES-256-GCM**; the data key encrypts the payload.
  Changing your master password rewraps 32 bytes rather than re-encrypting everything.
- The envelope header is authenticated, and its KDF parameters are validated against a strict
  policy *before* any key derivation runs — so a tampered file cannot make the app burn minutes
  of CPU on absurd parameters before the check fails.
- A wrong password is detected by GCM authentication failure. A separate checksum distinguishes
  "wrong password" from "damaged file", so a truncated vault doesn't send you hunting for a
  password that was right all along.
- Writes are atomic (same-directory temp file → fsync → rename) and serialized through a mutex,
  and the previous version is kept as `vault.enc.bak`.

**There is no recovery.** If you forget the master password, nothing in the vault can be
decrypted — by you or anyone else.

## Locking

The vault starts locked on every launch, and every channel outside `vault:*`, `settings:get`, and
the two native file dialogs is refused until you unlock it. Locking — manually via the **Vault unlocked** button at the left
end of the status bar (or `Ctrl+L` / `Cmd+L`), or by idle timeout — also closes every open
database connection, so nothing stays reachable behind a locked vault.

Note that locking does not clear query results already rendered in the window.

## Process isolation

Downpick exposes no database or vault HTTP API. Earlier versions served the UI through a
loopback web server; the UI now uses Electron's custom protocol and IPC. On macOS only,
`electron-updater` temporarily serves the downloaded update ZIP over an authenticated loopback
HTTP endpoint for Squirrel.Mac. That endpoint has no database or vault handlers. What protects
the app now:

- The renderer runs fully sandboxed: `sandbox`, `contextIsolation`, and no `nodeIntegration`, so
  `require` and `process` simply do not exist in the page.
- Its only way out is the channel list in `server/channels.ts`, exposed through a preload script
  via `contextBridge`. Every call passes one dispatcher that checks the channel against that
  allowlist and refuses everything outside `vault:*`, `settings:get`, and the native file dialogs
  while the vault is locked. `settings:validate` deliberately stays behind that gate so it cannot
  be used to probe the filesystem; the unlock screen learns whether a chosen file is a vault from
  `files:pickVault`, which can only answer about a path the user picked in the OS dialog itself.
- The UI is served from a custom `app://` protocol whose handler resolves each request inside
  `client/dist` and rejects anything that escapes it, percent-encoded traversals included.
- A strict CSP (no `unsafe-eval`, no inline script, `connect-src 'none'`, `frame-ancestors 'none'`)
  is set on every response, alongside `nosniff`. The renderer makes no network requests at all;
  every byte that leaves the machine is sent by the main process.
- Navigation is pinned to the app's own origin, `window.open` is denied, `<webview>` is disabled,
  and every permission request is refused.
- Credentials embedded in driver connection URIs are scrubbed from error messages and logs.

The `--dev-server` flag that points the app at Vite is ignored in a packaged build, so a shipped
app cannot be aimed at another origin — nor inherit the relaxed dev CSP that comes with it.

## Application updates

The main process checks public GitHub Releases and downloads update artifacts over HTTPS.
These requests contain no vault credentials, queries, results, or AI conversations; the service
can observe ordinary connection information such as the client's IP address. No GitHub access
token is packaged with the app.

`electron-updater` validates artifact checksums and uses platform signature validation where
configured. Mac automatic updates require a Developer ID-signed build; ad-hoc builds offer a
manual download instead. Windows release signing should preserve the same publisher identity.
Neither signature checks nor TLS verification are disabled by the app.

Update controls live in the native application menu and do not add renderer IPC capabilities.
Downloaded updates require an explicit restart action, which is refused while queries are
running. Before installation, Downpick locks the vault and closes its connections through the
normal shutdown path.

## What this does not protect against

Worth stating plainly:

- **Another process running as you.** It can attach a debugger to the unlocked main process and
  lift the data key out of memory, or replace the app's code on disk.
- **Secrets in the JS heap.** The master password arrives as a string, and strings are immutable
  in V8 — they cannot be zeroed. The database drivers also hold passwords in their pool config
  for the life of a connection.
- **Query text.** Open tabs are persisted to the app's own `localStorage` in plaintext, unaffected
  by locking. Turn off "Restore open tabs on launch" in Settings if your queries contain secrets.
- **Ask AI transcripts.** Past conversations are saved unencrypted to `~/.downpick/chats.db`
  (mode `0600` inside the `0700` directory), unaffected by locking. They hold your questions, the
  queries the assistant wrote, and the schema names it looked up along the way. **Clear all
  history** in the Ask AI panel's history list deletes them.
- **A swapped-in vault file.** GCM detects tampering within a file, not the substitution of a
  whole different one.
- **What Ask AI sends out.** Using it hands your schema *names* to a third-party API, and — when
  the assistant asks for it — the query open in the tab, which unlike a schema name can contain
  literals you typed. The [Ask AI section of the README](README.md#ask-ai) covers exactly what
  leaves the machine.

Schema names are also model *input*, so a table or column named to look like an instruction could
in principle influence Ask AI's answer. The same goes for the query text the assistant reads back
out of your editor, though that one you wrote yourself. Both are contained by design rather than
by filtering: nothing the model writes is executed, and you read the query before running it.

## Reporting a vulnerability

Open a [security advisory](https://github.com/downpick/downpick/security/advisories/new) rather
than a public issue.

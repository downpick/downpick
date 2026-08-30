# IPC Reference

Every call the UI makes goes through one `ipcMain.handle`, which forwards to the dispatcher in
`server/dispatch.ts`. Channel names are declared in `server/channels.ts` — that file is the source
of truth, and anything not on its list is rejected. Everything except `vault:*`, `settings:get`,
`files:save`, and `files:pickVault` is refused while the vault is locked. No reply ever contains a
stored password or API key.

## Channels

| Channel | Description |
|---------|-------------|
| `vault:status` | Whether a vault exists and whether it is locked |
| `vault:setup` | Create the vault. Optional `vaultFilePath` picks where, for the first-run screen |
| `vault:unlock` | Unlock with the master password. Optional `vaultFilePath` opens a different vault |
| `vault:lock` | Lock the vault and close every open database connection |
| `vault:changePassword` | Rewrap the vault key under a new master password |
| `connections:list` | List saved connections |
| `connections:create` | Create a new connection profile |
| `connections:update` | Update a connection profile |
| `connections:delete` | Delete a connection profile |
| `connections:test` | Try a set of credentials without saving them |
| `connections:connect` | Open a live server session, returns its databases |
| `connections:disconnect` | Close a live server session and its open databases |
| `connections:openDb` | Open a specific database, returns its schema tree |
| `query:run` | Execute a query (SQL, or MongoDB shell-style syntax); results capped at 10,000 rows |
| `query:cancel` | Cancel an in-flight query by its queryId |
| `schema:get` | Fetch the schema tree for an open database |
| `settings:get` | Get current settings + vault file validation |
| `settings:update` | Update settings (vault file path, query timeout, auto-lock, notifications) |
| `settings:validate` | Validate a candidate vault file path |
| `ai:providers:list` | The provider catalog plus configured providers, never their keys |
| `ai:providers:add` | Add a provider and its API key |
| `ai:providers:models` | Ask a provider which models the key can use (best-effort) |
| `ai:providers:update` | Rename a provider, toggle its models, or replace its key |
| `ai:providers:delete` | Remove a provider, and its key with it |
| `ai:chat:start` | Ask a question. Returns a `streamId`; the answer arrives as events |
| `ai:chat:cancel` | Abort a running answer by its `streamId` |
| `ai:history:list` | Page through saved Ask AI conversations, newest first |
| `ai:history:get` | Load one saved conversation's full transcript |
| `ai:history:save` | Upsert a conversation and replace its transcript |
| `ai:history:delete` | Delete one saved conversation and its messages |
| `ai:history:clear` | Delete every saved conversation |
| `files:save` | Show the native save dialog and write a file (CSV/XLSX export) |
| `files:pickVault` | Show the native file dialog to open or place a vault file, and validate what came back |
| `clipboard:write` | Put a result set on the system clipboard, as HTML and as plain text |
| `notify:queryFinished` | Report a finished query. Main decides whether to show a native notification, ask the renderer for an in-app one, or stay quiet |

## Events

Three channels push the other way, from main to the renderer:

| Event | Description |
|-------|-------------|
| `ai:chat:event` | One `step`, `message`, or `error` from a running answer, tagged with its `streamId` |
| `menu:command` | An application-menu item was activated (run/cancel/format query, lock vault) |
| `notification:activate` | A native query notification was clicked; carries the `tabId` to bring forward |

## Reply envelopes

Replies are envelopes — `{ ok: true, data }` or `{ ok: false, status, error }` — rather than
resolved/rejected promises, because Electron rewrites a thrown error's message into
"Error invoking remote method …" and would bury the messages this app works to make actionable.
The status codes are HTTP-shaped by inheritance: the UI still branches on `423` to raise the
unlock dialog.

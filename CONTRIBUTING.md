# Contributing

## Architecture

Downpick is an Electron app in two halves:

- **Main process** (`electron/`, `server/`) — owns the encrypted vault, the database drivers, and
  every outbound network call. This is the only part with filesystem or socket access.
- **Renderer** (`client/`) — the React UI, running fully sandboxed with no Node access at all.

They talk over a single context-isolated IPC channel. `server/channels.ts` declares that contract
and is imported by both sides, so a channel renamed in one place stops compiling in the other.
See [docs/ipc.md](docs/ipc.md) for the channel list.

## Requirements

- Node.js 20+ (Node 21+ for `npm test`, which relies on glob support in `node --test`)
- npm 9+

## Dev mode

```bash
npm install
```

```bash
cd client && npm install && cd ..
```

```bash
npm run dev
```

`npm run dev` starts three things under `concurrently`: the Vite dev server on port 5173, a
TypeScript watch build of the main process into `.electron-out/`, and the Electron app itself
pointed at Vite via `--dev-server=http://localhost:5173`.

Editing anything under `client/` hot-reloads in place. Editing `electron/` or `server/` recompiles
immediately, but the main process only picks it up on restart — quit the window and re-run.

On macOS, `npm install` also runs `scripts/dev-branding.js`, which relabels the local Electron
bundle so development doesn't show up in the dock as "Electron". Its header comment explains why.

## Tests

```bash
npm test
```

Compiles the main process and runs `node:test` over `.electron-out/`. Covers the vault envelope,
the store's atomic writes, the IPC dispatcher end to end (lock gate, channel allowlist, and the
guarantee that no reply carries a password), and the Electron hardening — CSP, sandbox settings,
and the protocol handler's path-traversal rejection.

## Production build

```bash
npm run build
```

This compiles `client/dist/` (the React app, via Vite) and `.electron-out/` (the main process,
`electron/` + `server/`). Then `npm start` runs it.

## Packaging

Installers are built with `electron-builder`. Each platform must be built on itself — in
particular, macOS disk images cannot be produced anywhere but macOS.

```bash
npm run dist
```

Or one platform at a time: `npm run dist:mac`, `npm run dist:win`, `npm run dist:linux`.
Output lands in `release/`:

| Platform | Artifacts |
|----------|-----------|
| macOS | `.dmg` and `.zip`, arm64 + x64 |
| Windows | NSIS installer and a portable `.exe`, x64 |
| Linux | `.AppImage` and `.deb`, x64 |

`npm run dist:dir` produces an unpacked app directory without building installers, which is much
faster when you only need to check that packaging resolves correctly.

Builds are unsigned by default, so macOS Gatekeeper and Windows SmartScreen will both warn on
first launch. To sign, set `CSC_LINK` and `CSC_KEY_PASSWORD` (and, on macOS, the notarization
credentials `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`) before running
`npm run dist`.

Icons are read from `build/icon.icns`, `build/icon.ico`, and `build/icon.png`. The single source
is `build/icon.png`; `build/icon.icns` is regenerated from it whenever it is missing or older, and
is used by both the development bundle and the packaged macOS app.

## Adding a new database engine

Driver registration is centralized in the main process; the UI still needs a few manual per-engine
touches.

1. **Implement the driver** — create `server/drivers/<engine>.ts` exporting a class that
   `implements Driver` (see `server/drivers/types.ts` for the interface): `testConnection`,
   `getDatabases`, `executeQuery`, `getSchemaTree`, `close`.
2. **Register it** — add the engine to the `DbType` union in `server/vault/types.ts`, then add one
   line to the `DRIVERS` map in `server/drivers/registry.ts` pointing at the new class. That's the
   only main-process wiring required; `server/handlers/connections.ts` calls `createDriver()` and
   never needs to change.
3. **Add the client type** — add the engine to the `DbType` union in `client/src/store.ts` and the
   `type` union in `client/src/api.ts`.
4. **Update UI conditionals** (not yet driven by a shared registry, so these need a manual branch
   per engine):
   - `client/src/components/ConnectionDialog.tsx` — dropdown option, default port, icon
   - `client/src/components/QueryEditor.tsx` — Monaco editor language, autocomplete, identifier
     quoting / unsafe-write detection
   - `client/src/components/ExplorerTree.tsx` — identifier quoting or template query for generated
     queries

For a relational engine (SQL text queries, tabular results, a database → schema → table → column
hierarchy), that's the whole job — see `server/drivers/postgres.ts` / `sqlserver.ts`.

For a document/NoSQL engine, the `SchemaTree`/`QueryResult` types stay the same (reuse a synthetic
schema node and the optional `QueryResult.documents` field — see `server/drivers/mongodb.ts` and
`server/drivers/mongoShellParser.ts`), but plan for:

- A query-text parser if the engine's query language isn't literal executable SQL (MongoDB's
  shell-style `db.coll.method(...)` chains needed a small hand-written parser — no `eval`).
- Flattening nested results into `columns`/`rows` for the table view, while also returning the raw
  nested docs via `QueryResult.documents` for the expandable document view
  (`client/src/components/DocumentView.tsx`) — `ResultsGrid.tsx` shows the Table/Documents toggle
  automatically whenever `documents` is present.
- Implementing the optional `Driver.inferFields()`. A schemaless engine returns tables with an
  empty `columns` array, which leaves Ask AI with nothing to write a query against; `inferFields`
  samples documents and reports field names and types instead. Relational drivers omit it — their
  catalogs already carry the columns.

Ask AI needs one more branch of its own: add a dialect entry to `DIALECT_GUIDANCE` in
`server/ai/agent.ts` so the model is told which query language to write.

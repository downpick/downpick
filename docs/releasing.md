# Releasing

A release is a git tag plus a GitHub release carrying one redistributable per platform. Everything
below is run from a clean checkout on macOS; `release/` is gitignored, so no artifact is ever
committed.

## Prerequisites (one-time)

- **Node 20+** and the dependencies installed (`npm install`, plus `cd client && npm install`)
- **Docker Desktop**, running — Linux and Windows are cross-built inside a container
- **GitHub CLI**, authenticated:

```bash
brew install gh
```

```bash
gh auth login
```

## What builds where

| Platform | Artifact | Built by |
|----------|----------|----------|
| macOS arm64 + x64 | `.dmg`, `.zip` | `electron-builder` natively on macOS |
| Linux x64 | `.AppImage` | Docker (`electronuserland/builder`) |
| Windows x64 | `.zip` | Docker (`electronuserland/builder`) |

Windows ships as a zip rather than an NSIS installer, and Linux has no `.deb`. Both are deliberate —
see [Constraints](#constraints).

## 1. Set the version

Edit `version` in the root `package.json`. That value is the single source of truth: electron-builder
reads it for every filename, and no source file hardcodes a version. (`client/package.json` carries
its own version, which nothing reads — leave it or bump it, it has no effect on the build.)

Then export it, since every command below interpolates it:

```bash
export VERSION=$(node -p "require('./package.json').version")
```

## 2. Test

```bash
npm test
```

## 3. Build macOS

```bash
npm run dist:mac
```

Produces four artifacts in `release/` — dmg and zip, each for arm64 and x64 — plus `.blockmap`
files and `latest-mac.yml`.

## 4. Build Linux and Windows

Both come out of the same container. The named volumes are the important part: they keep a Linux
`node_modules` separate from the host's macOS one, so the container never overwrites your local
native binaries with Linux builds of the same packages.

```bash
docker run --rm --platform linux/amd64 -v "$PWD":/project -v downpick-node-modules:/project/node_modules -v downpick-client-node-modules:/project/client/node_modules electronuserland/builder /bin/bash -c "npm install --no-audit --no-fund && npm run build && npx electron-builder --linux --win zip"
```

First run pulls the image (several GB) and populates the volumes; later runs reuse both and are much
faster. Once the volumes exist and dependencies haven't changed, `npm install --no-audit --no-fund &&`
can be dropped from the command.

This yields `Downpick-$VERSION.AppImage`, `Downpick-$VERSION-win.zip`, and `latest-linux.yml`.

## 5. Check the output

```bash
ls -lh release/
```

Sanity-check the sizes: each platform's artifact should be well over 100 MB. Anything in the
low-KB range is a failed build that left a stub behind — delete it rather than shipping it.

```bash
cd release && shasum -a 256 Downpick-$VERSION*.dmg Downpick-$VERSION*.zip Downpick-$VERSION.AppImage
```

Keep that output; it goes in the release notes.

## 6. Commit and tag

The tag should point at the tree the artifacts were built from, so commit first.

```bash
git commit -am "Version $VERSION"
```

```bash
git push origin main
```

```bash
git tag -a "v$VERSION" -m "Downpick $VERSION"
```

```bash
git push origin "v$VERSION"
```

## 7. Publish

Write the notes (see [Release notes](#release-notes) for what belongs in them):

```bash
$EDITOR /tmp/downpick-notes.md
```

```bash
gh release create "v$VERSION" release/Downpick-$VERSION-arm64.dmg release/Downpick-$VERSION-arm64-mac.zip release/Downpick-$VERSION.dmg release/Downpick-$VERSION-mac.zip release/Downpick-$VERSION.AppImage release/Downpick-$VERSION-win.zip --title "Downpick $VERSION" --notes-file /tmp/downpick-notes.md
```

To add the auto-update manifests and blockmaps — only needed if electron-updater is ever wired up —
append `release/latest-mac.yml release/latest-linux.yml release/*.blockmap`. Note there is no
`latest.yml` for Windows: the `zip` target doesn't emit one.

To attach something after the fact:

```bash
gh release upload "v$VERSION" <file>
```

## Release notes

Worth including every time:

- **Which download is which.** Apple Silicon vs. Intel dmg, AppImage for Linux (`chmod +x` first),
  zip for Windows (extract, run `Downpick.exe`).
- **The unsigned warning.** Gatekeeper blocks first launch — right-click → **Open**, or
  `xattr -dr com.apple.quarantine /Applications/Downpick.app`. Windows SmartScreen needs
  **More info → Run anyway**.
- **SHA-256 checksums**, from step 5.

## Constraints

**Builds are unsigned.** `identity: null` in `electron-builder.yml` skips macOS signing. To ship
signed builds, set `CSC_LINK` and `CSC_KEY_PASSWORD`, plus `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for notarization, and remove that line.

**No Windows installer on Apple Silicon.** The `nsis` and `portable` targets need Wine to generate
the uninstaller, and Wine aborts under QEMU emulation on an ARM host — an `anon_mmap_fixed`
assertion, caused by the 16 KB host page size where Wine assumes 4 KB. No build flag works around
it. The failure is also misleading: packaging succeeds and leaves a ~190 KB
`Downpick Setup <version>.exe` that looks like an installer but is a truncated intermediate. Delete
it if you see it.

The `zip` target avoids Wine entirely and contains the identical app, so it is what the release
ships. For a real installer, build on a `windows-latest` GitHub Actions runner or a Windows VM;
enabling **Docker Desktop → Settings → General → Use Rosetta for x86_64/amd64 emulation** is
sometimes enough to get Wine working locally, and is the cheapest thing to try first.

**No `.deb`.** Debian packages require a maintainer email, which means putting a real address in
`package.json`'s `author` field, where it would be published in the package metadata. The target is
commented out in `electron-builder.yml`; restore it and set `author` to `{ name, email }` if you
want it.

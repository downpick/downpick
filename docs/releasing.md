# Releasing

Downpick uses `electron-updater` with public GitHub Releases. Every release must include the
installers **and** the generated update manifests; uploading only the installers leaves existing
clients unable to update. No GitHub token is embedded in the application.

## Release through GitHub Actions

1. Set a new, higher version in the root `package.json` and `package-lock.json`, for example with
   `npm version --no-git-tag-version 1.3.0`. The client package version is not used for releases.
2. Commit the changes, then push the commit and a matching `v<version>` tag.
3. `.github/workflows/release.yml` tests and builds on macOS, Windows, and Linux. It checks that
   the tag matches the package version. Both Mac architectures are built in the same job so
   `latest-mac.yml` includes both payloads.
4. Once all jobs succeed, the workflow uploads every artifact, manifest, blockmap, and
   `SHA256SUMS.txt` to a **draft** GitHub release. A rerun can replace assets in that draft, but
   refuses to modify an already published release. A manual workflow dispatch only builds and
   saves workflow artifacts; it does not create a release.
5. Download and smoke-test the packages, review the generated release notes, then publish the
   complete draft as the latest stable release. Drafts and prereleases are not offered by the app.

Do not publish a partial release while another platform is still building. Never replace binaries
under a version already offered to clients: increment the version for fixes and rollbacks.

## Signing credentials

Configure these repository Actions secrets for macOS automatic updates:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` certificate |
| `MAC_CSC_KEY_PASSWORD` | Password for the certificate |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Apple Developer team ID |

For Windows signing, configure `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. Keep the same publisher
identity across updates. These credentials are only used by the build job. The draft-upload job
uses GitHub's short-lived `GITHUB_TOKEN` with `contents: write`.

Without Mac credentials, builds remain available for manual installation but automatic updates
are disabled in the app. `scripts/adhoc-sign-mac.js` repairs the bundle's ad-hoc signature so it
is not reported as damaged; that is not a substitute for a Developer ID signature. The app checks
the installed bundle's signing identity before enabling its updater.

For a local signed Mac build, export `CSC_LINK`, `CSC_KEY_PASSWORD` and the three `APPLE_*`
variables above. There is no `identity: null` override in the build configuration, so
`electron-builder` can use the supplied certificate and notarize the app. Verify your release:

```bash
codesign --verify --deep --strict release/mac-arm64/Downpick.app
spctl --assess --type execute --verbose release/mac-arm64/Downpick.app
```

Repeat for `release/mac/Downpick.app` on the Intel build. When distributing without signing,
explain the macOS Gatekeeper / Windows SmartScreen first-launch warnings in the release notes.

## Local builds

Use Node.js 24 and install both sets of dependencies:

```bash
npm ci
npm ci --prefix client
npm test
```

Build each platform on its native host:

```bash
npm run dist:mac -- --publish never
npm run dist:win -- --publish never
npm run dist:linux -- --publish never
```

The commands above run on macOS, Windows, and Linux respectively. Windows now ships an **NSIS
installer**, not a portable ZIP. On Apple Silicon, cross-building NSIS through Wine/QEMU has
failed because of host page-size differences; use the Windows Actions job or a Windows machine.
Linux still uses AppImage and does not require a Debian maintainer email.

| Platform | Required release assets |
|---|---|
| macOS arm64 + x64 | Both `.dmg` and `*-mac.zip` payloads, their `.blockmap` files, `latest-mac.yml` |
| Windows x64 | `Downpick Setup <version>.exe`, its `.blockmap`, `latest.yml` |
| Linux x64 | `Downpick-<version>.AppImage`, `latest-linux.yml` |

Collect the outputs from all three hosts into a single `release/` directory. Do not upload
`builder-debug.yml`, `builder-effective-config.yaml`, or unpacked app directories. The
`app-update.yml` inside each packaged app is internal configuration, not a release asset.

To create a draft manually after creating and pushing the matching tag (Bash):

```bash
export VERSION=1.3.0
cd release
shasum -a 256 *.dmg *.zip *.exe *.AppImage > SHA256SUMS.txt
gh release create "v$VERSION" --verify-tag --draft --title "Downpick $VERSION" --generate-notes
gh release upload "v$VERSION" *.dmg *.zip *.exe *.AppImage *.blockmap latest*.yml SHA256SUMS.txt
```

Review and publish the draft only after all assets are uploaded and tested.

## Update behavior and validation

Supported installed builds check 15 seconds after launch and every six hours while open.
An available stable update downloads in the background; menu text shows progress. Once ready,
Downpick offers **Restart and Update** or **Later**. Later does not install on ordinary quit;
choose the menu command when ready. A future launch checks again and can reuse the cached payload.

The command is in **Downpick** on macOS and **Help** on Windows/Linux, including while the vault
is locked. Manual checks report when the app is current or a request fails. Background checks
stay quiet when no update is available or the server cannot be reached. A failed download reports
an error and can be retried. Development builds, unsigned Macs, portable Windows executables,
and Linux builds not running as AppImage offer a link to the release downloads instead.

Restart is refused while queries are running, including queries with no cancellation callback.
Before invoking the installer, the app runs its normal vault/connection/AI shutdown, bounded by
the existing two-second timeout. Installation never starts just because a download completed.

Before shipping the first release with this feature, test with **two packaged versions** against
a separate test release feed: install the older one, publish the newer one with all metadata,
check/download, select Later, then restart explicitly and confirm the version changed. Also test
an offline check, a running query, and both Mac architectures with signed/notarized builds.
`npm test` covers controller decisions and concurrency, but does not execute native installers.

Users of versions that predate the updater must manually install the first updater-enabled
release. Existing Windows ZIP users must install the NSIS build; ad-hoc Mac users must manually
install a Developer ID-signed build before subsequent automatic updates can work.

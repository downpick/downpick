# Releasing

This guide covers the complete release sequence: version, tests, commit, annotated tag, builds,
checksums, release notes, and publication. Downpick uses `electron-updater` with public GitHub
Releases, so every release needs both its installers and the generated update manifests.

The main procedure uses GitHub Actions to build all three platforms. The local-build and manual
upload sections below are alternatives for preparing or replacing artifacts in an unpublished
draft. **Pushing a `v*` tag starts the workflow**, even if you also build locally.

## 1. Prerequisites and repository setup

Use Node.js 24, npm 11.19.0 (pinned in `package.json`), Git, and the GitHub CLI. On macOS,
install the CLI if needed:

```bash
brew install gh
```

Authenticate with an account that can push to the repository and manage its releases:

```bash
gh auth login
gh auth status
```

Commands labeled `bash` should be run in Bash, including on macOS, where the default interactive
shell is often Zsh. Start Bash once, then enter your checkout; adjust this path if necessary:

```bash
bash
cd ~/source/downpick
export REPO=downpick/downpick
export RELEASE_ROOT="$(git rev-parse --show-toplevel)"
git status --short
git branch --show-current
git remote -v
```

The commands below assume the release comes from `main` and `origin` points to
`https://github.com/downpick/downpick.git`. Commit any application changes intended for this
release before the version step. If the only pending changes are a version bump you already
made in `package.json` and `package-lock.json`, keep them for step 4.

With no unrelated uncommitted changes, update your release branch:

```bash
git switch main
git pull --ff-only origin main
git fetch origin --tags
```

For signed releases, configure the credentials in [Signing credentials](#signing-credentials)
before pushing the tag. Without Mac credentials, the workflow can still build a manually
installable app, but that Mac build cannot update automatically.

## 2. Set and export the version

`package.json` at the repository root is the source of truth for the application version and
artifact filenames. There is no separate build-number setting. Keep `package-lock.json` in sync;
the client package version does not control releases.

Choose the version you intend to publish. `1.3.0` is an example; use a higher unused version for
each subsequent release. `--allow-same-version` also repairs a partial manual version bump:
the command updates `package.json`, the lockfile's top-level version, and its `packages[""]`
version even when `package.json` already contains the requested version. It does not create a
commit or tag.

```bash
export NEXT_VERSION=1.3.0
npm version "$NEXT_VERSION" --no-git-tag-version --allow-same-version

export VERSION="$(node -p "require('./package.json').version")"
export TAG="v$VERSION"
printf 'Version: %s\nTag: %s\n' "$VERSION" "$TAG"
node -e "const p = require('./package.json'); const l = require('./package-lock.json'); if (l.version !== p.version || l.packages[''].version !== p.version) throw new Error('package-lock.json version does not match package.json')"
git diff -- package.json package-lock.json
```

If the lockfile check fails after a manual edit, synchronize all version fields to the current
`package.json` version and repeat the check before proceeding. This does not reinstall or upgrade
dependencies:

```bash
npm version "$(node -p "require('./package.json').version")" --no-git-tag-version --allow-same-version
```

Check that the proposed tag and release do not already exist:

```bash
git tag --list "$TAG"
git ls-remote --tags origin "refs/tags/$TAG"
gh release list --repo "$REPO" --limit 20
```

Both tag commands should print nothing for a new version. Do not move an existing release tag
or overwrite a published version; choose a new version instead.

If you open another terminal later, enter the checkout and restore these variables:

```bash
export REPO=downpick/downpick
export RELEASE_ROOT="$(git rev-parse --show-toplevel)"
export VERSION="$(node -p "require('./package.json').version")"
export TAG="v$VERSION"
```

## 3. Install dependencies and validate

Run from the repository root. Both installs are required because the renderer has its own
lockfile and dependencies. First select the same npm version as the release workflow:

```bash
npm install --global "$(node -p "require('./package.json').packageManager")"
npm --version
```

It should print `11.19.0`. Then install and validate:

```bash
npm ci
npm ci --prefix client
npm test
npm run build
```

Stop and fix any failure before continuing. `npm run build` compiles the renderer and the main
process; it does not generate installers.

If `npm ci` reports `Missing: ... from lock file`, that is a dependency-graph problem, separate
from the version-field check in step 2. Older npm versions can accept an incomplete optional
dependency tree that newer npm rejects. With the pinned npm selected, repair the lockfile,
review its changes, and repeat the clean install:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
git diff -- package-lock.json
npm ci
```

Commit the repaired lockfile with the release changes. Keep `npm ci` in the workflow so it
checks the committed dependency graph rather than silently rewriting it on the build runner.

## 4. Commit, create the annotated tag, and push

Review the release version changes and commit them. Other application changes intended for the
release should already be committed:

```bash
git diff --check
git add package.json package-lock.json
git diff --cached
git commit -m "Version $VERSION"
```

If that exact version bump was already committed, skip the `git commit` command. Confirm the
working tree is clean before tagging:

```bash
git status --short
git log -1 --oneline
export RELEASE_COMMIT="$(git rev-parse HEAD)"
git tag -a "$TAG" -m "Downpick $VERSION"
git show --no-patch "$TAG"
```

Send the commit first, then this specific tag:

```bash
git push origin main
git push origin "refs/tags/$TAG"
```

The tag must refer to the commit from which the packages are built. The tag push starts
`.github/workflows/release.yml`, which also checks that the tag matches `package.json`.

## 5. Watch the builds and draft creation

The workflow tests and builds on native macOS, Windows, and Linux runners. Both Mac architectures
are built in the same job so `latest-mac.yml` describes both payloads. Once every build succeeds,
the final job creates or updates a **draft** release with all artifacts and `SHA256SUMS.txt`.

Find the run for the tag you just pushed:

```bash
export RELEASE_COMMIT="$(git rev-parse "$TAG^{commit}")"
gh run list --repo "$REPO" --workflow release.yml --event push --branch "$TAG" --commit "$RELEASE_COMMIT" --limit 5
export RUN_ID="$(gh run list --repo "$REPO" --workflow release.yml --event push --branch "$TAG" --commit "$RELEASE_COMMIT" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
printf 'Workflow run: %s\n' "$RUN_ID"
```

If `RUN_ID` is empty, wait a few seconds and repeat the lookup; GitHub may not have queued the
run yet. Once the ID is present:

```bash
gh run watch "$RUN_ID" --repo "$REPO" --exit-status
```

For a failed run, inspect the logs. If the problem was transient or you corrected repository
signing secrets, rerun the failed jobs and wait again:

```bash
gh run view "$RUN_ID" --repo "$REPO" --log-failed
gh run rerun "$RUN_ID" --repo "$REPO" --failed
gh run watch "$RUN_ID" --repo "$REPO" --exit-status
```

A source-code correction requires a new commit and a new version/tag; rerunning an existing run
still builds the original commit. Do not publish while any build or upload job is still running.

## 6. Download and verify the draft

Inspect the release, confirm it is still a draft, and download its assets into a fresh directory:

```bash
gh release view "$TAG" --repo "$REPO" --json tagName,isDraft,isPrerelease,assets,url
export REVIEW_DIR="$(mktemp -d "${TMPDIR:-/tmp}/downpick-$VERSION-review.XXXXXX")"
gh release download "$TAG" --repo "$REPO" --dir "$REVIEW_DIR"
ls -lh "$REVIEW_DIR"
```

Expected assets:

| Platform | Files |
|---|---|
| macOS Apple Silicon | `Downpick-<version>-arm64.dmg`, `Downpick-<version>-arm64-mac.zip`, generated `.blockmap` files |
| macOS Intel | `Downpick-<version>.dmg`, `Downpick-<version>-mac.zip`, generated `.blockmap` files |
| Windows x64 | `Downpick Setup <version>.exe`, its `.blockmap` |
| Linux x64 | `Downpick-<version>.AppImage` |
| Update metadata | `latest-mac.yml`, `latest.yml`, `latest-linux.yml` |
| Checksums | `SHA256SUMS.txt` |

Verify the downloaded files against the checksums, from the directory containing them:

```bash
cd "$REVIEW_DIR"
shasum -a 256 -c SHA256SUMS.txt
cd "$RELEASE_ROOT"
```

On Linux, `sha256sum -c SHA256SUMS.txt` is also available. Each installer/archive should be well
over 100 MB; a tiny `.exe` can be a failed build stub. Manifests and blockmaps are much smaller.
Install and open the packages on their target platforms before publishing. On macOS, extract
the downloaded ZIPs and verify both app signatures:

```bash
ditto -x -k "$REVIEW_DIR/Downpick-$VERSION-arm64-mac.zip" "$REVIEW_DIR/mac-arm64"
ditto -x -k "$REVIEW_DIR/Downpick-$VERSION-mac.zip" "$REVIEW_DIR/mac-x64"
codesign --verify --deep --strict "$REVIEW_DIR/mac-arm64/Downpick.app"
codesign --verify --deep --strict "$REVIEW_DIR/mac-x64/Downpick.app"
```

For Developer ID-signed and notarized releases, also verify Gatekeeper acceptance:

```bash
spctl --assess --type execute --verbose "$REVIEW_DIR/mac-arm64/Downpick.app"
spctl --assess --type execute --verbose "$REVIEW_DIR/mac-x64/Downpick.app"
```

Ad-hoc builds are expected to fail the Gatekeeper assessment and require manual updates; do not
describe those builds as Developer ID-signed releases.

## 7. Write the release notes

Start from the workflow's generated notes and edit a local file. Set `EDITOR` to your preferred
editor; this example uses `nano`:

```bash
export NOTES_FILE="${TMPDIR:-/tmp}/downpick-$VERSION-notes.md"
gh release view "$TAG" --repo "$REPO" --json body --jq .body > "$NOTES_FILE"
export EDITOR=nano
"$EDITOR" "$NOTES_FILE"
```

Include the changes, which installer to choose, the signing status and any first-launch steps,
and a reference to the attached `SHA256SUMS.txt`. For the first updater-enabled release, mention
that existing users need one manual installation, and Windows ZIP users need the NSIS installer.

Save the notes to the draft:

```bash
gh release edit "$TAG" --repo "$REPO" --title "Downpick $VERSION" --notes-file "$NOTES_FILE"
gh release view "$TAG" --repo "$REPO" --web
```

## 8. Publish the complete stable release

After package verification and notes review, publish the draft and mark it as the latest stable
release. This is the step that makes the new version available to the updater:

```bash
gh release edit "$TAG" --repo "$REPO" --draft=false --prerelease=false --latest
gh release view "$TAG" --repo "$REPO" --json tagName,isDraft,isPrerelease,assets,url
```

Confirm `isDraft` and `isPrerelease` are both `false`. Never replace binaries or manifests in a
version already offered to clients; increment the version for a fix or rollback. The workflow
also refuses to replace assets in a published release.

## Signing credentials

### Configure GitHub Actions secrets once

Obtain a Developer ID Application certificate with its private key and export it as a `.p12` file
from Keychain Access. A paid Apple Developer account is required. Replace the example certificate
path below with your exported file. These commands set repository secrets without committing the
certificate or placing passwords in command arguments:

```bash
export REPO=downpick/downpick
export MAC_CERTIFICATE='/absolute/path/to/DeveloperIDApplication.p12'
base64 < "$MAC_CERTIFICATE" | gh secret set MAC_CSC_LINK --repo "$REPO"
gh secret set MAC_CSC_KEY_PASSWORD --repo "$REPO"
gh secret set APPLE_ID --repo "$REPO"
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO"
gh secret set APPLE_TEAM_ID --repo "$REPO"
```

Enter the certificate password, Apple account email, app-specific password, and team ID at the
respective prompts. The workflow maps `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` to the builder's
`CSC_LINK` and `CSC_KEY_PASSWORD` environment variables.

For Windows signing, supply your Windows code-signing `.p12` certificate and password:

```bash
export WINDOWS_CERTIFICATE='/absolute/path/to/WindowsCodeSigning.p12'
base64 < "$WINDOWS_CERTIFICATE" | gh secret set WIN_CSC_LINK --repo "$REPO"
gh secret set WIN_CSC_KEY_PASSWORD --repo "$REPO"
gh secret list --repo "$REPO"
```

Keep the same publisher identity across Windows updates. The draft-upload job uses GitHub's
short-lived `GITHUB_TOKEN` with `contents: write`; no GitHub token is embedded in the app.

Without a Developer ID certificate, Mac builds retain the ad-hoc signature applied by
`scripts/adhoc-sign-mac.js` and offer manual downloads instead of autoupdate. Ad-hoc signing
repairs the bundle signature but does not establish a trusted publisher identity.

## Local builds

These commands are for local package verification or manually preparing release assets. Each
host must use the same tagged commit. For a new checkout on a build machine, replace the example
tag with the release tag and run:

```bash
export TAG=v1.3.0
git clone --branch "$TAG" --depth 1 https://github.com/downpick/downpick.git downpick-release
cd downpick-release
export VERSION="$(node -p "require('./package.json').version")"
test "$TAG" = "v$VERSION"
npm install --global "$(node -p "require('./package.json').packageManager")"
npm ci
npm ci --prefix client
npm test
```

For an existing checkout, verify `git status --short` is empty and that `git rev-parse HEAD`
matches `git rev-parse "$TAG^{commit}"` before building. Start with an empty `release/` directory
so old installers and manifests cannot be mistaken for current output. All commands below use
`--publish never`; they generate packages without uploading them.

### macOS: both architectures

For a signed/notarized local build, set the certificate path and enter the credentials in Bash:

```bash
export CSC_LINK='/absolute/path/to/DeveloperIDApplication.p12'
read -r -s -p 'Certificate password: ' CSC_KEY_PASSWORD
printf '\n'
export CSC_KEY_PASSWORD
read -r -p 'Apple account email: ' APPLE_ID
export APPLE_ID
read -r -s -p 'Apple app-specific password: ' APPLE_APP_SPECIFIC_PASSWORD
printf '\n'
export APPLE_APP_SPECIFIC_PASSWORD
read -r -p 'Apple team ID: ' APPLE_TEAM_ID
export APPLE_TEAM_ID
```

For an ad-hoc build with manual updates, use a terminal without those signing credentials.
Build both architectures together
so one `latest-mac.yml` contains both ZIP payloads:

```bash
npm run dist:mac -- --publish never
ls -lh release/
codesign --verify --deep --strict release/mac-arm64/Downpick.app
codesign --verify --deep --strict release/mac/Downpick.app
```

For Developer ID-signed and notarized builds, verify Gatekeeper acceptance too:

```bash
spctl --assess --type execute --verbose release/mac-arm64/Downpick.app
spctl --assess --type execute --verbose release/mac/Downpick.app
```

The `codesign` checks should exit successfully with no output. Ad-hoc builds are expected to
fail `spctl` assessment; they still require the first-launch bypass described in the README.
There is no `identity: null` override in the builder configuration, so supplied Developer ID
credentials can be used by `electron-builder`.

### Windows: NSIS installer

On a Windows host, use PowerShell with Node.js 24 installed. If you do not already have the
tagged checkout, create it first (replace the example tag):

```powershell
$Tag = 'v1.3.0'
git clone --branch $Tag --depth 1 https://github.com/downpick/downpick.git downpick-release
Set-Location downpick-release
```

For a signed local build, set the Windows certificate and password before building:

```powershell
$env:CSC_LINK = 'C:\certificates\WindowsCodeSigning.p12'
$DownpickSigningPassword = Read-Host 'Certificate password' -AsSecureString
$env:CSC_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $DownpickSigningPassword).Password
```

Skip that signing block for an unsigned Windows build. From the tagged checkout, install the
dependencies, test, and generate the installer:

```powershell
$env:VERSION = node -p "require('./package.json').version"
npm install --global (node -p "require('./package.json').packageManager")
npm ci
npm ci --prefix client
npm test
npm run dist:win -- --publish never
Get-ChildItem release
Get-FileHash "release/Downpick Setup $env:VERSION.exe" -Algorithm SHA256
```

The workflow can also sign Windows builds using the repository secrets configured above.
Windows now ships NSIS rather than the old portable ZIP. Wine/QEMU cross-building on Apple Silicon can fail
because of host page-size differences; use Windows or the Windows Actions job for this installer.

### Linux: native AppImage build

On a Linux x64 host, after installing the dependencies in the tagged checkout:

```bash
npm run dist:linux -- --publish never
chmod +x "release/Downpick-$VERSION.AppImage"
sha256sum "release/Downpick-$VERSION.AppImage"
```

### Linux: Docker build from macOS

With Docker Desktop running, execute this from the tagged repository root:

```bash
docker info
docker run --rm --platform linux/amd64 \
  -e DOWNPICK_NPM_VERSION="$(node -p "require('./package.json').packageManager")" \
  -v "$PWD":/project \
  -v downpick-node-modules:/project/node_modules \
  -v downpick-client-node-modules:/project/client/node_modules \
  -w /project \
  electronuserland/builder \
  /bin/bash -c 'npm install --global "$DOWNPICK_NPM_VERSION" && npm ci && npm ci --prefix client && npm run dist:linux -- --publish never'
```

The named volumes keep Linux dependencies separate from the host's `node_modules`. Both installs
are required, since the two volumes start empty. Output is written to the host's `release/`.
This command builds Linux only; it does not attempt to generate the Windows installer with Wine.
Linux uses AppImage and does not require a Debian package maintainer email.

## Manual asset upload or replacement before publication

Use this section when you want to publish packages built locally, rather than the packages
already uploaded by Actions. Complete steps 1–5 first: pushing the tag still triggers the
workflow, so **wait for that run to finish before changing the draft**. This avoids the workflow
replacing your uploads. If Actions is not enabled for the repository, create the draft with the
command below after pushing the tag.

Collect the following files from the three build hosts into `release/` on the publishing machine:
all six platform installer/archive files listed in step 6, their generated `.blockmap` files,
and the three `latest*.yml` manifests. Preserve the filenames and do not combine files from
different versions. For example, to reuse Windows output from the completed Actions run while
building Mac and Linux locally:

```bash
cd "$RELEASE_ROOT"
gh run download "$RUN_ID" --repo "$REPO" --name release-win --dir release
```

That command expects the Windows files not to be present already. Use `--name release-mac` or
`--name release-linux` similarly for other platforms you are not building locally.

Define the upload list explicitly so debug configuration and unpacked app directories are not
included. Run these commands in Bash from the repository root:

```bash
export VERSION="$(node -p "require('./package.json').version")"
export TAG="v$VERSION"
export REPO=downpick/downpick

INSTALLERS=(
  "Downpick-$VERSION-arm64.dmg"
  "Downpick-$VERSION-arm64-mac.zip"
  "Downpick-$VERSION.dmg"
  "Downpick-$VERSION-mac.zip"
  "Downpick Setup $VERSION.exe"
  "Downpick-$VERSION.AppImage"
)

cd release
for file in "${INSTALLERS[@]}" latest-mac.yml latest.yml latest-linux.yml; do
  if [ ! -s "$file" ]; then
    printf 'Missing release asset: %s\n' "$file" >&2
    exit 1
  fi
done
ls -lh "${INSTALLERS[@]}" latest-mac.yml latest.yml latest-linux.yml
shasum -a 256 "${INSTALLERS[@]}" > SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt
```

This block leaves the shell inside `release/`; execute the upload commands below there. Include
all blockmaps emitted by these builds. `app-update.yml` inside each app is internal updater
configuration, not a release asset. The `latest*.yml` files must be exactly those generated with
the binaries being uploaded, since they contain their sizes and SHA-512 checksums.

Check whether the tag already has a release:

```bash
gh release view "$TAG" --repo "$REPO" --json tagName,isDraft
```

Only if no release exists yet, create the draft:

```bash
gh release create "$TAG" --repo "$REPO" --verify-tag --draft --title "Downpick $VERSION" --generate-notes
```

Verify that it is a draft, then upload the installers, manifests, blockmaps, and checksums. The
`--clobber` option replaces existing assets with the same names in this unpublished draft:

```bash
if [ "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" != true ]; then
  printf 'Refusing to replace assets in a published or inaccessible release.\n' >&2
  exit 1
fi
gh release upload "$TAG" --repo "$REPO" \
  "${INSTALLERS[@]}" ./*.blockmap \
  latest-mac.yml latest.yml latest-linux.yml SHA256SUMS.txt \
  --clobber
cd "$RELEASE_ROOT"
```

Continue with steps 6–8 to download and verify the uploaded assets, write notes, and publish.
If the upload fails partway through, keep the release as a draft and repeat the upload after
fixing the failure. Do not publish an incomplete set of assets.

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

#!/usr/bin/env node
/**
 * Gives the *unpackaged* app its own identity in the macOS dock.
 *
 * `app.setName()` fixes the menu bar, but the dock reads `CFBundleName` and the icon from the
 * running bundle — which in development is `node_modules/electron/dist/Electron.app`, not ours.
 * There is no runtime API for that, so the only way to stop the dock saying "Electron" during
 * development is to relabel the development binary itself.
 *
 * Packaged builds are unaffected: they ship their own bundle, already correct.
 *
 * Runs on `postinstall`, so a fresh `npm install` — which restores the stock Electron.app —
 * re-applies it automatically. Safe to run repeatedly, and a no-op off macOS.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = 'Downpick';
const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'node_modules/electron/dist/Electron.app');
const PLIST = path.join(APP, 'Contents/Info.plist');
const PNG = path.join(ROOT, 'build/icon.png');
const ICNS = path.join(ROOT, 'build/icon.icns');

function plist(command) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', command, PLIST], { encoding: 'utf-8' }).trim();
}

/**
 * Builds build/icon.icns from build/icon.png when it is missing or out of date.
 *
 * Keeping the .icns generated rather than hand-maintained means editing the PNG is enough to
 * change the icon everywhere — the dev bundle here, and the packaged macOS app, which
 * electron-builder picks up from the same file.
 */
function ensureIcns() {
  if (!fs.existsSync(PNG)) return false;
  if (fs.existsSync(ICNS) && fs.statSync(ICNS).mtimeMs >= fs.statSync(PNG).mtimeMs) return true;

  const iconset = path.join(ROOT, 'build', 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
        const px = size * scale;
        execFileSync(
          'sips',
          ['-z', String(px), String(px), PNG, '--out', path.join(iconset, `icon_${size}x${size}${suffix}.png`)],
          { stdio: 'ignore' },
        );
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', ICNS], { stdio: 'ignore' });
    return true;
  } finally {
    fs.rmSync(iconset, { recursive: true, force: true });
  }
}

function main() {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(PLIST)) return; // electron not installed yet, or a partial install

  const haveIcns = ensureIcns();
  if (plist('Print :CFBundleName') === NAME) return; // already branded

  plist(`Set :CFBundleName ${NAME}`);
  // CFBundleDisplayName is what the dock actually renders; it may not exist yet.
  try {
    plist(`Set :CFBundleDisplayName ${NAME}`);
  } catch {
    plist(`Add :CFBundleDisplayName string ${NAME}`);
  }

  // The dock icon is read from the bundle before any JS runs, so app.dock.setIcon() alone
  // leaves a visible flash of the Electron logo at launch. Replacing the file removes it.
  if (haveIcns) {
    const target = path.join(APP, 'Contents/Resources', plist('Print :CFBundleIconFile'));
    fs.copyFileSync(ICNS, target);
  }

  // Editing the bundle invalidates its ad-hoc signature, and macOS kills unsigned-but-
  // formerly-signed binaries on Apple Silicon. Re-sign ad-hoc to make it launchable again.
  execFileSync('codesign', ['--force', '--sign', '-', APP], { stdio: 'ignore' });

  // macOS caches bundle metadata; without this the dock can keep the old name for a while.
  try {
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', APP],
      { stdio: 'ignore' },
    );
  } catch {
    // Best-effort only — the name is already correct on the next fresh launch.
  }

  console.log(`dev-branding: relabelled the development Electron bundle as ${NAME}`);
}

try {
  main();
} catch (err) {
  // Never fail an install over cosmetics.
  console.warn(`dev-branding: skipped (${err instanceof Error ? err.message : err})`);
}

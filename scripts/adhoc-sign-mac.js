// electron-builder afterPack hook: ad-hoc sign the macOS bundle.
//
// `identity: null` in electron-builder.yml skips signing entirely, which leaves the app
// carrying the linker-signed ad-hoc signature that came with the Electron binary. Packaging
// renames the bundle and rewrites Info.plist and Resources, so that inherited signature no
// longer matches its own seal:
//
//   code has no resources but signature indicates they must be present
//
// A downloaded copy carries com.apple.quarantine, Gatekeeper evaluates the broken signature,
// and the user gets "Downpick is damaged and can't be opened" — with no right-click -> Open
// escape hatch, since that only bypasses an *unverified* app, not a *malformed* one.
//
// Re-signing ad-hoc gives the bundle a valid, self-consistent signature. It is still not a
// Developer ID signature, so first launch still needs Open Anyway, but the app is no longer
// reported as damaged.
//
// Runs before electron-builder's own signing step, so a real Developer ID signature (set via
// CSC_LINK) simply overwrites this one. Note the hook also runs before electron-builder flips
// Electron fuses — if `electronFuses` is ever added to the config, that would invalidate this
// signature and the ad-hoc pass would have to move after it.

const { execFileSync } = require("child_process");
const path = require("path");

module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  // A real certificate is configured; electron-builder signs properly right after this hook.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  // Fail the build rather than ship another bundle that Gatekeeper calls damaged.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });

  console.log(`  • ad-hoc signed  ${path.basename(context.appOutDir)}`);
};

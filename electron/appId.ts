/**
 * The app's identity to Windows, kept in a module of its own so a test can hold it against
 * `appId` in electron-builder.yml.
 *
 * These two strings have to agree for toast notifications to be raised at all: the installer
 * stamps the yml's `appId` onto the Start Menu shortcut, and Windows only delivers a toast to
 * an app whose AppUserModelID matches a shortcut it can find. Nothing at build time checks
 * that, and nothing at runtime complains — the notifications simply stop arriving, on Windows
 * only, in a packaged build. Hence appId.test.ts.
 */
export const APP_USER_MODEL_ID = 'com.downpick.app';

/**
 * The window is frameless-ish on macOS (`titleBarStyle: 'hiddenInset'`), so the traffic
 * lights float over the renderer and the app has to reserve its own drag regions — see
 * the `.drag-region` class in index.css. Nowhere else needs this.
 */
export const IS_MAC = navigator.userAgent.includes('Mac');

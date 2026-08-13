import { BrowserWindow, Rectangle, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DOWNPICK_DIR, ensureSecureDir } from '../server/paths';

/**
 * Remembers where the window was.
 *
 * Stored alongside the vault in ~/.downpick rather than in Electron's userData directory, so
 * the app keeps everything it owns in one place — the same reason `paths.ts` was left
 * pointing there instead of being moved to `app.getPath('userData')`.
 */

const STATE_PATH = path.join(DOWNPICK_DIR, 'window.json');
const SAVE_DEBOUNCE_MS = 400;

export const DEFAULT_BOUNDS = { width: 1440, height: 900 };

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * True when the rectangle overlaps a display that currently exists.
 *
 * A window restored onto an unplugged second monitor is invisible and, to the user, simply
 * gone — with no obvious way to get it back.
 */
function isOnScreen(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

export function loadWindowState(): WindowState {
  let raw: Partial<WindowState>;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { ...DEFAULT_BOUNDS, maximized: false };
  }

  const width = Number.isFinite(raw.width) ? Math.max(600, Number(raw.width)) : DEFAULT_BOUNDS.width;
  const height = Number.isFinite(raw.height)
    ? Math.max(400, Number(raw.height))
    : DEFAULT_BOUNDS.height;
  const state: WindowState = { width, height, maximized: raw.maximized === true };

  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    const candidate = { x: Number(raw.x), y: Number(raw.y), width, height };
    if (isOnScreen(candidate)) {
      state.x = candidate.x;
      state.y = candidate.y;
    }
  }
  return state;
}

/**
 * Persists the window's geometry as it changes.
 *
 * Bounds are read via `getNormalBounds()` so a window saved while maximized restores to a
 * sensible size when un-maximized later, rather than to the full screen.
 */
export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;

  const save = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: window.isMaximized(),
    };
    try {
      ensureSecureDir();
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // Losing the window position is not worth interrupting anything over.
    }
  };

  const scheduleSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
    timer.unref?.();
  };

  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  // The debounced write would be cut off by the window going away, so close writes directly.
  window.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

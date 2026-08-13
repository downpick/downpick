import { BrowserWindow, dialog } from 'electron';
import * as fs from 'fs/promises';
import { SaveFileRequest, SaveFileResult } from '../server/channels';
import { AppError, registerHandler } from '../server/dispatch';

/**
 * Native save dialog for the results-grid exports.
 *
 * In the browser build these were a synthetic `<a download>` click and `XLSX.writeFile`,
 * which depend on a download manager the app no longer has. The renderer still builds the
 * bytes — it owns the formatting — and hands them here purely to be placed on disk.
 */
export function registerFileHandlers(): void {
  registerHandler('files:save', async (request: SaveFileRequest): Promise<SaveFileResult> => {
    const { defaultName, filters, data } = request ?? ({} as SaveFileRequest);
    if (!(data instanceof Uint8Array)) {
      throw new AppError(400, 'Nothing to save.');
    }

    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = parent
      ? await dialog.showSaveDialog(parent, { defaultPath: defaultName, filters })
      : await dialog.showSaveDialog({ defaultPath: defaultName, filters });

    // Dismissing the dialog is a normal outcome, not a failure — the grid shows nothing.
    if (result.canceled || !result.filePath) return { saved: false };

    try {
      await fs.writeFile(result.filePath, data);
    } catch (err) {
      throw new AppError(
        500,
        `Could not write ${result.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { saved: true, path: result.filePath };
  });
}

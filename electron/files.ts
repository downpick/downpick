import { BrowserWindow, dialog } from 'electron';
import * as fs from 'fs/promises';
import {
  PickVaultFileRequest,
  PickVaultFileResult,
  SaveFileRequest,
  SaveFileResult,
} from '../server/channels';
import { AppError, registerHandler } from '../server/dispatch';
import { validateVaultFile } from '../server/handlers/settings';

/** Offered in both vault dialogs. `.enc` first, but nothing stops a vault being named otherwise. */
const VAULT_FILTERS = [
  { name: 'Downpick vault', extensions: ['enc'] },
  { name: 'All Files', extensions: ['*'] },
];

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

  /**
   * The native file dialog behind the first-run vault screen.
   *
   * Lives here rather than in `server/handlers/` for the same reason `files:save` does: it
   * needs a BrowserWindow to parent the sheet. The `open` mode validates what came back, so
   * the renderer learns a wrong pick is not a vault without `settings:validate` having to step
   * out from behind the vault gate.
   */
  registerHandler(
    'files:pickVault',
    async (request: PickVaultFileRequest): Promise<PickVaultFileResult> => {
      const { mode, defaultPath } = request ?? ({} as PickVaultFileRequest);
      if (mode !== 'open' && mode !== 'create') {
        throw new AppError(400, 'Unknown file dialog mode.');
      }

      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = { defaultPath, filters: VAULT_FILTERS };

      if (mode === 'create') {
        const result = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { canceled: true };
        return { canceled: false, path: result.filePath };
      }

      const openOptions = { ...options, properties: ['openFile' as const] };
      const result = parent
        ? await dialog.showOpenDialog(parent, openOptions)
        : await dialog.showOpenDialog(openOptions);
      const [picked] = result.filePaths ?? [];
      if (result.canceled || !picked) return { canceled: true };

      return { canceled: false, path: picked, ...validateVaultFile(picked) };
    },
  );
}

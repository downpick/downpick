import type { MessageBoxOptions } from 'electron';
import type { AppUpdater } from 'electron-updater';

type Updater = Pick<AppUpdater,
  'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade' |
  'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'> & {
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

export interface UpdateUI {
  show(options: MessageBoxOptions): Promise<number>;
  openReleases(): Promise<void>;
  hasRunningQueries(): boolean;
  quitWith(install: () => void): void;
  installationFailed(): void;
  changed(): void;
  log(error: unknown): void;
}

export function unsupportedUpdateReason(options: {
  packaged: boolean;
  configured: boolean;
  platform: string;
  appImage: boolean;
  portable: boolean;
  macDeveloperSigned: boolean;
}): string | undefined {
  if (!options.packaged) return 'Updates are available only in an installed release of Downpick.';
  if (options.platform === 'darwin' && !options.macDeveloperSigned) {
    return 'This macOS build does not have a Developer ID signature. Download and install the latest release manually.';
  }
  if (options.platform === 'win32' && options.portable) {
    return 'Portable builds cannot update automatically. Install the latest Downpick Setup installer to enable updates.';
  }
  if (options.platform === 'linux' && !options.appImage) {
    return 'Automatic updates on Linux require running the AppImage release.';
  }
  if (!options.configured) return 'This build has no update feed. Download and install the latest release manually.';
  if (!['darwin', 'win32', 'linux'].includes(options.platform)) {
    return 'Automatic updates are not supported on this platform.';
  }
  return undefined;
}

/** Main-process update flow; UI and the installer are injected so races can be tested. */
export class UpdateController {
  private state: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle';
  private version = '';
  private percent = 0;
  private manual = false;
  private stopped = false;
  private dialogOpen = false;
  private operation = false;
  private installing = false;

  constructor(
    private readonly updater: Updater,
    private readonly ui: UpdateUI,
    readonly unsupportedReason?: string,
  ) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('update-available', (info) => { this.version = info.version; });
    updater.on('download-progress', (progress) => {
      const percent = Math.floor(progress.percent / 10) * 10;
      if (this.percent !== percent) {
        this.percent = percent;
        this.ui.changed();
      }
    });
    updater.on('update-downloaded', (info) => {
      this.version = info.version;
      this.setState('ready');
      void this.offerInstall().catch((error) => this.ui.log(error));
    });
    // An error listener is mandatory: EventEmitter otherwise throws. Rejected check and
    // download promises are handled below; native staging errors can arrive later on Mac.
    updater.on('error', (error) => {
      this.ui.log(error);
      if ((!this.operation || this.installing) && !this.stopped) {
        if (this.installing) this.ui.installationFailed();
        this.installing = false;
        this.setState('idle');
        void this.message('Could not prepare the update', 'Please try Check for Updates again.');
      }
    });
  }

  get menuLabel(): string {
    if (this.installing) return 'Installing Update…';
    if (this.state === 'checking') return 'Checking for Updates…';
    if (this.state === 'downloading') return `Downloading Update… ${this.percent}%`;
    if (this.state === 'ready') return 'Restart and Update…';
    return 'Check for Updates…';
  }

  stop(): void { this.stopped = true; }

  private setState(state: typeof this.state): void {
    this.state = state;
    if (!this.stopped) this.ui.changed();
  }

  private async message(message: string, detail: string): Promise<void> {
    if (this.stopped || this.dialogOpen) return;
    this.dialogOpen = true;
    try {
      await this.ui.show({ type: 'info', title: 'Downpick Updates', message, detail, buttons: ['OK'] });
    } catch (error) {
      this.ui.log(error);
    } finally {
      this.dialogOpen = false;
    }
  }

  async check(manual = false): Promise<void> {
    if (this.stopped || this.installing) return;
    if (this.operation) {
      this.manual ||= manual;
      return;
    }
    if (this.dialogOpen) return;
    if (this.unsupportedReason) {
      if (!manual) return;
      this.dialogOpen = true;
      try {
        const response = await this.ui.show({
          type: 'info', title: 'Downpick Updates', message: 'Manual update required',
          detail: this.unsupportedReason, buttons: ['Open Downloads', 'Cancel'],
          defaultId: 0, cancelId: 1,
        });
        if (response === 0 && !this.stopped) await this.ui.openReleases();
      } catch (error) { this.ui.log(error); }
      finally { this.dialogOpen = false; }
      return;
    }
    if (this.state === 'ready') {
      if (manual) await this.offerInstall();
      return;
    }
    if (this.state === 'downloading') return;

    this.operation = true;
    this.manual = manual;
    this.version = '';
    this.setState('checking');
    let downloading = false;
    try {
      const result = await this.updater.checkForUpdates();
      if (this.stopped) return;
      if (!result) throw new Error('No update check result');
      if (!this.version) {
        this.setState('idle');
        if (this.manual) await this.message('You’re up to date', 'Downpick is running the latest available version.');
        return;
      }
      downloading = true;
      this.percent = 0;
      this.setState('downloading');
      await this.updater.downloadUpdate();
    } catch (error) {
      this.ui.log(error);
      this.setState('idle');
      if (this.manual || downloading) {
        await this.message('Could not update Downpick', 'Check your internet connection and try Check for Updates again. You can also download the latest release from Downpick on GitHub.');
      }
    } finally {
      this.operation = false;
      this.manual = false;
    }
  }

  private async offerInstall(): Promise<void> {
    if (this.stopped || this.dialogOpen || this.installing) return;
    if (this.ui.hasRunningQueries()) {
      await this.message('Update ready', 'Wait for your running queries to finish, then choose Restart and Update from the application menu.');
      return;
    }
    this.dialogOpen = true;
    let response: number;
    try {
      response = await this.ui.show({
        type: 'info', title: 'Downpick Updates', message: `Downpick ${this.version} is ready`,
        detail: 'Restart to install the update. Save any work you want to keep before restarting.',
        buttons: ['Restart and Update', 'Later'], defaultId: 1, cancelId: 1,
      });
    } finally {
      this.dialogOpen = false;
    }
    if (response !== 0 || this.stopped || this.state !== 'ready') return;
    // A query may have started in another window while the dialog was open.
    if (this.ui.hasRunningQueries()) {
      await this.message('Queries are still running', 'Wait for them to finish or cancel them before restarting to update.');
      return;
    }
    this.installing = true;
    this.ui.changed();
    this.ui.quitWith(() => {
      try {
        this.updater.quitAndInstall(false, true);
      } catch (error) {
        this.ui.installationFailed();
        this.installing = false;
        this.setState('idle');
        this.ui.log(error);
        void this.message('Could not install the update', 'Please try Check for Updates again.');
      }
    });
  }
}

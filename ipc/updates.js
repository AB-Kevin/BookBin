const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const REPO_OWNER = 'AB-Kevin';
const REPO_NAME = 'BookBin';
const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

// Driven entirely from the renderer's "Check for Updates" button — never
// checks or downloads in the background on its own, so nothing happens on
// the user's bandwidth/disk without them asking for it first.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
// Lets "Check for Updates" actually hit GitHub when running unpacked (npm
// start), reading dev-app-update.yml instead of silently no-op'ing. Has no
// effect on a packaged build — those always use the real app-update.yml
// electron-builder generates, regardless of this flag.
autoUpdater.forceDevUpdateConfig = true;

// Mac builds are only ad-hoc signed (no paid Apple Developer ID), which is
// enough for the app to launch but not enough for Squirrel.Mac — the
// mechanism electron-updater uses under the hood on macOS — to silently
// install an update; it requires a real Developer ID signature to do that.
// So on Mac, checking for updates still works (it just reads the version
// info electron-builder publishes), but instead of downloading/installing
// in-app, we hand the user off to the GitHub release page to grab the new
// .dmg themselves.
const IS_MAC = process.platform === 'darwin';

module.exports = function registerUpdates(ipcMain, getMainWindow) {
  function send(status) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('updates:status', status);
  }

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    send({ state: IS_MAC ? 'available-manual' : 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => send({ state: 'not-available' }));
  autoUpdater.on('download-progress', (progress) => {
    send({ state: 'downloading', percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => send({ state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => send({ state: 'error', message: err?.message || String(err) }));

  ipcMain.handle('updates:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      send({ state: 'error', message: err?.message || String(err) });
    }
  });

  ipcMain.handle('updates:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      send({ state: 'error', message: err?.message || String(err) });
    }
  });

  ipcMain.handle('updates:quitAndInstall', () => autoUpdater.quitAndInstall());
  ipcMain.handle('updates:openReleasesPage', () => shell.openExternal(RELEASES_URL));
  ipcMain.handle('updates:getVersion', () => app.getVersion());
};

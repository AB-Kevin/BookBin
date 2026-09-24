const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { setWorkspaceDir, ensureWorkspaceDirs, logoDir } = require('../workspace');

module.exports = function registerWorkspace(ipcMain, db, currentWorkspaceDir) {
  ipcMain.handle('workspace:get', () => currentWorkspaceDir);

  ipcMain.handle('workspace:choose', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Choose Shared Workspace Folder',
      defaultPath: currentWorkspaceDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };

    const newDir = filePaths[0];
    if (path.resolve(newDir) === path.resolve(currentWorkspaceDir)) {
      return { ok: false, canceled: true };
    }

    ensureWorkspaceDirs(newDir);

    // First-time share setup: bring the existing database and logo along if
    // the chosen folder doesn't already have its own (e.g. it's empty, as
    // opposed to a folder another device already set up as the shared one).
    //
    // VACUUM INTO rather than copying bookbin.db: the database is open right
    // now and anything committed since the last checkpoint lives in the -wal
    // file, which a plain file copy would leave behind. VACUUM INTO writes
    // everything committed as one self-contained file with no WAL beside it,
    // which is also exactly the shape we want landing in a synced folder.
    const oldDbPath = path.join(currentWorkspaceDir, 'bookbin.db');
    const newDbPath = path.join(newDir, 'bookbin.db');
    if (fs.existsSync(oldDbPath) && !fs.existsSync(newDbPath)) {
      db.prepare('VACUUM INTO ?').run(newDbPath);
      const oldLogoDir = logoDir(currentWorkspaceDir);
      if (fs.existsSync(oldLogoDir)) {
        fs.cpSync(oldLogoDir, logoDir(newDir), { recursive: true });
      }
    }

    setWorkspaceDir(newDir);
    app.relaunch();
    // quit(), not exit(): exit() skips 'before-quit', which is where the old
    // workspace's database gets checkpointed and closed.
    app.quit();
    return { ok: true, restarting: true };
  });
};

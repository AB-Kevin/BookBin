const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { setWorkspaceDir, ensureWorkspaceDirs, logoDir } = require('../workspace');

module.exports = function registerWorkspace(ipcMain, currentWorkspaceDir) {
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
    const oldDbPath = path.join(currentWorkspaceDir, 'bookbin.db');
    const newDbPath = path.join(newDir, 'bookbin.db');
    if (fs.existsSync(oldDbPath) && !fs.existsSync(newDbPath)) {
      fs.copyFileSync(oldDbPath, newDbPath);
      const oldLogoDir = logoDir(currentWorkspaceDir);
      if (fs.existsSync(oldLogoDir)) {
        fs.cpSync(oldLogoDir, logoDir(newDir), { recursive: true });
      }
    }

    setWorkspaceDir(newDir);
    app.relaunch();
    app.exit(0);
    return { ok: true, restarting: true };
  });
};

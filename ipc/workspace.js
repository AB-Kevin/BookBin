const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { setWorkspaceDir, ensureWorkspaceDirs, logoDir, attachmentsDir } = require('../workspace');

// Where BookBin keeps its local files. This used to be how two machines shared
// one database, and choosing a synced folder was the whole point; the database
// is in Postgres now, so this folder holds only the company logo and invoice
// attachments. Moving it therefore copies those files rather than a database,
// and no longer has anything to do with how people share their work.
module.exports = function registerWorkspace(ipcMain, currentWorkspaceDir) {
  ipcMain.handle('workspace:get', () => currentWorkspaceDir);

  ipcMain.handle('workspace:choose', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Choose Folder for Logo and Attachments',
      defaultPath: currentWorkspaceDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };

    const newDir = filePaths[0];
    if (path.resolve(newDir) === path.resolve(currentWorkspaceDir)) {
      return { ok: false, canceled: true };
    }

    ensureWorkspaceDirs(newDir);

    // Bring existing files along. Copied rather than moved, and only where the
    // destination has nothing of its own: an invoice row points at a filename,
    // so a file left behind is an attachment that silently fails to open.
    const oldLogoDir = logoDir(currentWorkspaceDir);
    if (fs.existsSync(oldLogoDir) && !fs.readdirSync(logoDir(newDir)).length) {
      fs.cpSync(oldLogoDir, logoDir(newDir), { recursive: true });
    }
    for (const kind of ['incoming', 'outgoing']) {
      const from = attachmentsDir(currentWorkspaceDir, kind);
      const to = attachmentsDir(newDir, kind);
      if (fs.existsSync(from) && !fs.readdirSync(to).length) {
        fs.cpSync(from, to, { recursive: true });
      }
    }

    setWorkspaceDir(newDir);
    // The folder is read once at startup and handed to each handler, so a
    // restart is how the new location takes effect.
    app.relaunch();
    app.quit();
    return { ok: true, restarting: true };
  });
};

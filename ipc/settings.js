const { dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { logoDir } = require('../workspace');

module.exports = function registerSettings(ipcMain, db, workspaceDir) {
  const getStmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const updateStmt = db.prepare(`
    UPDATE settings SET
      company_name = @company_name,
      company_address = @company_address,
      company_logo_path = @company_logo_path,
      incoming_prefix = @incoming_prefix,
      incoming_next_number = @incoming_next_number,
      outgoing_prefix = @outgoing_prefix,
      outgoing_next_number = @outgoing_next_number,
      low_stock_threshold = @low_stock_threshold
    WHERE id = 1
  `);

  // company_logo_path is stored as just a filename inside <workspace>/logo so
  // it stays portable across devices sharing a workspace folder. This adds a
  // resolved, absolute file:// URL for the renderer to preview, without
  // touching the stored value. Older settings that still hold a full absolute
  // path (from before workspaces existed) are passed through as-is.
  function withLogoUrl(row) {
    if (!row) return row;
    if (!row.company_logo_path) return { ...row, company_logo_url: null };
    const absPath = path.isAbsolute(row.company_logo_path)
      ? row.company_logo_path
      : path.join(logoDir(workspaceDir), row.company_logo_path);
    return { ...row, company_logo_url: `file://${absPath.replace(/\\/g, '/')}` };
  }

  ipcMain.handle('settings:get', () => withLogoUrl(getStmt.get()));
  ipcMain.handle('settings:update', (_e, data) => {
    const current = getStmt.get();
    updateStmt.run({ ...current, ...data });
    return withLogoUrl(getStmt.get());
  });

  ipcMain.handle('settings:chooseLogo', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Choose Company Logo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (canceled || !filePaths.length) return withLogoUrl(getStmt.get());

    const current = getStmt.get();
    const fileName = `logo${path.extname(filePaths[0]).toLowerCase()}`;
    fs.mkdirSync(logoDir(workspaceDir), { recursive: true });

    // Clean up a previous logo saved under a different extension so it
    // doesn't linger as an orphaned file in the shared folder.
    if (current.company_logo_path && !path.isAbsolute(current.company_logo_path) && current.company_logo_path !== fileName) {
      fs.rmSync(path.join(logoDir(workspaceDir), current.company_logo_path), { force: true });
    }

    fs.copyFileSync(filePaths[0], path.join(logoDir(workspaceDir), fileName));
    updateStmt.run({ ...current, company_logo_path: fileName });
    return withLogoUrl(getStmt.get());
  });

  ipcMain.handle('settings:removeLogo', () => {
    const current = getStmt.get();
    if (current.company_logo_path && !path.isAbsolute(current.company_logo_path)) {
      fs.rmSync(path.join(logoDir(workspaceDir), current.company_logo_path), { force: true });
    }
    updateStmt.run({ ...current, company_logo_path: null });
    return withLogoUrl(getStmt.get());
  });
};

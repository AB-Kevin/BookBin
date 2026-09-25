// Company details, invoice numbering, and the logo.
//
// Ported to Supabase. The logo file itself stays on local disk for now, like
// invoice attachments: only its filename lives in the row.

const { dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { logoDir } = require('../workspace');
const { table, unwrap, numericColumns } = require('../db/rest');

// Only these are writable. The renderer is handed extra fields on the way out
// (company_logo_url), and echoing those back would be an update to a column
// that does not exist.
const WRITABLE = [
  'company_name', 'company_address', 'company_logo_path',
  'incoming_prefix', 'incoming_next_number',
  'outgoing_prefix', 'outgoing_next_number',
  'low_stock_threshold', 'cost_markup_percent',
];

const NUMERIC = new Set([
  'incoming_next_number', 'outgoing_next_number',
  'low_stock_threshold', 'cost_markup_percent',
]);

const coerceSettings = numericColumns('low_stock_threshold', 'cost_markup_percent');

function writableFields(data) {
  const out = {};
  for (const key of WRITABLE) {
    if (!(key in data)) continue;
    // Form fields arrive as strings; Postgres is stricter about that than
    // SQLite was, and an empty numeric string would be rejected outright.
    if (NUMERIC.has(key)) {
      const n = Number(data[key]);
      out[key] = Number.isFinite(n) ? n : 0;
    } else {
      out[key] = data[key];
    }
  }
  return out;
}

module.exports = function registerSettings(ipcMain, workspaceDir) {
  // company_logo_path is stored as just a filename inside <workspace>/logo so
  // it stays portable across devices sharing a workspace folder. This adds a
  // resolved, absolute file:// URL for the renderer to preview, without
  // touching the stored value. Older settings that still hold a full absolute
  // path (from before workspaces existed) are passed through as-is.
  function withLogoUrl(row) {
    if (!row) return row;
    const settings = coerceSettings(row);
    if (!settings.company_logo_path) return { ...settings, company_logo_url: null };
    const absPath = path.isAbsolute(settings.company_logo_path)
      ? settings.company_logo_path
      : path.join(logoDir(workspaceDir), settings.company_logo_path);
    return { ...settings, company_logo_url: `file://${absPath.replace(/\\/g, '/')}` };
  }

  async function getSettings() {
    return unwrap(await table('settings').select('*').eq('id', 1).single());
  }

  async function updateSettings(fields) {
    return unwrap(
      await table('settings').update(fields).eq('id', 1).select('*').single()
    );
  }

  ipcMain.handle('settings:get', async () => withLogoUrl(await getSettings()));

  ipcMain.handle('settings:update', async (_e, data) => {
    return withLogoUrl(await updateSettings(writableFields(data)));
  });

  ipcMain.handle('settings:chooseLogo', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Choose Company Logo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (canceled || !filePaths.length) return withLogoUrl(await getSettings());

    const current = await getSettings();
    const fileName = `logo${path.extname(filePaths[0]).toLowerCase()}`;
    fs.mkdirSync(logoDir(workspaceDir), { recursive: true });

    // Clean up a previous logo saved under a different extension so it
    // doesn't linger as an orphaned file in the shared folder.
    if (
      current.company_logo_path &&
      !path.isAbsolute(current.company_logo_path) &&
      current.company_logo_path !== fileName
    ) {
      fs.rmSync(path.join(logoDir(workspaceDir), current.company_logo_path), { force: true });
    }

    fs.copyFileSync(filePaths[0], path.join(logoDir(workspaceDir), fileName));
    return withLogoUrl(await updateSettings({ company_logo_path: fileName }));
  });

  ipcMain.handle('settings:removeLogo', async () => {
    const current = await getSettings();
    if (current.company_logo_path && !path.isAbsolute(current.company_logo_path)) {
      fs.rmSync(path.join(logoDir(workspaceDir), current.company_logo_path), { force: true });
    }
    return withLogoUrl(await updateSettings({ company_logo_path: null }));
  });
};

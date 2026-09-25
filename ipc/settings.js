// Company details, invoice numbering, and the logo.
//
// Ported to Supabase. The logo is a stored object like invoice attachments;
// the row keeps its object path, and a local copy is cached for previewing
// and for the PDF template, both of which need a real file:// URL.

const { dialog, BrowserWindow } = require('electron');
const path = require('path');
const storage = require('../db/storage');
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

// Turns whatever company_logo_path holds into an absolute local path.
//
// A storage object is downloaded and cached; an absolute path from before any
// of this is used as-is. Only the first is written now.
//
// Returns null rather than throwing if the object cannot be fetched: a logo
// that will not download should not stop the settings screen from opening.
async function resolveLogoPath(storedPath) {
  if (!storedPath) return null;
  if (storage.isStoragePath(storedPath)) {
    try {
      return await storage.ensureLocalCopy(storedPath);
    } catch (err) {
      console.error('BookBin: could not fetch the logo —', err.message);
      return null;
    }
  }
  return path.isAbsolute(storedPath) ? storedPath : null;
}

/** Used by the PDF export, which needs a real path for its file:// src. */
async function resolveCompanyLogo(company) {
  if (!company || !company.company_logo_path) return company;
  return { ...company, company_logo_path: await resolveLogoPath(company.company_logo_path) };
}

function registerSettings(ipcMain) {
  async function withLogoUrl(row) {
    if (!row) return row;
    const settings = coerceSettings(row);
    const absPath = await resolveLogoPath(settings.company_logo_path);
    if (!absPath) return { ...settings, company_logo_url: null };
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
    // Upload first: a failure here should leave the old logo in place rather
    // than clearing it and having nothing to fall back to.
    const objectPath = await storage.uploadFile('logo', filePaths[0]);
    await removeStoredLogo(current.company_logo_path);
    return withLogoUrl(await updateSettings({ company_logo_path: objectPath }));
  });

  ipcMain.handle('settings:removeLogo', async () => {
    const current = await getSettings();
    await removeStoredLogo(current.company_logo_path);
    return withLogoUrl(await updateSettings({ company_logo_path: null }));
  });

  // Best-effort: an orphaned logo costs a few kilobytes, while failing the
  // whole operation over it costs the user their change. A legacy file on
  // someone's disk is left alone -- not ours to delete.
  async function removeStoredLogo(storedPath) {
    if (storedPath && storage.isStoragePath(storedPath)) await storage.removeFile(storedPath);
  }
}

module.exports = registerSettings;
module.exports.resolveCompanyLogo = resolveCompanyLogo;

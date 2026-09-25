// Backup settings and the daily schedule.
//
// The folder is a per-machine setting (see config/local.js) and starts unset,
// which means backups are off until somebody chooses where they should go.
//
// Everything here is per database as well: each entry in the database list
// has its own folder, schedule and last result, and only the open one is
// backed up -- a database nobody has signed in to cannot be read anyway.

const { dialog, BrowserWindow } = require('electron');
const local = require('../config/local');
const { runBackup, isDue, KEEP } = require('../db/backup');
const { getCurrentDatabase } = require('../db/supabase');

// Keyed by the open database's id, so two databases never share a schedule.
function keysFor(db) {
  return {
    FOLDER_KEY: `backupDir:${db.id}`,
    LAST_RUN_KEY: `backupLastRun:${db.id}`,
    LAST_RESULT_KEY: `backupLastResult:${db.id}`,
  };
}

function openDatabase() {
  const db = getCurrentDatabase();
  if (!db) throw new Error('No database is open.');
  return db;
}

// Checked hourly rather than daily: a desktop app is closed far more often
// than it runs for 24 hours, so "once a day" in practice means "soon after
// the first launch of the day".
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function status() {
  const db = getCurrentDatabase();
  if (!db) return { folder: null, lastRun: null, lastResult: null, keep: KEEP };
  const { FOLDER_KEY, LAST_RUN_KEY, LAST_RESULT_KEY } = keysFor(db);
  return {
    folder: local.get(FOLDER_KEY),
    lastRun: local.get(LAST_RUN_KEY),
    lastResult: local.get(LAST_RESULT_KEY),
    keep: KEEP,
  };
}

function recordResult(db, result) {
  const { LAST_RUN_KEY, LAST_RESULT_KEY } = keysFor(db);
  local.set(LAST_RUN_KEY, result.at || new Date().toISOString());
  local.set(LAST_RESULT_KEY, result.ok
    ? { ok: true, rowCount: result.rowCount, file: result.file }
    : { ok: false, error: result.error });
}

async function backupIfDue() {
  const db = getCurrentDatabase();
  if (!db) return null;
  const { FOLDER_KEY, LAST_RUN_KEY } = keysFor(db);
  const folder = local.get(FOLDER_KEY);
  if (!folder) return null;
  if (!isDue(local.get(LAST_RUN_KEY))) return null;

  const result = await runBackup(folder, db.backupTag);
  recordResult(db, result);
  if (!result.ok) console.error('BookBin: scheduled backup failed —', result.error);
  return result;
}

module.exports = function registerBackup(ipcMain) {
  ipcMain.handle('backup:status', () => status());

  ipcMain.handle('backup:chooseFolder', async (event) => {
    const { FOLDER_KEY } = keysFor(openDatabase());
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Choose Backup Folder',
      defaultPath: local.get(FOLDER_KEY) || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return status();
    local.set(FOLDER_KEY, filePaths[0]);
    return status();
  });

  ipcMain.handle('backup:disable', () => {
    const { FOLDER_KEY } = keysFor(openDatabase());
    local.set(FOLDER_KEY, null);
    return status();
  });

  ipcMain.handle('backup:runNow', async () => {
    const db = getCurrentDatabase();
    if (!db) return { ok: false, error: 'No database is open.' };
    const folder = local.get(keysFor(db).FOLDER_KEY);
    if (!folder) return { ok: false, error: 'Choose a backup folder first.' };
    const result = await runBackup(folder, db.backupTag);
    recordResult(db, result);
    return result;
  });

  return { backupIfDue, CHECK_INTERVAL_MS };
};

module.exports.backupIfDue = backupIfDue;
module.exports.CHECK_INTERVAL_MS = CHECK_INTERVAL_MS;

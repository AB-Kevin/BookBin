// Backup settings and the daily schedule.
//
// The folder is a per-machine setting (see config/local.js) and starts unset,
// which means backups are off until somebody chooses where they should go.

const { dialog, BrowserWindow } = require('electron');
const local = require('../config/local');
const { runBackup, isDue, KEEP } = require('../db/backup');

const FOLDER_KEY = 'backupDir';
const LAST_RUN_KEY = 'backupLastRun';
const LAST_RESULT_KEY = 'backupLastResult';

// Checked hourly rather than daily: a desktop app is closed far more often
// than it runs for 24 hours, so "once a day" in practice means "soon after
// the first launch of the day".
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function status() {
  return {
    folder: local.get(FOLDER_KEY),
    lastRun: local.get(LAST_RUN_KEY),
    lastResult: local.get(LAST_RESULT_KEY),
    keep: KEEP,
  };
}

function recordResult(result) {
  local.set(LAST_RUN_KEY, result.at || new Date().toISOString());
  local.set(LAST_RESULT_KEY, result.ok
    ? { ok: true, rowCount: result.rowCount, file: result.file }
    : { ok: false, error: result.error });
}

async function backupIfDue() {
  const folder = local.get(FOLDER_KEY);
  if (!folder) return null;
  if (!isDue(local.get(LAST_RUN_KEY))) return null;

  const result = await runBackup(folder);
  recordResult(result);
  if (!result.ok) console.error('BookBin: scheduled backup failed —', result.error);
  return result;
}

module.exports = function registerBackup(ipcMain) {
  ipcMain.handle('backup:status', () => status());

  ipcMain.handle('backup:chooseFolder', async (event) => {
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
    local.set(FOLDER_KEY, null);
    return status();
  });

  ipcMain.handle('backup:runNow', async () => {
    const folder = local.get(FOLDER_KEY);
    if (!folder) return { ok: false, error: 'Choose a backup folder first.' };
    const result = await runBackup(folder);
    recordResult(result);
    return result;
  });

  return { backupIfDue, CHECK_INTERVAL_MS };
};

module.exports.backupIfDue = backupIfDue;
module.exports.CHECK_INTERVAL_MS = CHECK_INTERVAL_MS;

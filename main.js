const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { initDatabase } = require('./db');
const { getWorkspaceDir, ensureWorkspaceDirs } = require('./workspace');

const registerItems = require('./ipc/items');
const registerVendors = require('./ipc/vendors');
const registerCustomers = require('./ipc/customers');
const registerIncomingInvoices = require('./ipc/incomingInvoices');
const registerOutgoingInvoices = require('./ipc/outgoingInvoices');
const registerSettings = require('./ipc/settings');
const registerDashboard = require('./ipc/dashboard');
const registerUpdates = require('./ipc/updates');
const registerWorkspace = require('./ipc/workspace');
const registerShell = require('./ipc/shell');
const registerCosting = require('./ipc/costing');
const registerLock = require('./ipc/lock');
const registerActivityMonitor = require('./ipc/activity');

let mainWindow;
let lockController = null;

// Channels that never touch the shared database (or are pure reads of it)
// stay usable even while another device holds the write lock. Every channel
// not listed here — including any added later — is blocked by default while
// read-only, via the ipcMain.handle wrapper below; that fails closed rather
// than open if a new mutating handler is added without updating this list.
const READONLY_EXEMPT_SUFFIXES = new Set(['list', 'get', 'history']);
const READONLY_EXEMPT_CHANNELS = new Set([
  'dashboard:summary',
  'incomingInvoices:chooseAttachment', 'incomingInvoices:openAttachment',
  'outgoingInvoices:chooseAttachment', 'outgoingInvoices:openAttachment',
  'workspace:choose',
  'shell:openExternal',
  'updates:check', 'updates:download', 'updates:quitAndInstall', 'updates:openReleasesPage', 'updates:getVersion',
  'lock:getStatus', 'lock:requestAccess', 'lock:respondToRequest',
]);

function installReadOnlyGuard() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const suffix = channel.includes(':') ? channel.split(':')[1] : '';
    if (READONLY_EXEMPT_CHANNELS.has(channel) || READONLY_EXEMPT_SUFFIXES.has(suffix)) {
      return originalHandle(channel, listener);
    }
    return originalHandle(channel, (event, ...args) => {
      if (lockController && lockController.isReadOnly()) {
        throw new Error('This database is currently open elsewhere and is read-only.');
      }
      return listener(event, ...args);
    });
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    icon: path.join(__dirname, 'build', 'BookBin-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const workspaceDir = getWorkspaceDir();
  ensureWorkspaceDirs(workspaceDir);
  const db = initDatabase(workspaceDir);

  installReadOnlyGuard();

  registerItems(ipcMain, db);
  registerVendors(ipcMain, db);
  registerCustomers(ipcMain, db);
  registerIncomingInvoices(ipcMain, db, workspaceDir);
  registerOutgoingInvoices(ipcMain, db, workspaceDir);
  registerSettings(ipcMain, db, workspaceDir);
  registerDashboard(ipcMain, db);
  registerUpdates(ipcMain, () => mainWindow);
  registerWorkspace(ipcMain, workspaceDir);
  registerShell(ipcMain);
  registerCosting(ipcMain, db);

  lockController = registerLock(ipcMain, workspaceDir, () => mainWindow);
  registerActivityMonitor(ipcMain, () => mainWindow, () => app.quit());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (lockController) lockController.releaseIfHeld();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

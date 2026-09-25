const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { initDatabase, backupDatabase, closeDatabase } = require('./db');
const { getWorkspaceDir, ensureWorkspaceDirs } = require('./workspace');

const registerItems = require('./ipc/items');
const { registerVendors, registerCustomers } = require('./ipc/contacts');
const registerIncomingInvoices = require('./ipc/incomingInvoices');
const registerOutgoingInvoices = require('./ipc/outgoingInvoices');
const registerSettings = require('./ipc/settings');
const registerDashboard = require('./ipc/dashboard');
const registerUpdates = require('./ipc/updates');
const registerWorkspace = require('./ipc/workspace');
const registerShell = require('./ipc/shell');
const registerCosting = require('./ipc/costing');
const registerPurchaseOrders = require('./ipc/purchaseOrders');
const registerPurchaseOrderItems = require('./ipc/purchaseOrderItems');
const registerLock = require('./ipc/lock');
const registerActivityMonitor = require('./ipc/activity');
const registerAuth = require('./ipc/auth');

let mainWindow;
let db = null;
let lockController = null;
let authController = null;

// Channels that never touch the shared database (or are pure reads of it)
// stay usable even while another device holds the write lock. Every channel
// not listed here — including any added later — is blocked by default while
// read-only, via the ipcMain.handle wrapper below; that fails closed rather
// than open if a new mutating handler is added without updating this list.
const READONLY_EXEMPT_SUFFIXES = new Set(['list', 'get', 'history']);

// Domains already moved to Supabase. The read-only guard below exists to
// protect the shared SQLite file from a second writer; a domain that no
// longer reads or writes that file has nothing to be protected from, and
// blocking it would be a lock on a database it does not use. This set
// shrinks to nothing -- along with the whole lock mechanism -- once every
// domain has moved.
const PORTED_DOMAINS = new Set(['vendors', 'customers']);
const READONLY_EXEMPT_CHANNELS = new Set([
  'dashboard:summary',
  'incomingInvoices:chooseAttachment', 'incomingInvoices:openAttachment',
  'outgoingInvoices:chooseAttachment', 'outgoingInvoices:openAttachment',
  'workspace:choose',
  'shell:openExternal',
  'updates:check', 'updates:download', 'updates:quitAndInstall', 'updates:openReleasesPage', 'updates:getVersion',
  'lock:getStatus', 'lock:requestAccess', 'lock:respondToRequest',
  'auth:signIn', 'auth:signOut', 'auth:getSession', 'auth:getProfile',
  'purchaseOrderItems:invoices',
]);

function installReadOnlyGuard() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const [domain, suffix = ''] = channel.split(':');
    if (PORTED_DOMAINS.has(domain)
        || READONLY_EXEMPT_CHANNELS.has(channel)
        || READONLY_EXEMPT_SUFFIXES.has(suffix)) {
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
  db = initDatabase(workspaceDir);

  installReadOnlyGuard();

  registerItems(ipcMain, db);
  registerVendors(ipcMain);
  registerCustomers(ipcMain);
  registerIncomingInvoices(ipcMain, db, workspaceDir);
  registerOutgoingInvoices(ipcMain, db, workspaceDir);
  registerSettings(ipcMain, db, workspaceDir);
  registerDashboard(ipcMain, db);
  registerUpdates(ipcMain, () => mainWindow);
  registerWorkspace(ipcMain, db, workspaceDir);
  registerShell(ipcMain);
  registerCosting(ipcMain, db);
  registerPurchaseOrders(ipcMain, db);
  registerPurchaseOrderItems(ipcMain, db);

  authController = registerAuth(ipcMain, () => mainWindow);

  lockController = registerLock(ipcMain, workspaceDir, () => mainWindow);
  registerActivityMonitor(ipcMain, () => mainWindow, () => app.quit());

  // Only the write-lock holder snapshots; see backupDatabase. registerLock
  // resolves the lock synchronously, so this reflects the real state.
  if (!lockController.isReadOnly()) backupDatabase(db, workspaceDir);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Release the lock first, then checkpoint and close — a device waiting on the
// lock should see it freed without waiting on the checkpoint, and the
// checkpoint doesn't need the lock since we're the only writer either way.
app.on('before-quit', () => {
  if (lockController) lockController.releaseIfHeld();
  closeDatabase(db);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

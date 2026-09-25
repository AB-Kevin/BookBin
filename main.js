const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const registerItems = require('./ipc/items');
const { registerVendors, registerCustomers } = require('./ipc/contacts');
const registerIncomingInvoices = require('./ipc/incomingInvoices');
const registerOutgoingInvoices = require('./ipc/outgoingInvoices');
const registerSettings = require('./ipc/settings');
const registerDashboard = require('./ipc/dashboard');
const registerUpdates = require('./ipc/updates');
const registerShell = require('./ipc/shell');
const registerTheme = require('./ipc/theme');
const registerCosting = require('./ipc/costing');
const {
  registerPurchaseOrders,
  registerPurchaseOrderItems,
  registerPurchaseOrderVendors,
} = require('./ipc/purchasing');
const registerActivityMonitor = require('./ipc/activity');
const registerAuth = require('./ipc/auth');
const registerUsers = require('./ipc/users');
const registerBackup = require('./ipc/backup');
const registerDatabases = require('./ipc/databases');
const registerSetup = require('./ipc/setup');

let mainWindow;
let authController = null;

// BookBin keeps nothing on disk any more. The database is in Postgres, the
// attachments and logo are in Supabase Storage, and the shared folder that
// used to hold all of it -- along with the single-writer lock that guarded it,
// the read-only mode that enforced that lock, and the backups that protected
// the file -- is gone. The only local state left is the list of databases this
// machine knows, a cached session for each, and downloaded copies of files,
// all in userData.

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    icon: path.join(__dirname, 'build', 'BookBin-512.png'),
    // The page background of the OS theme, so the first paint does not flash
    // white behind a dark page. The renderer takes over from there.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121512' : '#f7f6f2',
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
  registerItems(ipcMain);
  registerVendors(ipcMain);
  registerCustomers(ipcMain);
  registerIncomingInvoices(ipcMain);
  registerOutgoingInvoices(ipcMain);
  registerSettings(ipcMain);
  registerDashboard(ipcMain);
  registerUpdates(ipcMain, () => mainWindow);
  registerShell(ipcMain);
  registerTheme(ipcMain);
  registerCosting(ipcMain);
  registerPurchaseOrders(ipcMain);
  registerPurchaseOrderItems(ipcMain);
  registerPurchaseOrderVendors(ipcMain);

  authController = registerAuth(ipcMain, () => mainWindow);
  const users = registerUsers(ipcMain, {
    getProfile: () => authController.getProfile(),
    verifyPassword: (email, password) => authController.verifyPassword(email, password),
  });
  authController.onReset(users.lock);
  const backup = registerBackup(ipcMain);

  // Nothing is open at launch: the start screen picks a database first, which
  // is also what lets somebody install an update without signing in.
  registerDatabases(ipcMain, {
    onOpen: () => authController.loadForOpenDatabase(),
    onClose: async () => authController.closeDatabase(),
  });
  registerSetup(ipcMain, () => mainWindow);

  // Backups read the database, so they only run once somebody is signed in.
  // Checked on a timer as well as at startup: the app is often left open for
  // days, and a daily backup that only happens at launch would not be daily.
  const runBackupIfDue = () => {
    if (authController.isSignedIn()) backup.backupIfDue();
  };
  setInterval(runBackupIfDue, backup.CHECK_INTERVAL_MS);
  setTimeout(runBackupIfDue, 30 * 1000); // after startup has settled
  registerActivityMonitor(ipcMain, () => mainWindow, () => app.quit());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

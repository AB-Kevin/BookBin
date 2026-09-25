const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const registerItems = require('./ipc/items');
const { registerVendors, registerCustomers } = require('./ipc/contacts');
const registerIncomingInvoices = require('./ipc/incomingInvoices');
const registerOutgoingInvoices = require('./ipc/outgoingInvoices');
const registerSettings = require('./ipc/settings');
const registerDashboard = require('./ipc/dashboard');
const registerUpdates = require('./ipc/updates');
const registerShell = require('./ipc/shell');
const registerCosting = require('./ipc/costing');
const { registerPurchaseOrders, registerPurchaseOrderItems } = require('./ipc/purchasing');
const registerActivityMonitor = require('./ipc/activity');
const registerAuth = require('./ipc/auth');

let mainWindow;
let authController = null;

// BookBin keeps nothing on disk any more. The database is in Postgres, the
// attachments and logo are in Supabase Storage, and the shared folder that
// used to hold all of it -- along with the single-writer lock that guarded it,
// the read-only mode that enforced that lock, and the backups that protected
// the file -- is gone. The only local state left is a cached session and
// downloaded copies of files, both in userData, both disposable.

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
  registerItems(ipcMain);
  registerVendors(ipcMain);
  registerCustomers(ipcMain);
  registerIncomingInvoices(ipcMain);
  registerOutgoingInvoices(ipcMain);
  registerSettings(ipcMain);
  registerDashboard(ipcMain);
  registerUpdates(ipcMain, () => mainWindow);
  registerShell(ipcMain);
  registerCosting(ipcMain);
  registerPurchaseOrders(ipcMain);
  registerPurchaseOrderItems(ipcMain);

  authController = registerAuth(ipcMain, () => mainWindow);
  registerActivityMonitor(ipcMain, () => mainWindow, () => app.quit());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

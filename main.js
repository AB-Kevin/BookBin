const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
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
const { registerPurchaseOrders, registerPurchaseOrderItems } = require('./ipc/purchasing');
const registerActivityMonitor = require('./ipc/activity');
const registerAuth = require('./ipc/auth');

let mainWindow;
let authController = null;

// The workspace folder no longer holds a database -- only the company logo and
// invoice attachments, which are still local files. Everything else lives in
// Postgres, which is why the single-writer lock that used to guard this folder
// is gone, along with the read-only guard that enforced it and the rolling
// backups that protected it: several people editing at once is the database's
// job now, and it is considerably better at it than a JSON lock file passed
// between machines through a sync service.

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

  registerItems(ipcMain);
  registerVendors(ipcMain);
  registerCustomers(ipcMain);
  registerIncomingInvoices(ipcMain, workspaceDir);
  registerOutgoingInvoices(ipcMain, workspaceDir);
  registerSettings(ipcMain, workspaceDir);
  registerDashboard(ipcMain);
  registerUpdates(ipcMain, () => mainWindow);
  registerWorkspace(ipcMain, workspaceDir);
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

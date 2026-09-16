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

let mainWindow;

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

  registerItems(ipcMain, db);
  registerVendors(ipcMain, db);
  registerCustomers(ipcMain, db);
  registerIncomingInvoices(ipcMain, db);
  registerOutgoingInvoices(ipcMain, db, workspaceDir);
  registerSettings(ipcMain, db, workspaceDir);
  registerDashboard(ipcMain, db);
  registerUpdates(ipcMain, () => mainWindow);
  registerWorkspace(ipcMain, workspaceDir);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

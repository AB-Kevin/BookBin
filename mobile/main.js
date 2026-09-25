// The Android app's stand-in for main.js and preload.js together.
//
// The desktop runs its database code in Electron's main process and reaches
// it from the page through preload.js. There is no main process on Android,
// so scripts/build-mobile.js bundles that same code -- preload.js and the
// ipc/*.js modules, unchanged -- into one script for the page, with small
// stand-ins for Electron and Node in mobile/shims/. The result is the same
// window.api, answered by the same handlers, just without a process boundary
// in between.
//
// Registered below in the same way main.js does it. Left out on purpose:
//   updates   electron-updater cannot install an APK; stubbed instead
//   setup     creates tables and deploys functions from files on disk;
//             new databases are set up from the desktop app
//   activity  the desktop's close-when-idle timer; Android manages that itself
//   backup's timer, which writes files to a folder the phone does not have

const fs = require('fs');
const { ipcMain, mainWindow, app, shell, contentTypeOf } = require('electron');

const registerItems = require('../ipc/items');
const { registerVendors, registerCustomers } = require('../ipc/contacts');
const registerIncomingInvoices = require('../ipc/incomingInvoices');
const registerOutgoingInvoices = require('../ipc/outgoingInvoices');
const registerSettings = require('../ipc/settings');
const registerDashboard = require('../ipc/dashboard');
const registerShell = require('../ipc/shell');
const registerCosting = require('../ipc/costing');
const {
  registerPurchaseOrders,
  registerPurchaseOrderItems,
  registerPurchaseOrderVendors,
} = require('../ipc/purchasing');
const registerAuth = require('../ipc/auth');
const registerUsers = require('../ipc/users');
const registerBackup = require('../ipc/backup');
const registerDatabases = require('../ipc/databases');

registerItems(ipcMain);
registerVendors(ipcMain);
registerCustomers(ipcMain);
registerIncomingInvoices(ipcMain);
registerOutgoingInvoices(ipcMain);
registerSettings(ipcMain);
registerDashboard(ipcMain);
registerShell(ipcMain);
registerCosting(ipcMain);
registerPurchaseOrders(ipcMain);
registerPurchaseOrderItems(ipcMain);
registerPurchaseOrderVendors(ipcMain);

const authController = registerAuth(ipcMain, () => mainWindow);
const users = registerUsers(ipcMain, {
  getProfile: () => authController.getProfile(),
  verifyPassword: (email, password) => authController.verifyPassword(email, password),
});
authController.onReset(users.lock);
registerBackup(ipcMain);

registerDatabases(ipcMain, {
  onOpen: () => authController.loadForOpenDatabase(),
  onClose: async () => authController.closeDatabase(),
});

// The desktop shows the logo from its downloaded copy through a file:// URL,
// which means nothing in the web view; the copy is in the fs stand-in, so the
// page gets the image itself as a data: URL instead.
function logoAsDataUrl(settings) {
  const url = settings && settings.company_logo_url;
  if (!url || !url.startsWith('file://')) return settings;
  const filePath = url.slice('file://'.length);
  try {
    const data = fs.readFileSync(filePath).toString('base64');
    return { ...settings, company_logo_url: `data:${contentTypeOf(filePath)};base64,${data}` };
  } catch (err) {
    return { ...settings, company_logo_url: null };
  }
}
['settings:get', 'settings:update', 'settings:chooseLogo', 'settings:removeLogo'].forEach((channel) =>
  ipcMain.wrapResult(channel, logoAsDataUrl)
);

// A desktop export saves the PDF where the person chose and says where. The
// phone has no save dialog (the file lands in the in-memory cache), so it
// opens the PDF instead: the viewer is where Android's share, print and save
// options are.
ipcMain.wrapResult('outgoingInvoices:exportPdf', async (result) => {
  if (!result || !result.ok) return result;
  const error = await shell.openPath(result.filePath);
  return error ? { ...result, message: `The PDF was made, but could not be opened: ${error}` } : { ...result, shown: true };
});

// Updates come as a new APK from the GitHub release, installed by hand, so
// the sidebar shows the version and nothing to check.
ipcMain.handle('updates:getVersion', () => app.getVersion());
ipcMain.handle('updates:check', () => {});

// The page follows the phone's light/dark setting through CSS; there is no
// native title bar to keep in step.
ipcMain.handle('theme:set', () => {});

ipcMain.handle('setup:listProjects', async () => ({
  ok: false,
  error: 'Set up new databases from the BookBin desktop app, then add them here with a connection code.',
}));

require('../preload');

// Android's back button. Listening replaces Capacitor's default (go back,
// else quit), so this does the same after first offering the event to the
// page, which uses it to close an open dialog or drawer (see app.js).
const { App } = require('@capacitor/app');
App.addListener('backButton', ({ canGoBack }) => {
  const event = new CustomEvent('bookbin:back', { cancelable: true });
  if (!window.dispatchEvent(event)) return;
  if (canGoBack) window.history.back();
  else App.exitApp();
});

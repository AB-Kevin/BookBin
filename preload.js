const { contextBridge, ipcRenderer } = require('electron');

// Narrow, explicit surface exposed to the renderer as `window.api`.
// The renderer never talks to Electron/Node directly (contextIsolation is on),
// only through these whitelisted invoke calls.
function makeCrud(domain) {
  return {
    list: () => ipcRenderer.invoke(`${domain}:list`),
    get: (id) => ipcRenderer.invoke(`${domain}:get`, id),
    create: (data) => ipcRenderer.invoke(`${domain}:create`, data),
    update: (id, data) => ipcRenderer.invoke(`${domain}:update`, id, data),
    delete: (id) => ipcRenderer.invoke(`${domain}:delete`, id),
  };
}

contextBridge.exposeInMainWorld('api', {
  items: {
    ...makeCrud('items'),
    history: (id) => ipcRenderer.invoke('items:history', id),
    adjustStock: (id, delta, reason) => ipcRenderer.invoke('items:adjustStock', id, delta, reason),
  },
  vendors: makeCrud('vendors'),
  customers: makeCrud('customers'),
  incomingInvoices: {
    ...makeCrud('incomingInvoices'),
    setFlags: (id, flags) => ipcRenderer.invoke('incomingInvoices:setFlags', id, flags),
  },
  outgoingInvoices: {
    ...makeCrud('outgoingInvoices'),
    exportPdf: (id) => ipcRenderer.invoke('outgoingInvoices:exportPdf', id),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (data) => ipcRenderer.invoke('settings:update', data),
    chooseLogo: () => ipcRenderer.invoke('settings:chooseLogo'),
    removeLogo: () => ipcRenderer.invoke('settings:removeLogo'),
  },
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    choose: () => ipcRenderer.invoke('workspace:choose'),
  },
  dashboard: {
    summary: () => ipcRenderer.invoke('dashboard:summary'),
  },
  updates: {
    getVersion: () => ipcRenderer.invoke('updates:getVersion'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    quitAndInstall: () => ipcRenderer.invoke('updates:quitAndInstall'),
    openReleasesPage: () => ipcRenderer.invoke('updates:openReleasesPage'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    },
  },
});

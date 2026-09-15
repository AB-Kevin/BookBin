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
  },
  dashboard: {
    summary: () => ipcRenderer.invoke('dashboard:summary'),
  },
});

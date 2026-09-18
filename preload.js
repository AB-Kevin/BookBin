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
    chooseAttachment: () => ipcRenderer.invoke('incomingInvoices:chooseAttachment'),
    openAttachment: (id) => ipcRenderer.invoke('incomingInvoices:openAttachment', id),
  },
  outgoingInvoices: {
    ...makeCrud('outgoingInvoices'),
    exportPdf: (id) => ipcRenderer.invoke('outgoingInvoices:exportPdf', id),
    chooseAttachment: () => ipcRenderer.invoke('outgoingInvoices:chooseAttachment'),
    openAttachment: (id) => ipcRenderer.invoke('outgoingInvoices:openAttachment', id),
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
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  costing: {
    recalculateItem: (itemId) => ipcRenderer.invoke('costing:recalculateItem', itemId),
    recalculateAll: () => ipcRenderer.invoke('costing:recalculateAll'),
    history: (itemId) => ipcRenderer.invoke('costing:history', itemId),
  },
  purchaseOrders: {
    ...makeCrud('purchaseOrders'),
    close: (id) => ipcRenderer.invoke('purchaseOrders:close', id),
    reopen: (id) => ipcRenderer.invoke('purchaseOrders:reopen', id),
  },
  purchaseOrderItems: {
    list: (purchaseOrderId) => ipcRenderer.invoke('purchaseOrderItems:list', purchaseOrderId),
    get: (id) => ipcRenderer.invoke('purchaseOrderItems:get', id),
    create: (data) => ipcRenderer.invoke('purchaseOrderItems:create', data),
    update: (id, data) => ipcRenderer.invoke('purchaseOrderItems:update', id, data),
    delete: (id) => ipcRenderer.invoke('purchaseOrderItems:delete', id),
    invoices: (id) => ipcRenderer.invoke('purchaseOrderItems:invoices', id),
  },
  lock: {
    getStatus: () => ipcRenderer.invoke('lock:getStatus'),
    requestAccess: () => ipcRenderer.invoke('lock:requestAccess'),
    respondToRequest: (action) => ipcRenderer.invoke('lock:respondToRequest', action),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('lock:status', listener);
      return () => ipcRenderer.removeListener('lock:status', listener);
    },
    onIncomingRequest: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('lock:incomingRequest', listener);
      return () => ipcRenderer.removeListener('lock:incomingRequest', listener);
    },
    onRequestResult: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('lock:requestResult', listener);
      return () => ipcRenderer.removeListener('lock:requestResult', listener);
    },
  },
  activity: {
    notify: () => ipcRenderer.send('activity:ping'),
    onCountdown: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('activity:countdown', listener);
      return () => ipcRenderer.removeListener('activity:countdown', listener);
    },
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

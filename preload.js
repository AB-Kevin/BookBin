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
  auth: {
    signIn: (email, password) => ipcRenderer.invoke('auth:signIn', email, password),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
    getSession: () => ipcRenderer.invoke('auth:getSession'),
    getProfile: () => ipcRenderer.invoke('auth:getProfile'),
    onChanged: (callback) => {
      const listener = (_event, profile) => callback(profile);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    },
  },
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
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    create: (data) => ipcRenderer.invoke('users:create', data),
    delete: (userId) => ipcRenderer.invoke('users:delete', userId),
    setRole: (userId, role) => ipcRenderer.invoke('users:setRole', userId, role),
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

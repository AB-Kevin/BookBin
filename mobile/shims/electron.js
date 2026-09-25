// Electron, as far as the desktop's code needs it, for the Android web view.
//
// On the desktop, preload.js calls ipcRenderer.invoke() and a handler that
// ipc/*.js registered with ipcMain.handle() answers it in the main process.
// Here both halves run in the same page: invoke() calls the handler directly.
// That is what lets preload.js and every ipc/*.js module run unchanged.
//
// Arguments and results are structured-cloned on the way through, as real IPC
// does, so neither side can change an object the other is still holding.
//
// Files work through the same fs stand-in the desktop code already uses: a
// picked file is read into it (showOpenDialog), and a downloaded one is
// written out of it to the phone and handed to another app (openPath).
//
// Printing to PDF goes through BookBin's own native plugin (PdfPrinterPlugin
// in the Android project), behind a BrowserWindow stand-in shaped like the
// hidden window the desktop prints with.
//
// Anything the phone cannot do refuses with a plain message rather than
// half-working.

const fs = require('fs');
const path = require('path');

const NOT_YET = 'Not available in the Android app yet.';

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function contentTypeOf(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const handlers = new Map();
const mainListeners = new Map();
const rendererListeners = new Map();

function clone(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    return value;
  }
}

function addTo(map, channel, listener) {
  if (!map.has(channel)) map.set(channel, new Set());
  map.get(channel).add(listener);
}

// Stands in for event.sender; only ever passed to BrowserWindow.fromWebContents.
const sender = {};

const ipcMain = {
  handle(channel, handler) {
    handlers.set(channel, handler);
  },
  // Not Electron: lets mobile/main.js adjust what a handler returns, for the
  // few results that only make sense on the desktop (a file:// logo URL).
  wrapResult(channel, transform) {
    const original = handlers.get(channel);
    handlers.set(channel, async (...args) => transform(await original(...args)));
  },
  removeHandler(channel) {
    handlers.delete(channel);
  },
  on(channel, listener) {
    addTo(mainListeners, channel, listener);
  },
};

const ipcRenderer = {
  async invoke(channel, ...args) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(NOT_YET);
    return clone(await handler({ sender }, ...clone(args)));
  },
  send(channel, ...args) {
    (mainListeners.get(channel) || []).forEach((listener) => listener({ sender }, ...clone(args)));
  },
  on(channel, listener) {
    addTo(rendererListeners, channel, listener);
  },
  removeListener(channel, listener) {
    const set = rendererListeners.get(channel);
    if (set) set.delete(listener);
  },
};

// What main.js hands to modules that push events to the page (auth:changed).
const mainWindow = {
  isDestroyed: () => false,
  webContents: {
    send(channel, ...args) {
      (rendererListeners.get(channel) || []).forEach((listener) => listener({}, ...clone(args)));
    },
  },
};

const contextBridge = {
  exposeInMainWorld(name, api) {
    window[name] = api;
  },
};

const app = {
  getPath: (name) => `/${name}`,
  getVersion: () => __BOOKBIN_VERSION__,
  isPackaged: true,
};

// Supabase's REST, auth and storage endpoints allow cross-origin requests, so
// the web view's own fetch reaches them. Edge Functions and the Management API
// do not, so those go through Capacitor's native HTTP, which is not subject to
// CORS. Their bodies are JSON, which is all the native bridge carries well.
function needsNativeHttp(url) {
  return /\/functions\/v1\//.test(url) || /^https:\/\/api\.supabase\.com\//.test(url);
}

async function nativeFetch(url, init = {}) {
  const { CapacitorHttp } = require('@capacitor/core');
  const headers = {};
  new Headers(init.headers || {}).forEach((value, key) => { headers[key] = value; });
  let data = init.body;
  if (typeof data === 'string' && /json/i.test(headers['content-type'] || '')) {
    try { data = JSON.parse(data); } catch (err) { /* send as text */ }
  }
  const result = await CapacitorHttp.request({
    url,
    method: init.method || 'GET',
    headers,
    data,
    responseType: 'text',
  });
  const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
  const noBody = result.status === 204 || result.status === 304;
  return new Response(noBody ? null : body, { status: result.status, headers: result.headers });
}

const net = {
  fetch(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    return needsNativeHttp(url) ? nativeFetch(url, init) : fetch(input, init);
  },
};

const shell = {
  // Capacitor hands a navigation to another site to the system browser
  // rather than loading it in the app.
  async openExternal(url) {
    window.location.href = url;
  },

  // The desktop hands a file on disk to the OS. Here the file is in the fs
  // stand-in, so it is written to the app's cache folder first, then offered
  // to whichever app opens its type. Like Electron's, it returns an error
  // message on failure and '' on success.
  async openPath(filePath) {
    const { Filesystem, Directory } = require('@capacitor/filesystem');
    const { FileOpener } = require('@capacitor-community/file-opener');
    try {
      const { uri } = await Filesystem.writeFile({
        path: `open/${path.basename(filePath)}`,
        data: fs.readFileSync(filePath).toString('base64'),
        directory: Directory.Cache,
        recursive: true,
      });
      await FileOpener.open({ filePath: uri, contentType: contentTypeOf(filePath), openWithDefault: true });
      return '';
    } catch (err) {
      return /activity|no app/i.test(err.message || '')
        ? 'There is no app on this phone that can open this file.'
        : err.message || String(err);
    }
  },
};

// Android's file picker, through the web view's file input. The chosen file
// is read into the fs stand-in under a made-up path, which is what the
// desktop code then passes along and reads back for the upload.
function pickFile(options = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // The picker filters by MIME type, not extension. A filter allowing
    // anything ('*') means no filter at all.
    const extensions = (options.filters || []).flatMap((f) => f.extensions || []);
    if (!extensions.includes('*')) {
      input.accept = [...new Set(extensions.map((ext) => contentTypeOf(`.${ext}`)))].join(',');
    }
    input.addEventListener('cancel', () => resolve({ canceled: true, filePaths: [] }));
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve({ canceled: true, filePaths: [] });
        return;
      }
      const picked = `/picked/${globalThis.crypto.randomUUID()}/${file.name}`;
      fs.writeFileSync(picked, Buffer.from(await file.arrayBuffer()));
      resolve({ canceled: false, filePaths: [picked] });
    });
    input.click();
  });
}

// A picked "save" location. The phone has no save dialog; the file goes to
// the in-memory cache, and mobile/main.js opens it from there instead, which
// is where the phone's own share and save options are.
async function chooseSaveLocation(_window, options = {}) {
  const name = path.basename(options.defaultPath || 'file');
  return { canceled: false, filePath: `/cache/export/${name}` };
}

// Pages point at local files with file:// URLs (the invoice logo), which
// mean nothing to the native printer; they become data: URLs from the fs
// stand-in. A file that is not there is left as it was and simply does not
// show.
function inlineLocalFiles(html) {
  return html.replace(/(src=["'])file:\/\/([^"']+)(["'])/g, (match, open, filePath, close) => {
    try {
      const data = fs.readFileSync(filePath).toString('base64');
      return `${open}data:${contentTypeOf(filePath)};base64,${data}${close}`;
    } catch (err) {
      return match;
    }
  });
}

// Just the part of BrowserWindow the PDF export uses: a hidden window that
// loads a page and prints it.
class HiddenWindow {
  constructor() {
    this.html = null;
    this.webContents = {
      printToPDF: async () => {
        const { registerPlugin } = require('@capacitor/core');
        const printer = registerPlugin('PdfPrinter');
        // US Letter with 0.4" margins, matching Electron's printToPDF
        // defaults. Set in CSS because the native side cannot set margins
        // reliably (see PdfPrinterPlugin).
        const html = inlineLocalFiles(this.html).replace(/<head[^>]*>/i, '$&<style>@page { size: letter; margin: 0.4in; }</style>');
        const { data } = await printer.print({ html });
        return Buffer.from(data, 'base64');
      },
    };
  }

  async loadFile(filePath) {
    this.html = fs.readFileSync(filePath, 'utf8');
  }

  destroy() {}

  static fromWebContents() {
    return null;
  }

  static getAllWindows() {
    return [];
  }
}

const unavailable = async () => {
  throw new Error(NOT_YET);
};

module.exports = {
  ipcMain,
  ipcRenderer,
  contextBridge,
  mainWindow,
  app,
  net,
  shell,
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {
    showOpenDialog: (_window, options) => pickFile(options),
    showSaveDialog: chooseSaveLocation,
    showMessageBox: unavailable,
  },
  contentTypeOf,
  BrowserWindow: HiddenWindow,
  nativeTheme: {},
};

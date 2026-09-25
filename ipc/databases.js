// Choosing which database to open, before anybody signs in.
//
// The list itself is config/databases.js. This is the part the start screen
// talks to: what is saved, adding and forgetting entries, and opening one --
// after which signing in is ipc/auth.js's business, against whichever
// database is open.

const { net } = require('electron');
const databases = require('../config/databases');
const { openDatabase, closeDatabase, getCurrentDatabase } = require('../db/supabase');
const { describeConnectionFailure } = require('../db/errors');

// What the start screen needs about each entry. The key is included because
// it is not secret and "copy connection code" needs nothing else, but the
// renderer never needs it to open a database -- that happens here.
function summarize(entry) {
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    hasSavedSession: databases.hasSavedSession(entry.id),
    isLastUsed: databases.lastUsedId() === entry.id,
  };
}

/**
 * Asks the project's auth service for its public settings, which needs a
 * valid key and nothing else. A database added with a typo in the address or
 * the wrong key is caught here, with the reason, rather than at the sign-in
 * screen as a login that mysteriously fails.
 */
async function checkReachable({ url, publishableKey }) {
  let response;
  try {
    response = await net.fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: publishableKey },
    });
  } catch (err) {
    throw new Error(describeConnectionFailure(err) || `Could not reach ${url}: ${err.message}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('The database answered, but did not accept that key. Check it is the publishable (anon) key for this project.');
  }
  if (response.status === 404) {
    throw new Error(`Nothing at ${url} answers like a Supabase project. Check the address.`);
  }
  if (!response.ok) {
    const connection = describeConnectionFailure({ status: response.status, message: '' });
    throw new Error(connection || `The database answered with an error (${response.status}).`);
  }
}

module.exports = function registerDatabases(ipcMain, { onOpen, onClose }) {
  ipcMain.handle('databases:list', () => databases.list().map(summarize));

  ipcMain.handle('databases:current', () => {
    const db = getCurrentDatabase();
    return db ? summarize(db) : null;
  });

  ipcMain.handle('databases:add', async (_e, fields) => {
    try {
      const clean = databases.validate(fields);
      await checkReachable(clean);
      return { ok: true, database: summarize(databases.add(clean)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('databases:addFromCode', async (_e, code, name) => {
    try {
      const fields = databases.parseConnectionCode(code);
      if (name && String(name).trim()) fields.name = name;
      const clean = databases.validate(fields);
      await checkReachable(clean);
      return { ok: true, database: summarize(databases.add(clean)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('databases:rename', (_e, id, name) => {
    try {
      return { ok: true, database: summarize(databases.rename(id, name)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('databases:remove', async (_e, id) => {
    const open = getCurrentDatabase();
    if (open && open.id === id) {
      closeDatabase();
      await onClose();
    }
    databases.remove(id);
    return { ok: true };
  });

  ipcMain.handle('databases:connectionCode', (_e, id) => {
    try {
      return { ok: true, code: databases.connectionCode(id) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Opens a database and, if this machine still holds a good session for it,
  // signs straight back in. `profile` is null when a password is needed.
  ipcMain.handle('databases:open', async (_e, id) => {
    try {
      const db = openDatabase(id);
      const profile = await onOpen(db);
      return { ok: true, database: summarize(db), profile };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Back to the list. The saved session is kept, so reopening the same
  // database does not ask for the password again; signing out is what
  // forgets it.
  ipcMain.handle('databases:close', async () => {
    closeDatabase();
    await onClose();
    return { ok: true };
  });
};

// The Supabase client, and where the signed-in session is kept.
//
// Which database is open is decided at runtime: the person picks one from the
// list in config/databases.js before signing in. Until they do there is no
// client, and anything that asks for one is told so.
//
// The client lives in the main process only. The renderer reaches the database
// the way it always has -- through IPC -- so switching the storage engine does
// not hand the renderer a network client, and the access token never enters a
// web page where an injected script could read it.
//
// supabase-js expects a browser's localStorage. There isn't one here, so this
// supplies a storage adapter backed by a file in userData, encrypted with
// Electron's safeStorage (DPAPI on Windows, Keychain on macOS). The file holds
// a refresh token, which is a long-lived credential: anyone who reads it can
// mint access tokens until it is revoked. Writing it as plain text on disk
// would undo a good deal of what the row-level security policies are for.

const fs = require('fs');
const path = require('path');
const { net, safeStorage } = require('electron');
const { createClient } = require('@supabase/supabase-js');
const databases = require('../config/databases');

/**
 * A localStorage-shaped adapter over one encrypted file.
 *
 * Every failure path here deliberately degrades to "no stored session" rather
 * than throwing: the file can be unreadable for perfectly ordinary reasons --
 * copied from another machine, restored from a backup, written by a different
 * OS user -- and the right answer to all of them is to show the login screen,
 * not to crash on startup.
 */
function createSecureStorage(filePath) {
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(filePath);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8');
      cache = JSON.parse(json);
    } catch (err) {
      cache = {};
    }
    return cache;
  }

  function persist() {
    try {
      const json = JSON.stringify(cache || {});
      const blob = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(json)
        : Buffer.from(json, 'utf8');
      fs.writeFileSync(filePath, blob);
    } catch (err) {
      console.error('BookBin: could not save session —', err.message);
    }
  }

  return {
    getItem(key) {
      const value = load()[key];
      return value === undefined ? null : value;
    },
    setItem(key, value) {
      load()[key] = value;
      persist();
    },
    removeItem(key) {
      delete load()[key];
      persist();
    },
  };
}

let client = null;
let current = null;
let encryptionWarned = false;

/** The open database's list entry, or null when none is open. */
function getCurrentDatabase() {
  return current ? { ...current } : null;
}

/**
 * Makes `id` the open database. The previous client is dropped, not signed
 * out: its saved session stays in its own file, so switching back later does
 * not ask for the password again.
 */
function openDatabase(id) {
  const entry = databases.get(id);
  if (!entry) throw new Error('That database is no longer in the list.');
  closeDatabase();
  current = entry;
  databases.setLastUsed(id);
  return getCurrentDatabase();
}

function closeDatabase() {
  if (client) {
    // Stops the refresh timer; without this the old client keeps renewing a
    // session nobody is using, against a database nobody has open.
    try {
      client.auth.stopAutoRefresh();
    } catch (err) {
      // Older clients have no such method; dropping the reference is enough.
    }
  }
  client = null;
  current = null;
}

/**
 * Returns the open database's client, creating it on first use. Throws when
 * no database is open -- a caller reaching this without one is a bug in the
 * flow, and a clear message beats a request to nowhere.
 */
function getSupabase() {
  if (client) return client;
  if (!current) throw new Error('No database is open. Choose one first.');

  const { url, publishableKey } = current;
  const sessionPath = databases.sessionFileFor(current.id);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

  if (!safeStorage.isEncryptionAvailable() && !encryptionWarned) {
    encryptionWarned = true;
    console.warn(
      'BookBin: OS encryption is unavailable, so the saved session will be ' +
      'stored unencrypted. Signing out removes it.'
    );
  }

  client = createClient(url, publishableKey, {
    // Node's own fetch carries its own certificate list and ignores the
    // Windows proxy settings, so an antivirus that inspects HTTPS -- trusted by
    // every browser on the machine -- makes each request fail as "fetch
    // failed". Electron's net.fetch goes through Chromium's network stack and
    // sees certificates, proxy and DNS exactly as the browser does.
    global: { fetch: (...args) => net.fetch(...args) },
    auth: {
      storage: createSecureStorage(sessionPath),
      persistSession: true,
      autoRefreshToken: true,
      // No browser redirect ever happens here; this is a desktop app opening a
      // direct email/password session, so there is no URL fragment to read.
      detectSessionInUrl: false,
    },
  });

  return client;
}

/**
 * A throwaway client for checking a password, which never touches the open
 * session. Signing in on the real client would do the same check, but would
 * also replace the session -- harmless when it is the same person, and a
 * silent account switch if it were ever not.
 */
function createScratchClient() {
  if (!current) throw new Error('No database is open. Choose one first.');
  return createClient(current.url, current.publishableKey, {
    global: { fetch: (...args) => net.fetch(...args) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Deletes the open database's stored session outright. Used on sign-out. */
function clearStoredSession() {
  if (!current) return;
  try {
    fs.rmSync(databases.sessionFileFor(current.id), { force: true });
  } catch (err) {
    console.error('BookBin: could not clear session —', err.message);
  }
  // The client caches the session in memory too; a fresh one starts clean.
  client = null;
}

module.exports = {
  getSupabase,
  getCurrentDatabase,
  openDatabase,
  closeDatabase,
  createScratchClient,
  clearStoredSession,
  createSecureStorage,
};

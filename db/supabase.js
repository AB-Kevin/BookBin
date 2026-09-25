// The Supabase client, and where the signed-in session is kept.
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
const { app, safeStorage } = require('electron');
const { createClient } = require('@supabase/supabase-js');
const { getSupabaseConfig } = require('../config/supabase');

const SESSION_FILE = 'session.bin';

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
let encryptionWarned = false;

/**
 * Returns the shared client, creating it on first use. Throws with a readable
 * message if the app was built or run without its configuration.
 */
function getSupabase() {
  if (client) return client;

  const { url, publishableKey } = getSupabaseConfig();
  const sessionPath = path.join(app.getPath('userData'), SESSION_FILE);

  if (!safeStorage.isEncryptionAvailable() && !encryptionWarned) {
    encryptionWarned = true;
    console.warn(
      'BookBin: OS encryption is unavailable, so the saved session will be ' +
      'stored unencrypted. Signing out removes it.'
    );
  }

  client = createClient(url, publishableKey, {
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

/** Deletes the stored session outright. Used on sign-out. */
function clearStoredSession() {
  try {
    fs.rmSync(path.join(app.getPath('userData'), SESSION_FILE), { force: true });
  } catch (err) {
    console.error('BookBin: could not clear session —', err.message);
  }
}

module.exports = { getSupabase, clearStoredSession, createSecureStorage };

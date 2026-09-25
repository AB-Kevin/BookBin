// The databases this machine knows about.
//
// BookBin used to be built for exactly one Supabase project, its address baked
// into the installer. Now the address is data: a list kept in userData, one
// entry per database, each holding only what a client may hold -- the project
// URL and its publishable key. Neither is secret (row-level security is what
// guards the data), but a secret key is refused outright, because saving one
// on a machine would hand anyone who reads the file every row in the project.
//
// On first launch the list is seeded with whatever database the build was
// made with, so an existing install carries on without anyone typing an
// address. That entry is an ordinary one afterwards and can be removed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { getBuiltInConfig, normalizeUrl, looksLikeSecretKey } = require('./supabase');
const local = require('./local');

// Connection codes are how a database is passed to another computer: one line
// to paste instead of a URL and a 46-character key. The prefix makes a code
// recognisable, and lets a later format change be told apart from this one.
const CODE_PREFIX = 'bookbin1:';

function listFile() {
  return path.join(app.getPath('userData'), 'databases.json');
}

function sessionsDir() {
  return path.join(app.getPath('userData'), 'sessions');
}

/** Where a database's saved sign-in lives. One file each, so switching keeps both. */
function sessionFileFor(id) {
  return path.join(sessionsDir(), `${id}.bin`);
}

let state = null;

function save() {
  try {
    fs.writeFileSync(listFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('BookBin: could not save the database list —', err.message);
  }
}

// Before there was a list, there was one session file and one set of backup
// settings. They belong to the built-in database, so they move to it rather
// than being left behind -- otherwise upgrading would sign everybody out and
// quietly switch their backups off.
function adoptSingleDatabaseState(entry) {
  const oldSession = path.join(app.getPath('userData'), 'session.bin');
  try {
    if (fs.existsSync(oldSession)) {
      fs.mkdirSync(sessionsDir(), { recursive: true });
      fs.renameSync(oldSession, sessionFileFor(entry.id));
    }
  } catch (err) {
    console.error('BookBin: could not carry the saved session over —', err.message);
  }

  for (const key of ['backupDir', 'backupLastRun', 'backupLastResult']) {
    const value = local.get(key);
    if (value !== null) {
      local.set(`${key}:${entry.id}`, value);
      local.set(key, null);
    }
  }
}

function load() {
  if (state) return state;

  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(listFile(), 'utf8'));
  } catch (err) {
    // No file yet: first launch of a version that has a list.
  }

  if (saved && Array.isArray(saved.databases)) {
    state = { databases: saved.databases, lastUsedId: saved.lastUsedId || null };
    return state;
  }

  state = { databases: [], lastUsedId: null };
  const builtIn = getBuiltInConfig();
  if (builtIn) {
    const entry = {
      id: crypto.randomUUID(),
      name: 'BookBin',
      url: builtIn.url,
      publishableKey: builtIn.publishableKey,
      // Backups made before there was a list are named without a tag. Keeping
      // this entry's files named the same way means the old ones are still
      // counted -- and pruned -- as its own.
      backupTag: '',
    };
    state.databases.push(entry);
    state.lastUsedId = entry.id;
    adoptSingleDatabaseState(entry);
  }
  // Written even when empty, so removing the built-in entry later is not
  // undone by the next launch seeding it again.
  save();
  return state;
}

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'db';
}

/** Cleans and checks an entry's fields. Throws with something a person can act on. */
function validate({ name, url, publishableKey }) {
  const cleanUrl = normalizeUrl(url);
  const cleanKey = String(publishableKey || '').trim();
  const cleanName = String(name || '').trim();

  if (!/^https:\/\/[^/\s]+$/i.test(cleanUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cleanUrl)) {
    throw new Error('That does not look like a project address. It should look like https://abcdefgh.supabase.co');
  }
  if (!cleanKey) throw new Error('The publishable key is missing.');
  if (looksLikeSecretKey(cleanKey)) {
    throw new Error(
      'That is a secret key. It bypasses every security rule in the database and ' +
      'must not be saved on a computer. Use the publishable (anon) key instead.'
    );
  }
  return { name: cleanName, url: cleanUrl, publishableKey: cleanKey };
}

function list() {
  return load().databases.map((db) => ({ ...db }));
}

function get(id) {
  return load().databases.find((db) => db.id === id) || null;
}

function add(fields) {
  const clean = validate(fields);
  const existing = load().databases.find((db) => db.url === clean.url);
  if (existing) {
    throw new Error(`That database is already in the list, as "${existing.name}".`);
  }
  const name = clean.name || new URL(clean.url).hostname.split('.')[0];
  const id = crypto.randomUUID();
  const entry = {
    id,
    name,
    url: clean.url,
    publishableKey: clean.publishableKey,
    backupTag: `${slug(name)}-${id.slice(0, 6)}`,
  };
  state.databases.push(entry);
  save();
  return { ...entry };
}

function rename(id, name) {
  const entry = get(id);
  const clean = String(name || '').trim();
  if (!entry) throw new Error('That database is no longer in the list.');
  if (!clean) throw new Error('Give it a name.');
  entry.name = clean;
  save();
  return { ...entry };
}

/**
 * Forgets a database on this machine: the entry, its saved sign-in and its
 * backup settings. Nothing in the database itself is touched, and backup
 * files already written are left where they are.
 */
function remove(id) {
  load();
  state.databases = state.databases.filter((db) => db.id !== id);
  if (state.lastUsedId === id) state.lastUsedId = null;
  save();
  try {
    fs.rmSync(sessionFileFor(id), { force: true });
  } catch (err) {
    console.error('BookBin: could not delete the saved session —', err.message);
  }
  for (const key of ['backupDir', 'backupLastRun', 'backupLastResult']) local.set(`${key}:${id}`, null);
}

function setLastUsed(id) {
  load();
  state.lastUsedId = id;
  save();
}

function lastUsedId() {
  return load().lastUsedId;
}

function hasSavedSession(id) {
  try {
    return fs.statSync(sessionFileFor(id)).size > 0;
  } catch (err) {
    return false;
  }
}

function connectionCode(id) {
  const entry = get(id);
  if (!entry) throw new Error('That database is no longer in the list.');
  const payload = JSON.stringify({ name: entry.name, url: entry.url, key: entry.publishableKey });
  return CODE_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/** Returns { name, url, publishableKey } from a pasted code, or throws. */
function parseConnectionCode(code) {
  const text = String(code || '').replace(/\s+/g, '');
  if (!text.startsWith(CODE_PREFIX)) {
    throw new Error('That is not a BookBin connection code. It should start with "bookbin1:".');
  }
  try {
    const payload = JSON.parse(Buffer.from(text.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
    return { name: payload.name, url: payload.url, publishableKey: payload.key };
  } catch (err) {
    throw new Error('That connection code is incomplete or damaged. Copy it again.');
  }
}

module.exports = {
  list,
  get,
  add,
  rename,
  remove,
  validate,
  setLastUsed,
  lastUsedId,
  hasSavedSession,
  sessionFileFor,
  connectionCode,
  parseConnectionCode,
};

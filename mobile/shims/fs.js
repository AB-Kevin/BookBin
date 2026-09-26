// Just enough of Node's fs for the desktop's main-process code to run in the
// Android web view.
//
// What that code keeps on disk is a handful of small files under userData:
// the database list, per-machine settings, and a saved session per database.
// Here they live in the web view's localStorage, which is private to the app.
// The session is a refresh token; the desktop encrypts it because its file
// sits on a disk other people and programs can read, which an app's private
// storage on Android is not.
//
// Everything else -- downloaded attachments and the logo (db/storage.js's
// file-cache), files picked for upload, temporary files -- is kept in memory
// for the life of the app. Those can be large, and localStorage holds a few
// megabytes at most; filling it would also leave no room to save a session.
// So only the known small files persist, and anything new defaults to memory.
//
// Contents are stored base64-encoded so binary files survive the round trip.

const { Buffer } = require('buffer');

const PREFIX = 'bookbin-fs:';
const memory = new Map();

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

// databases.json, local-settings.json, and sessions/<id>.bin.
function persists(p) {
  return /\.json$/.test(p) || /\/sessions\/[^/]+$/.test(p);
}

function isCache(p) {
  return !persists(p);
}

// Versions before this kept downloaded files in localStorage too; clear them
// out, since they only take up the room the session needs.
try {
  Object.keys(localStorage)
    .filter((key) => key.startsWith(PREFIX) && !persists(key.slice(PREFIX.length)))
    .forEach((key) => localStorage.removeItem(key));
} catch (err) {
  // Storage unavailable; nothing to clean.
}

function getRaw(p) {
  const key = normalize(p);
  if (isCache(key)) return memory.has(key) ? memory.get(key) : null;
  return localStorage.getItem(PREFIX + key);
}

function setRaw(p, value) {
  const key = normalize(p);
  if (isCache(key)) memory.set(key, value);
  else localStorage.setItem(PREFIX + key, value);
}

function removeRaw(p) {
  const key = normalize(p);
  memory.delete(key);
  localStorage.removeItem(PREFIX + key);
}

function notFound(p) {
  const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
  err.code = 'ENOENT';
  return err;
}

function encodingOf(options) {
  const enc = typeof options === 'string' ? options : options && options.encoding;
  return enc === 'utf-8' ? 'utf8' : enc;
}

function readFileSync(p, options) {
  const raw = getRaw(p);
  if (raw === null) throw notFound(p);
  const buffer = Buffer.from(raw, 'base64');
  const enc = encodingOf(options);
  return enc ? buffer.toString(enc) : buffer;
}

function writeFileSync(p, data, options) {
  const buffer = Buffer.isBuffer(data) || data instanceof Uint8Array
    ? Buffer.from(data)
    : Buffer.from(String(data), encodingOf(options) || 'utf8');
  setRaw(p, buffer.toString('base64'));
}

function existsSync(p) {
  return getRaw(p) !== null;
}

function rmSync(p, options) {
  if (getRaw(p) === null && !(options && options.force)) throw notFound(p);
  removeRaw(p);
}

function renameSync(from, to) {
  const raw = getRaw(from);
  if (raw === null) throw notFound(from);
  setRaw(to, raw);
  removeRaw(from);
}

function statSync(p) {
  const raw = getRaw(p);
  if (raw === null) throw notFound(p);
  return { size: Buffer.byteLength(raw, 'base64'), isFile: () => true, isDirectory: () => false };
}

module.exports = {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
  statSync,
  // Folders are implied by the paths of the files in them.
  mkdirSync: () => {},
  unlink: (p, callback) => {
    removeRaw(p);
    if (callback) callback(null);
  },
};

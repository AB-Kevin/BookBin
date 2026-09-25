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
// The download cache (attachments, the logo) and files picked for upload are
// different: they can be large and localStorage holds a few megabytes at
// most, so anything under a "cache" or "picked" folder is kept in memory for
// the life of the app instead, as are temporary files (/tmp).
//
// Contents are stored base64-encoded so binary files survive the round trip.

const { Buffer } = require('buffer');

const PREFIX = 'bookbin-fs:';
const memory = new Map();

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

function isCache(p) {
  return /^\/tmp(\/|$)|\/(cache|picked)(\/|$)/.test(p);
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

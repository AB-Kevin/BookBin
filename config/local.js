// Per-machine settings, kept in userData.
//
// Distinct from the settings table, which is shared: everyone sees the same
// company name and invoice prefixes because those describe the business. A
// backup folder describes one computer. "D:\\Backups" means nothing on a
// laptop that has no D drive, and writing it into the shared row would have
// every other machine quietly failing to back up to a path it cannot see.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function configPath() {
  return path.join(app.getPath('userData'), 'local-settings.json');
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    // Missing or unreadable is the normal first-run state, not a problem.
    return {};
  }
}

function write(values) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(values, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('BookBin: could not save local settings —', err.message);
    return false;
  }
}

function get(key, fallback = null) {
  const value = read()[key];
  return value === undefined ? fallback : value;
}

function set(key, value) {
  const values = read();
  if (value === null || value === undefined) delete values[key];
  else values[key] = value;
  return write(values);
}

module.exports = { get, set, configPath };

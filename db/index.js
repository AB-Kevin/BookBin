const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Adds a column to an existing table if it isn't already there. CREATE TABLE
// IF NOT EXISTS in schema.sql only helps on a fresh database — a table that
// already exists from an earlier version of the app needs its new columns
// added explicitly, and ALTER TABLE ADD COLUMN errors if run twice.
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrate(db) {
  ensureColumn(db, 'incoming_invoices', 'paid', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'incoming_invoices', 'received', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'incoming_invoices', 'attachment_path', 'TEXT');
  ensureColumn(db, 'incoming_invoices', 'attachment_name', 'TEXT');
  ensureColumn(db, 'outgoing_invoices', 'attachment_path', 'TEXT');
  ensureColumn(db, 'outgoing_invoices', 'attachment_name', 'TEXT');
  ensureColumn(db, 'incoming_invoices', 'shipping_tax', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'settings', 'cost_markup_percent', 'REAL NOT NULL DEFAULT 2');
}

/**
 * Opens (creating if necessary) the app's SQLite database inside
 * workspaceDir and applies schema.sql, which is safe to run on every launch
 * since every statement is idempotent (CREATE ... IF NOT EXISTS). workspaceDir
 * defaults to the app's per-machine userData folder, but may instead be a
 * synced folder (e.g. OneDrive) shared with another device.
 */
function initDatabase(workspaceDir) {
  const dbPath = path.join(workspaceDir, 'bookbin.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);

  return db;
}

module.exports = { initDatabase };

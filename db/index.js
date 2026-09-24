const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { backupsDir } = require('../workspace');

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
  ensureColumn(db, 'purchase_order_items', 'purchase_order_id', 'INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE');
  ensureColumn(db, 'purchase_order_items', 'frozen_bought_quantity', 'REAL');
  // Must run after the ensureColumn call above, not in schema.sql: on a
  // pre-existing database, purchase_order_id doesn't exist yet when
  // schema.sql's CREATE statements run, so an index on it there would fail.
  db.exec('CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id)');

  // purchase_order_items originally had no parent document at all — fold any
  // pre-existing lines from that version into one, so they aren't silently
  // orphaned by the new purchase_order_id column.
  const orphanCount = db.prepare(
    'SELECT COUNT(*) AS c FROM purchase_order_items WHERE purchase_order_id IS NULL'
  ).get().c;
  if (orphanCount > 0) {
    const info = db.prepare("INSERT INTO purchase_orders (name, status) VALUES ('Purchase Order', 'open')").run();
    db.prepare('UPDATE purchase_order_items SET purchase_order_id = ? WHERE purchase_order_id IS NULL').run(info.lastInsertRowid);
  }
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

const BACKUP_KEEP = 10;
const BACKUP_MIN_AGE_MS = 60 * 60 * 1000; // don't snapshot again within an hour

// Local time, and ordered so a plain lexical sort is also chronological —
// which is what lets pruning below just sort by filename.
function backupStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(), '-', pad(date.getMonth() + 1), '-', pad(date.getDate()),
    '-', pad(date.getHours()), pad(date.getMinutes()),
  ].join('');
}

function existingBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^bookbin-.+\.db$/.test(f)).sort();
  } catch (err) {
    return [];
  }
}

/**
 * Writes a rolling snapshot of the database into workspaceDir/backups and
 * prunes all but the newest BACKUP_KEEP. Uses VACUUM INTO rather than a file
 * copy so the snapshot is a single, self-consistent database file with no WAL
 * alongside it — safe to sync, and safe to restore by renaming.
 *
 * Only the device holding the write lock should call this: a read-only
 * instance would be snapshotting a database it may only have half-received,
 * and would churn through the rolling window with duplicates.
 *
 * Never throws. A failed backup (folder unavailable, sync provider holding a
 * handle, disk full) is worth logging but not worth blocking launch over.
 */
function backupDatabase(db, workspaceDir) {
  const dir = backupsDir(workspaceDir);
  try {
    fs.mkdirSync(dir, { recursive: true });

    const backups = existingBackups(dir);
    if (backups.length) {
      const newest = path.join(dir, backups[backups.length - 1]);
      const age = Date.now() - fs.statSync(newest).mtimeMs;
      // Keeps the window spanning real time instead of filling with ten
      // snapshots from a single afternoon of opening and closing the app.
      if (age < BACKUP_MIN_AGE_MS) return null;
    }

    const target = path.join(dir, `bookbin-${backupStamp(new Date())}.db`);
    if (fs.existsSync(target)) return null;
    db.prepare('VACUUM INTO ?').run(target);

    const remaining = existingBackups(dir);
    for (const name of remaining.slice(0, Math.max(0, remaining.length - BACKUP_KEEP))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
    return target;
  } catch (err) {
    console.error('BookBin: database backup failed —', err.message);
    return null;
  }
}

/**
 * Closes the database cleanly. The explicit truncating checkpoint is the point
 * of this function: it folds the WAL back into bookbin.db and leaves the -wal
 * file zero-length, so what a sync provider uploads is one coherent file
 * rather than a database plus a WAL that another device may receive out of
 * step with it. Closing the last connection then removes -wal and -shm
 * entirely. Quitting without this leaves a populated WAL on disk.
 */
function closeDatabase(db) {
  if (!db || !db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error('BookBin: WAL checkpoint failed —', err.message);
  }
  try {
    db.close();
  } catch (err) {
    console.error('BookBin: database close failed —', err.message);
  }
}

module.exports = { initDatabase, backupDatabase, closeDatabase };

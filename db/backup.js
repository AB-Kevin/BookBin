// Daily backups of everything in the database, to a folder on this machine.
//
// Supabase's free tier includes no automatic backups, and the rolling local
// snapshots went out with SQLite, so without this there is no copy of the data
// anywhere but the one live database.
//
// Off by default. A backup folder has to be chosen deliberately, because
// writing business records onto a machine unprompted is not a decision to make
// on somebody's behalf.

const fs = require('fs');
const path = require('path');
const { table, unwrap } = require('./rest');

// Order matters for anyone reading the file back in: a table appears after
// everything it references.
const TABLES = [
  'settings',
  'profiles',
  'vendors',
  'customers',
  'items',
  'incoming_invoices',
  'incoming_invoice_lines',
  'outgoing_invoices',
  'outgoing_invoice_lines',
  'inventory_adjustments',
  'item_cost_snapshots',
  'purchase_orders',
  'purchase_order_items',
  'purchase_order_vendors',
  'purchase_order_invoices',
];

// Paging needs a stable order, which means a unique column. Most tables have
// an id; a link table is keyed by what it links.
const ORDER_COLUMN = {
  purchase_order_invoices: 'invoice_id',
};

// PostgREST caps a response at 1000 rows and says nothing about it: ask for a
// table with more and you get the first 1000 as though that were all of them.
// A backup that silently stops at 1000 is worse than no backup, because it
// looks like one.
const PAGE_SIZE = 1000;

const KEEP = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchAll(tableName) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = unwrap(
      await table(tableName).select('*').order(ORDER_COLUMN[tableName] || 'id', { ascending: true }).range(from, from + PAGE_SIZE - 1)
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(), '-', pad(date.getMonth() + 1), '-', pad(date.getDate()),
    '-', pad(date.getHours()), pad(date.getMinutes()),
  ].join('');
}

// Each database's files carry its tag, so two databases backing up into the
// same folder each keep their own last 14 rather than pruning each other's.
// The untagged name is the one used before there was more than one database,
// and matches only a bare timestamp -- never another database's tagged files.
function prefixFor(tag) {
  return tag ? `bookbin-backup-${tag}-` : 'bookbin-backup-';
}

function existingBackups(dir, tag) {
  const prefix = prefixFor(tag);
  const stampPattern = /^\d{4}-\d{2}-\d{2}-\d{4}\.json$/;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && stampPattern.test(f.slice(prefix.length)))
      .sort();
  } catch (err) {
    return [];
  }
}

/**
 * Writes one backup and prunes old ones. Returns a result rather than
 * throwing: a backup is something the app does in the background, and a
 * failure should be reported, not allowed to interrupt whatever the person
 * was doing.
 */
async function runBackup(dir, tag = '') {
  if (!dir) return { ok: false, error: 'No backup folder is set.' };

  try {
    fs.mkdirSync(dir, { recursive: true });

    const data = {};
    let rowCount = 0;
    for (const name of TABLES) {
      // profiles holds names, emails and roles -- no passwords, which live in
      // Supabase's auth schema and are not readable from here at all.
      data[name] = await fetchAll(name);
      rowCount += data[name].length;
    }

    const target = path.join(dir, `${prefixFor(tag)}${stamp(new Date())}.json`);
    const contents = {
      generatedAt: new Date().toISOString(),
      note: 'BookBin data backup. Table rows exactly as stored; numeric columns are strings.',
      tables: data,
    };

    // Written to a temporary name and renamed, so an interrupted write cannot
    // leave a half-finished file looking like a complete backup.
    const temp = `${target}.part`;
    fs.writeFileSync(temp, JSON.stringify(contents, null, 2), 'utf8');
    fs.renameSync(temp, target);

    const remaining = existingBackups(dir, tag);
    for (const name of remaining.slice(0, Math.max(0, remaining.length - KEEP))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }

    return { ok: true, file: target, rowCount, at: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message, at: new Date().toISOString() };
  }
}

/** True when no backup has been written in the last day. */
function isDue(lastRunIso) {
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso).getTime();
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= DAY_MS;
}

module.exports = { runBackup, isDue, TABLES, KEEP, DAY_MS };

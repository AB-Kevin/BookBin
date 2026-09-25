#!/usr/bin/env node
// Reads the SQLite database and writes a single .sql file that loads it into
// the Postgres schema, ids and all.
//
// Why generate SQL instead of pushing rows with supabase-js: the generated
// file runs in the SQL Editor as the postgres role, which sidesteps RLS, the
// need to authenticate, and PostgREST's awkwardness around explicit ids. It is
// also reviewable before it touches anything, and re-runnable if it fails.
//
// The output is wrapped in a transaction and preceded by an emptiness guard,
// so a failed load rolls back and leaves the database exactly as it was --
// which is what makes it safe to fix a problem and simply run it again.
//
// Usage:
//   node scripts/export-to-supabase.js [--db <path>] [--out <path>]
//
// The database is opened read-only, so it is safe to run while BookBin is
// open on this or any other machine.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------- value types

const sqlNull = 'null';

function sqlText(v) {
  if (v === null || v === undefined) return sqlNull;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlNumber(v) {
  if (v === null || v === undefined) return sqlNull;
  if (!Number.isFinite(Number(v))) throw new Error(`not a number: ${JSON.stringify(v)}`);
  return String(v);
}

// SQLite has no boolean type; the app stores 0/1 integers.
function sqlBool(v) {
  if (v === null || v === undefined) return sqlNull;
  return Number(v) ? 'true' : 'false';
}

// created_at columns are written by SQLite's datetime('now'), which is UTC but
// records no zone. Tagging +00 preserves the actual instant; leaving it untagged
// would make Postgres read every timestamp in the server's zone and silently
// shift the whole history by several hours.
function sqlTimestamp(v) {
  if (v === null || v === undefined || v === '') return sqlNull;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) {
    throw new Error(`unrecognised timestamp: ${JSON.stringify(v)}`);
  }
  return `'${s.replace('T', ' ')}+00'::timestamptz`;
}

function sqlDate(v) {
  if (v === null || v === undefined || v === '') return sqlNull;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`unrecognised date: ${JSON.stringify(v)}`);
  }
  return `'${s}'::date`;
}

function sqlJson(v) {
  if (v === null || v === undefined || v === '') return sqlNull;
  JSON.parse(v); // fail here rather than in Postgres, where the error is vaguer
  return `${sqlText(v)}::jsonb`;
}

const FORMATTERS = {
  text: sqlText,
  number: sqlNumber,
  bool: sqlBool,
  timestamp: sqlTimestamp,
  date: sqlDate,
  json: sqlJson,
};

// --------------------------------------------------------------- the tables

// Order matters: a table may only appear after everything it references.
// [column, type, notNull]
const TABLES = [
  ['vendors', [
    ['id', 'number', true], ['name', 'text', true], ['contact_name', 'text'],
    ['email', 'text'], ['phone', 'text'], ['address', 'text'], ['notes', 'text'],
    ['created_at', 'timestamp', true],
  ]],
  ['customers', [
    ['id', 'number', true], ['name', 'text', true], ['contact_name', 'text'],
    ['email', 'text'], ['phone', 'text'], ['address', 'text'], ['notes', 'text'],
    ['created_at', 'timestamp', true],
  ]],
  ['items', [
    ['id', 'number', true], ['sku', 'text'], ['name', 'text', true],
    ['description', 'text'], ['unit', 'text', true], ['is_inventory', 'bool', true],
    ['quantity_on_hand', 'number', true], ['default_cost', 'number', true],
    ['default_price', 'number', true], ['created_at', 'timestamp', true],
  ]],
  ['incoming_invoices', [
    ['id', 'number', true], ['vendor_id', 'number'], ['invoice_number', 'text', true],
    ['invoice_date', 'date', true], ['notes', 'text'], ['total', 'number', true],
    ['shipping_tax', 'number', true], ['paid', 'bool', true], ['received', 'bool', true],
    ['attachment_path', 'text'], ['attachment_name', 'text'],
    ['created_at', 'timestamp', true],
  ]],
  ['incoming_invoice_lines', [
    ['id', 'number', true], ['invoice_id', 'number', true], ['item_id', 'number'],
    ['description', 'text', true], ['quantity', 'number', true],
    ['unit_cost', 'number', true], ['line_total', 'number', true],
  ]],
  ['outgoing_invoices', [
    ['id', 'number', true], ['customer_id', 'number'], ['invoice_number', 'text', true],
    ['invoice_date', 'date', true], ['notes', 'text'], ['total', 'number', true],
    ['status', 'text', true], ['attachment_path', 'text'], ['attachment_name', 'text'],
    ['created_at', 'timestamp', true],
  ]],
  ['outgoing_invoice_lines', [
    ['id', 'number', true], ['invoice_id', 'number', true], ['item_id', 'number'],
    ['description', 'text', true], ['quantity', 'number', true],
    ['unit_price', 'number', true], ['line_total', 'number', true],
  ]],
  ['inventory_adjustments', [
    ['id', 'number', true], ['item_id', 'number', true], ['delta', 'number', true],
    ['reason', 'text', true], ['source_type', 'text', true], ['source_id', 'number'],
    ['created_at', 'timestamp', true],
  ]],
  ['item_cost_snapshots', [
    ['id', 'number', true], ['item_id', 'number', true], ['cost', 'number', true],
    ['price', 'number', true], ['markup_percent', 'number', true],
    ['breakdown', 'json', true], ['created_at', 'timestamp', true],
  ]],
  ['purchase_orders', [
    ['id', 'number', true], ['name', 'text', true], ['status', 'text', true],
    ['closed_at', 'timestamp'], ['created_at', 'timestamp', true],
  ]],
  ['purchase_order_items', [
    ['id', 'number', true], ['purchase_order_id', 'number'], ['item_id', 'number'],
    ['name', 'text', true], ['edition', 'text'], ['isbn', 'text'],
    ['quantity_wanted', 'number', true], ['max_price', 'number', true],
    ['notes', 'text'], ['frozen_bought_quantity', 'number'],
    ['created_at', 'timestamp', true],
  ]],
];

// settings is handled separately: migration 0001 already inserted the id=1 row,
// so this updates it rather than inserting a second one the CHECK would reject.
const SETTINGS_COLUMNS = [
  ['company_name', 'text'], ['company_address', 'text'], ['company_logo_path', 'text'],
  ['incoming_prefix', 'text'], ['incoming_next_number', 'number'],
  ['outgoing_prefix', 'text'], ['outgoing_next_number', 'number'],
  ['low_stock_threshold', 'number'], ['cost_markup_percent', 'number'],
];

const ROWS_PER_INSERT = 200;

// ----------------------------------------------------------------- resolve

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

// Mirrors workspace.js: the app records its chosen workspace in config.json
// under userData. Read it rather than making the user pass a path they would
// have to go looking for.
function defaultDbPath() {
  const appData = process.env.APPDATA
    || path.join(os.homedir(), 'AppData', 'Roaming');
  const configFile = path.join(appData, 'BookBin', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (config.workspaceDir) return path.join(config.workspaceDir, 'bookbin.db');
  } catch (err) {
    // no config, or not configured: fall through to the per-machine default
  }
  return path.join(appData, 'BookBin', 'bookbin.db');
}

// --------------------------------------------------------------- generate

function main() {
  const args = parseArgs(process.argv);
  const dbPath = args.db || defaultDbPath();
  const outPath = path.resolve(ROOT, args.out || 'supabase/seed/bookbin-data.sql');

  if (!fs.existsSync(dbPath)) {
    console.error(`\n  No database at: ${dbPath}\n  Pass one with --db <path>.\n`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const out = [];
  const problems = [];
  const counts = {};

  out.push('-- BookBin data, exported from SQLite for the Postgres schema.');
  out.push(`-- Source: ${dbPath}`);
  out.push(`-- Generated: ${new Date().toISOString()}`);
  out.push('--');
  out.push('-- Run this AFTER both migrations, in the Supabase SQL Editor.');
  out.push('-- It is one transaction: if any part fails, nothing is loaded and you');
  out.push('-- can fix the problem and run it again from a clean slate.');
  out.push('');
  out.push('begin;');
  out.push('');
  out.push('-- Refuse to run twice. Loading on top of existing rows would duplicate');
  out.push('-- everything and collide on ids.');
  out.push('do $guard$');
  out.push('begin');
  out.push("  if exists (select 1 from public.items)");
  out.push("     or exists (select 1 from public.vendors)");
  out.push("     or exists (select 1 from public.incoming_invoices) then");
  out.push("    raise exception 'Target database already contains BookBin data. "
    + "This load is meant for an empty database.';");
  out.push('  end if;');
  out.push('end;');
  out.push('$guard$;');
  out.push('');

  for (const [table, columns] of TABLES) {
    let rows;
    try {
      rows = db.prepare(`select * from "${table}"`).all();
    } catch (err) {
      problems.push(`${table}: cannot read (${err.message})`);
      continue;
    }
    counts[table] = rows.length;
    if (!rows.length) {
      out.push(`-- ${table}: no rows`);
      out.push('');
      continue;
    }

    const names = columns.map(([c]) => c);
    out.push(`-- ${table}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);

    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + ROWS_PER_INSERT);
      const values = [];
      for (const row of chunk) {
        const cells = [];
        for (const [col, type, notNull] of columns) {
          const raw = row[col];
          if (notNull && (raw === null || raw === undefined)) {
            problems.push(`${table}.${col} is null in row id=${row.id} but the column is NOT NULL`);
          }
          try {
            cells.push(FORMATTERS[type](raw));
          } catch (err) {
            problems.push(`${table}.${col} (row id=${row.id}): ${err.message}`);
            cells.push(sqlNull);
          }
        }
        values.push(`  (${cells.join(', ')})`);
      }
      out.push(`insert into public.${table} (${names.join(', ')}) values`);
      out.push(values.join(',\n') + ';');
    }
    out.push('');
  }

  // settings: update the row the schema migration already created.
  const settings = db.prepare('select * from settings where id = 1').get();
  if (settings) {
    const assignments = SETTINGS_COLUMNS.map(([col, type]) => {
      try {
        return `  ${col} = ${FORMATTERS[type](settings[col])}`;
      } catch (err) {
        problems.push(`settings.${col}: ${err.message}`);
        return `  ${col} = ${sqlNull}`;
      }
    });
    out.push('-- settings: updated in place, since the schema migration created row 1');
    out.push('update public.settings set');
    out.push(assignments.join(',\n'));
    out.push('where id = 1;');
    out.push('');
    counts.settings = 1;
  }

  // Identity sequences do not advance when ids are supplied explicitly, so
  // without this the next insert from the app would try to reuse id 1.
  out.push('-- Move each identity sequence past the ids just loaded.');
  for (const [table] of TABLES) {
    out.push(
      `select setval(pg_get_serial_sequence('public.${table}', 'id'), ` +
      `coalesce((select max(id) from public.${table}), 0) + 1, false);`
    );
  }
  out.push('');
  out.push('commit;');
  out.push('');

  db.close();

  if (problems.length) {
    console.error('\n  Export aborted. Problems found in the source data:\n');
    for (const p of problems.slice(0, 40)) console.error(`    - ${p}`);
    if (problems.length > 40) console.error(`    ... and ${problems.length - 40} more`);
    console.error('');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out.join('\n'), 'utf8');

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n  Read:    ${dbPath}`);
  console.log(`  Wrote:   ${path.relative(ROOT, outPath)}`);
  console.log(`  Rows:    ${total}\n`);
  for (const [table, n] of Object.entries(counts)) {
    console.log(`    ${table.padEnd(24)} ${n}`);
  }
  console.log('');
}

main();

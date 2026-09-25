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

// ------------------------------------------------- data verification build

// Aggregates computed on the SQLite side at export time and re-computed on the
// Postgres side afterwards. Row counts alone would pass even if every value in
// a row landed in the wrong column, so each table also gets sums over its
// numeric columns, and the tables with converted booleans get true-counts.
// [column, scale] -- scale must match the column's numeric(_, scale) in the
// schema. It matters: SQLite stores these as floats with arbitrary precision,
// and Postgres rounds each value as it lands. Summing the raw floats and then
// rounding gives a different answer from summing the rounded values, by a cent
// or so, which looks exactly like corruption and is not. The expected figure
// has to be computed the way Postgres will actually compute it: round every
// value to the column's scale first, then add.
const NUMERIC_SUMS = {
  items: [['quantity_on_hand', 4], ['default_cost', 4], ['default_price', 4]],
  incoming_invoices: [['total', 2], ['shipping_tax', 2]],
  incoming_invoice_lines: [['quantity', 4], ['unit_cost', 4], ['line_total', 2]],
  outgoing_invoices: [['total', 2]],
  outgoing_invoice_lines: [['quantity', 4], ['unit_price', 4], ['line_total', 2]],
  inventory_adjustments: [['delta', 4]],
  item_cost_snapshots: [['cost', 4], ['price', 4], ['markup_percent', 4]],
  purchase_order_items: [['quantity_wanted', 4], ['max_price', 4]],
};

// Postgres rounds numerics half away from zero; JavaScript's Math.round rounds
// half towards positive infinity. They disagree on negative halves, and delta
// is routinely negative.
function roundAtScale(value, scale) {
  const shifted = Number(value) * Math.pow(10, scale);
  return shifted < 0 ? -Math.round(-shifted) : Math.round(shifted);
}

// The 0/1 -> boolean conversion is the easiest thing to get silently backwards.
const BOOLEAN_COLUMNS = {
  items: ['is_inventory'],
  incoming_invoices: ['paid', 'received'],
};

// Tagging naive UTC strings with +00 is the other silent-failure risk: get it
// wrong and every timestamp shifts by the server's offset while still looking
// perfectly plausible. Comparing the extreme values in UTC catches it.
const TIMESTAMP_TABLES = ['incoming_invoices', 'inventory_adjustments', 'items'];

function buildDataVerification(db, sourcePath) {
  const checks = [];
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

  for (const [table] of TABLES) {
    const n = db.prepare(`select count(*) c from "${table}"`).get().c;
    checks.push(
      `select ${lit(table)} as table_name, 'row count' as check_name,\n` +
      `  case when (select count(*) from public.${table}) = ${n} then 'PASS'\n` +
      `       else 'FAIL - expected ${n}, got ' || (select count(*) from public.${table})::text end as status`
    );

    if (n === 0) continue;

    const maxId = db.prepare(`select max(id) m from "${table}"`).get().m;
    checks.push(
      `select ${lit(table)}, 'max id',\n` +
      `  case when (select max(id) from public.${table}) = ${maxId} then 'PASS'\n` +
      `       else 'FAIL - expected ${maxId}, got ' || (select max(id) from public.${table})::text end`
    );

    // The identity sequence must sit past the loaded ids, or the app's next
    // insert collides with an existing row.
    checks.push(
      `select ${lit(table)}, 'id sequence past data',\n` +
      `  case when (select last_value from pg_sequences\n` +
      `              where schemaname = 'public'\n` +
      `                and sequencename = split_part(\n` +
      `                      pg_get_serial_sequence('public.${table}', 'id'), '.', 2)) >= ${maxId}\n` +
      `       then 'PASS'\n` +
      `       else 'FAIL - sequence is at ' || coalesce((select last_value::text from pg_sequences\n` +
      `              where schemaname = 'public'\n` +
      `                and sequencename = split_part(\n` +
      `                      pg_get_serial_sequence('public.${table}', 'id'), '.', 2)), 'unset')\n` +
      `            || ', must be at least ${maxId}' end`
    );

    for (const [col, scale] of NUMERIC_SUMS[table] || []) {
      const values = db.prepare(`select "${col}" v from "${table}"`).all();
      let scaled = 0;
      for (const { v } of values) scaled += roundAtScale(v || 0, scale);
      const expected = (scaled / Math.pow(10, scale)).toFixed(scale);
      checks.push(
        `select ${lit(table)}, ${lit('sum of ' + col)},\n` +
        `  case when coalesce((select sum(${col}) from public.${table}), 0) = ${expected}\n` +
        `       then 'PASS'\n` +
        `       else 'FAIL - expected ${expected}, got ' || coalesce((select sum(${col}) from public.${table}), 0)::text end`
      );
    }

    for (const col of BOOLEAN_COLUMNS[table] || []) {
      const trues = db.prepare(`select count(*) c from "${table}" where "${col}" = 1`).get().c;
      checks.push(
        `select ${lit(table)}, ${lit(col + ' = true count')},\n` +
        `  case when (select count(*) from public.${table} where ${col}) = ${trues} then 'PASS'\n` +
        `       else 'FAIL - expected ${trues}, got ' || (select count(*) from public.${table} where ${col})::text end`
      );
    }

    if (TIMESTAMP_TABLES.includes(table)) {
      const range = db.prepare(
        `select min(created_at) lo, max(created_at) hi from "${table}"`
      ).get();
      if (range.lo && range.hi) {
        checks.push(
          `select ${lit(table)}, 'created_at range (UTC)',\n` +
          `  case when (select to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')\n` +
          `               || ' .. ' ||\n` +
          `             to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')\n` +
          `             from public.${table}) = ${lit(range.lo + ' .. ' + range.hi)}\n` +
          `       then 'PASS' else 'FAIL - timestamps shifted; expected ' ||\n` +
          `            ${lit(range.lo + ' .. ' + range.hi)} || ', got ' ||\n` +
          `            (select to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')\n` +
          `               || ' .. ' ||\n` +
          `             to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')\n` +
          `             from public.${table}) end`
        );
      }
    }
  }

  // Referential integrity: ids were carried over by hand, so prove nothing
  // points at a parent that did not come across.
  const orphanChecks = [
    ['incoming_invoice_lines', 'invoice_id', 'incoming_invoices'],
    ['outgoing_invoice_lines', 'invoice_id', 'outgoing_invoices'],
    ['inventory_adjustments', 'item_id', 'items'],
    ['item_cost_snapshots', 'item_id', 'items'],
    ['purchase_order_items', 'purchase_order_id', 'purchase_orders'],
    ['incoming_invoices', 'vendor_id', 'vendors'],
    ['outgoing_invoices', 'customer_id', 'customers'],
  ];
  for (const [child, fk, parent] of orphanChecks) {
    checks.push(
      `select ${lit(child)}, ${lit('no orphaned ' + fk)},\n` +
      `  case when (select count(*) from public.${child} c\n` +
      `              where c.${fk} is not null\n` +
      `                and not exists (select 1 from public.${parent} p where p.id = c.${fk})) = 0\n` +
      `       then 'PASS' else 'FAIL - orphaned rows found' end`
    );
  }

  const settings = db.prepare('select * from settings where id = 1').get();
  if (settings) {
    checks.push(
      `select 'settings', 'invoice numbering carried over',\n` +
      `  case when (select incoming_next_number = ${Number(settings.incoming_next_number)}\n` +
      `               and outgoing_next_number = ${Number(settings.outgoing_next_number)}\n` +
      `             from public.settings where id = 1) then 'PASS'\n` +
      `       else 'FAIL - next invoice numbers do not match' end`
    );
  }

  return [
    '-- BookBin data verification. Reads only; changes nothing.',
    `-- Generated from: ${sourcePath}`,
    `-- Generated: ${new Date().toISOString()}`,
    '--',
    '-- Every expected value below was measured on the SQLite database at export',
    '-- time, so these numbers cannot drift out of step with the data file beside',
    '-- them. Run this AFTER loading bookbin-data.sql.',
    '--',
    '-- One statement on purpose: the SQL Editor shows only one result set.',
    '-- Sort by the status column to bring any failure to the top.',
    '',
    'select table_name, check_name, status from (',
    checks.join('\n\nunion all\n'),
    ') checks order by (status <> \'PASS\') desc, table_name, check_name;',
    '',
  ].join('\n');
}

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
    // Three-argument form with is_called driven by whether the table has rows.
    // Passing is_called = false would also produce the right next id, but it
    // makes pg_sequences.last_value report NULL, which leaves the sequence
    // state unverifiable afterwards. For a non-empty table this records
    // last_value = max(id), is_called = true, so the next id is max + 1 and
    // the state can be read back and checked.
    out.push(
      `select setval(pg_get_serial_sequence('public.${table}', 'id'), ` +
      `coalesce((select max(id) from public.${table}), 1), ` +
      `(select count(*) > 0 from public.${table}));`
    );
  }
  out.push('');
  out.push('commit;');
  out.push('');

  if (problems.length) {
    console.error('\n  Export aborted. Problems found in the source data:\n');
    for (const p of problems.slice(0, 40)) console.error(`    - ${p}`);
    if (problems.length > 40) console.error(`    ... and ${problems.length - 40} more`);
    console.error('');
    process.exit(1);
  }

  const verifyPath = path.join(path.dirname(outPath), 'verify-data.sql');
  const verifySql = buildDataVerification(db, dbPath);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out.join('\n'), 'utf8');
  fs.writeFileSync(verifyPath, verifySql, 'utf8');

  db.close();

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n  Read:    ${dbPath}`);
  console.log(`  Wrote:   ${path.relative(ROOT, outPath)}`);
  console.log(`           ${path.relative(ROOT, verifyPath)}`);
  console.log(`  Rows:    ${total}\n`);
  for (const [table, n] of Object.entries(counts)) {
    console.log(`    ${table.padEnd(24)} ${n}`);
  }
  console.log('');
}

main();

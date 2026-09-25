// Shared helpers for the ported IPC handlers.
//
// Three things every ported domain needs, collected here so each one does not
// reinvent them:
//
//   unwrap()   -- turn Supabase's {data, error} into a value or a readable
//                 throw, so handlers read like the better-sqlite3 calls they
//                 replace and the renderer's existing error paths still work.
//
//   toNumber() -- PostgREST serialises `numeric` as a STRING, to avoid handing
//                 back a float it cannot represent exactly. That is the right
//                 call by the wire format and a trap for the code reading it:
//                 "5" * 2 is 10, but "5" + 2 is "52", so a total built by
//                 addition silently becomes concatenated text. Every numeric
//                 column has to pass through here on the way out.
//
//   byName()   -- SQLite ordered with COLLATE NOCASE. Postgres orders by the
//                 database's collation, which is not necessarily the same, so
//                 name ordering is done here rather than depending on how the
//                 server happens to be configured.

const { getSupabase } = require('./supabase');
const { describeConnectionFailure } = require('./errors');

/** Throws on error, otherwise returns data. */
function unwrap(result) {
  if (result.error) throw toFriendlyError(result.error);
  return result.data;
}

function toFriendlyError(error) {
  const code = error.code || '';
  const message = error.message || String(error);

  if (code === '42501') {
    return new Error('You do not have permission to do that.');
  }
  if (code === '23503') {
    return new Error('That record is still referenced by something else and cannot be removed.');
  }
  if (code === '23505') {
    return new Error('A record with those details already exists.');
  }
  const connection = describeConnectionFailure(error);
  if (connection) return new Error(connection);
  const wrapped = new Error(message);
  wrapped.code = code;
  return wrapped;
}

/** Coerces a PostgREST numeric (string) to a JS number. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns a mapper that coerces the named columns on every row. Pass rows or a
 * single row; null passes straight through, since "not found" is a normal
 * result for a get().
 */
function numericColumns(...columns) {
  const coerceRow = (row) => {
    if (!row) return row;
    const out = { ...row };
    for (const column of columns) {
      if (column in out) out[column] = toNumber(out[column]);
    }
    return out;
  };
  return (value) => (Array.isArray(value) ? value.map(coerceRow) : coerceRow(value));
}

/** Case-insensitive name sort, matching the old COLLATE NOCASE ordering. */
function byName(rows) {
  return [...(rows || [])].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  );
}

function table(name) {
  return getSupabase().from(name);
}

module.exports = { table, unwrap, toNumber, numericColumns, byName, toFriendlyError };

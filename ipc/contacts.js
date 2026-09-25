// Vendors and customers.
//
// The two were byte-for-byte identical apart from the table name, so they are
// one factory now rather than two files kept in step by hand.
//
// Ported to Supabase. The channel names, arguments and return shapes are
// exactly what the SQLite versions produced, so no screen changed: the
// renderer already awaited these calls, and a promise that now crosses a
// network looks the same from there as one that did not.

const { table, unwrap, byName } = require('../db/rest');

const COLUMNS = 'id, name, contact_name, email, phone, address, notes, created_at';

// Empty strings from the form become NULL, as they did before. Anything not
// listed here is ignored rather than passed through, so a renderer bug cannot
// write to a column this domain does not own.
function withDefaults(data) {
  return {
    name: data.name,
    contact_name: data.contact_name || null,
    email: data.email || null,
    phone: data.phone || null,
    address: data.address || null,
    notes: data.notes || null,
  };
}

function registerContacts(ipcMain, domain, tableName) {
  ipcMain.handle(`${domain}:list`, async () => {
    const rows = unwrap(await table(tableName).select(COLUMNS));
    return byName(rows);
  });

  ipcMain.handle(`${domain}:get`, async (_e, id) => {
    // maybeSingle, not single: "no such row" is a normal answer here and
    // should come back as null, the way better-sqlite3's get() did, rather
    // than as an error the renderer has to distinguish from a real failure.
    return unwrap(await table(tableName).select(COLUMNS).eq('id', id).maybeSingle());
  });

  ipcMain.handle(`${domain}:create`, async (_e, data) => {
    return unwrap(
      await table(tableName).insert(withDefaults(data)).select(COLUMNS).single()
    );
  });

  ipcMain.handle(`${domain}:update`, async (_e, id, data) => {
    return unwrap(
      await table(tableName).update(withDefaults(data)).eq('id', id).select(COLUMNS).single()
    );
  });

  ipcMain.handle(`${domain}:delete`, async (_e, id) => {
    unwrap(await table(tableName).delete().eq('id', id));
    return { ok: true };
  });
}

module.exports = {
  registerVendors: (ipcMain) => registerContacts(ipcMain, 'vendors', 'vendors'),
  registerCustomers: (ipcMain) => registerContacts(ipcMain, 'customers', 'customers'),
};

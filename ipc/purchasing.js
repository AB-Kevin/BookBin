// Purchase orders and the lines on them.
//
// One module because the two domains share the question that defines them:
// how much of an item has ever been bought. That lookup was duplicated across
// the two SQLite files and is now written once.
//
// Ported to Supabase. The one behavioural difference is that bought
// quantities are fetched for a whole order in a single call rather than one
// query per line -- over a network, the old row-at-a-time shape would have
// meant a round trip per line.

const { getSupabase } = require('../db/supabase');
const { table, unwrap, toNumber, numericColumns } = require('../db/rest');

const PO_COLUMNS = 'id, name, status, closed_at, created_at';
const LINE_COLUMNS =
  'id, purchase_order_id, item_id, name, edition, isbn, quantity_wanted, ' +
  'max_price, notes, frozen_bought_quantity, created_at';

const coerceLine = numericColumns('quantity_wanted', 'max_price', 'frozen_bought_quantity');

// Newest first, breaking ties on id -- several lines added in the same second
// would otherwise come back in an arbitrary order.
function newestFirst(rows) {
  return [...(rows || [])].sort(
    (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id
  );
}

/** Total ever bought, per item id, as a Map. One round trip for any number. */
async function boughtQuantities(itemIds) {
  const ids = [...new Set(itemIds.filter((id) => id !== null && id !== undefined))];
  if (!ids.length) return new Map();
  const { data, error } = await getSupabase().rpc('bought_quantities', { p_item_ids: ids });
  const rows = unwrap({ data, error }) || [];
  return new Map(rows.map((row) => [row.item_id, toNumber(row.quantity) || 0]));
}

async function getPurchaseOrder(id) {
  return unwrap(await table('purchase_orders').select(PO_COLUMNS).eq('id', id).maybeSingle());
}

async function linesFor(purchaseOrderId) {
  const rows = unwrap(
    await table('purchase_order_items')
      .select(LINE_COLUMNS)
      .eq('purchase_order_id', purchaseOrderId)
  );
  return rows.map(coerceLine);
}

// A closed order reports what was true the moment it closed; an open one is
// always computed live.
function resolveBought(line, poStatus, boughtByItem) {
  if (poStatus === 'closed') return Number(line.frozen_bought_quantity || 0);
  return line.item_id ? boughtByItem.get(line.item_id) || 0 : 0;
}

async function withSummary(po) {
  if (!po) return po;
  const lines = await linesFor(po.id);
  const boughtByItem =
    po.status === 'closed' ? new Map() : await boughtQuantities(lines.map((l) => l.item_id));

  const totalWanted = lines.reduce((sum, l) => sum + Number(l.quantity_wanted || 0), 0);
  const totalBought = lines.reduce(
    (sum, l) => sum + resolveBought(l, po.status, boughtByItem),
    0
  );
  return { ...po, line_count: lines.length, total_wanted: totalWanted, total_bought: totalBought };
}

// For the order list: per PO that tracks any vendor orders, how many of their
// invoices still need something done -- paying, or for orders shipped here,
// receiving too. One call for every PO. A PO with no tracked vendors is left
// out, which the list shows as nothing rather than as "0 to do".
async function vendorTodoByPo() {
  const { data, error } = await table('purchase_order_vendors')
    .select('purchase_order_id, ships_to, purchase_order_invoices(incoming_invoices(paid, received))');
  if (error) {
    // Most likely a database without the vendor-orders tables yet. The list
    // is still worth showing without this column's numbers.
    console.error('BookBin: could not read vendor orders —', error.message);
    return new Map();
  }
  const counts = new Map();
  for (const row of data || []) {
    const open = (row.purchase_order_invoices || [])
      .map((link) => link.incoming_invoices)
      .filter(Boolean)
      .filter((inv) => !inv.paid || (row.ships_to === 'me' && !inv.received)).length;
    counts.set(row.purchase_order_id, (counts.get(row.purchase_order_id) || 0) + open);
  }
  return counts;
}

function registerPurchaseOrders(ipcMain) {
  ipcMain.handle('purchaseOrders:list', async () => {
    const rows = newestFirst(unwrap(await table('purchase_orders').select(PO_COLUMNS)));
    // Sequential rather than parallel: each summary is itself two calls, and
    // an order list is short enough that fanning out buys nothing.
    const out = [];
    const vendorTodo = await vendorTodoByPo();
    for (const po of rows) out.push({ ...(await withSummary(po)), vendor_todo: vendorTodo.get(po.id) ?? null });
    return out;
  });

  ipcMain.handle('purchaseOrders:get', async (_e, id) => withSummary(await getPurchaseOrder(id)));

  ipcMain.handle('purchaseOrders:create', async (_e, data) => {
    const row = unwrap(
      await table('purchase_orders')
        .insert({ name: data.name, status: 'open' })
        .select(PO_COLUMNS)
        .single()
    );
    return withSummary(row);
  });

  ipcMain.handle('purchaseOrders:update', async (_e, id, data) => {
    const row = unwrap(
      await table('purchase_orders')
        .update({ name: data.name })
        .eq('id', id)
        .select(PO_COLUMNS)
        .single()
    );
    return withSummary(row);
  });

  ipcMain.handle('purchaseOrders:delete', async (_e, id) => {
    unwrap(await table('purchase_orders').delete().eq('id', id)); // cascades to its lines
    return { ok: true };
  });

  ipcMain.handle('purchaseOrders:close', async (_e, id) => {
    const { error } = await getSupabase().rpc('close_purchase_order', { p_id: id });
    unwrap({ data: null, error });
    return withSummary(await getPurchaseOrder(id));
  });

  ipcMain.handle('purchaseOrders:reopen', async (_e, id) => {
    const { error } = await getSupabase().rpc('reopen_purchase_order', { p_id: id });
    unwrap({ data: null, error });
    return withSummary(await getPurchaseOrder(id));
  });
}

function registerPurchaseOrderItems(ipcMain) {
  function withDefaults(data) {
    return {
      purchase_order_id: data.purchase_order_id,
      item_id: data.item_id || null,
      name: data.name,
      edition: data.edition || null,
      isbn: data.isbn || null,
      quantity_wanted: Number(data.quantity_wanted || 0),
      max_price: Number(data.max_price || 0),
      notes: data.notes || null,
    };
  }

  async function getLine(id) {
    const row = unwrap(
      await table('purchase_order_items').select(LINE_COLUMNS).eq('id', id).maybeSingle()
    );
    return row ? coerceLine(row) : null;
  }

  async function withBoughtQuantity(row) {
    if (!row) return row;
    const po = row.purchase_order_id ? await getPurchaseOrder(row.purchase_order_id) : null;
    const status = po && po.status;
    const boughtByItem =
      status === 'closed' ? new Map() : await boughtQuantities([row.item_id]);
    return { ...row, bought_quantity: resolveBought(row, status, boughtByItem) };
  }

  async function assertOpenPo(purchaseOrderId) {
    const po = await getPurchaseOrder(purchaseOrderId);
    if (po && po.status === 'closed') {
      throw new Error('This purchase order is closed and cannot be changed — reopen it first.');
    }
  }

  ipcMain.handle('purchaseOrderItems:list', async (_e, purchaseOrderId) => {
    const po = await getPurchaseOrder(purchaseOrderId);
    const lines = newestFirst(await linesFor(purchaseOrderId));
    const boughtByItem =
      po && po.status === 'closed'
        ? new Map()
        : await boughtQuantities(lines.map((l) => l.item_id));
    return lines.map((line) => ({
      ...line,
      bought_quantity: resolveBought(line, po && po.status, boughtByItem),
    }));
  });

  ipcMain.handle('purchaseOrderItems:get', async (_e, id) => withBoughtQuantity(await getLine(id)));

  ipcMain.handle('purchaseOrderItems:create', async (_e, data) => {
    await assertOpenPo(data.purchase_order_id);
    const row = unwrap(
      await table('purchase_order_items').insert(withDefaults(data)).select(LINE_COLUMNS).single()
    );
    return withBoughtQuantity(coerceLine(row));
  });

  ipcMain.handle('purchaseOrderItems:update', async (_e, id, data) => {
    const current = await getLine(id);
    if (current) await assertOpenPo(current.purchase_order_id);
    const row = unwrap(
      await table('purchase_order_items')
        .update(withDefaults(data))
        .eq('id', id)
        .select(LINE_COLUMNS)
        .single()
    );
    return withBoughtQuantity(coerceLine(row));
  });

  ipcMain.handle('purchaseOrderItems:delete', async (_e, id) => {
    const current = await getLine(id);
    if (current) await assertOpenPo(current.purchase_order_id);
    unwrap(await table('purchase_order_items').delete().eq('id', id));
    return { ok: true };
  });

  // Which incoming invoices bought this line's item. The row's `id` is the
  // invoice's, not the line's, as it was before.
  ipcMain.handle('purchaseOrderItems:invoices', async (_e, id) => {
    const line = await getLine(id);
    if (!line || !line.item_id) return [];

    const rows = unwrap(
      await table('incoming_invoice_lines')
        .select('quantity, unit_cost, incoming_invoices(id, invoice_number, invoice_date, vendors(name))')
        .eq('item_id', line.item_id)
    );

    return rows
      .map((row) => {
        const invoice = row.incoming_invoices || {};
        return {
          id: invoice.id,
          invoice_number: invoice.invoice_number || null,
          invoice_date: invoice.invoice_date || null,
          vendor_name: (invoice.vendors && invoice.vendors.name) || null,
          quantity: toNumber(row.quantity) || 0,
          unit_cost: toNumber(row.unit_cost) || 0,
        };
      })
      .sort(
        (a, b) =>
          String(b.invoice_date).localeCompare(String(a.invoice_date)) || b.id - a.id
      );
  });
}

// Vendor orders: whole invoices tracked against a PO, for books somebody else
// orders and this business pays for. See the purchase_order_vendors migration
// for why they are linked by hand rather than matched by vendor and date.
function registerPurchaseOrderVendors(ipcMain) {
  const INVOICE_COLUMNS = 'id, invoice_number, invoice_date, total, paid, received';

  function coerceInvoice(row) {
    return {
      id: row.id,
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      total: toNumber(row.total) || 0,
      paid: !!row.paid,
      received: !!row.received,
    };
  }

  async function assertOpenPo(purchaseOrderId) {
    const po = await getPurchaseOrder(purchaseOrderId);
    if (!po) throw new Error('That purchase order no longer exists.');
    if (po.status === 'closed') {
      throw new Error('This purchase order is closed and cannot be changed — reopen it first.');
    }
  }

  async function getEntry(id) {
    const row = unwrap(
      await table('purchase_order_vendors')
        .select('id, purchase_order_id, vendor_id')
        .eq('id', id)
        .maybeSingle()
    );
    if (!row) throw new Error('That vendor is no longer on this purchase order.');
    return row;
  }

  // Each tracked vendor with its linked invoices, oldest invoice first -- the
  // order they arrived in, which is the order they get dealt with.
  ipcMain.handle('purchaseOrderVendors:list', async (_e, purchaseOrderId) => {
    const rows = unwrap(
      await table('purchase_order_vendors')
        .select(
          'id, vendor_id, ships_to, notes, created_at, vendors(name), ' +
          `purchase_order_invoices(incoming_invoices(${INVOICE_COLUMNS}))`
        )
        .eq('purchase_order_id', purchaseOrderId)
    );
    return rows
      .map((row) => ({
        id: row.id,
        vendor_id: row.vendor_id,
        vendor_name: (row.vendors && row.vendors.name) || '(deleted vendor)',
        ships_to: row.ships_to,
        notes: row.notes,
        invoices: (row.purchase_order_invoices || [])
          .map((link) => link.incoming_invoices)
          .filter(Boolean)
          .map(coerceInvoice)
          .sort(
            (a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)) || a.id - b.id
          ),
      }))
      .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, undefined, { sensitivity: 'base' }));
  });

  ipcMain.handle('purchaseOrderVendors:create', async (_e, data) => {
    await assertOpenPo(data.purchase_order_id);
    const { error } = await table('purchase_order_vendors').insert({
      purchase_order_id: data.purchase_order_id,
      vendor_id: data.vendor_id,
      ships_to: data.ships_to === 'me' ? 'me' : 'warehouse',
      notes: data.notes || null,
    });
    if (error && error.code === '23505') {
      throw new Error('That vendor is already on this purchase order.');
    }
    unwrap({ data: null, error });
    return { ok: true };
  });

  ipcMain.handle('purchaseOrderVendors:update', async (_e, id, data) => {
    const entry = await getEntry(id);
    await assertOpenPo(entry.purchase_order_id);
    unwrap(
      await table('purchase_order_vendors')
        .update({ ships_to: data.ships_to === 'me' ? 'me' : 'warehouse', notes: data.notes || null })
        .eq('id', id)
    );
    return { ok: true };
  });

  // Takes its invoice links with it; the invoices themselves are untouched.
  ipcMain.handle('purchaseOrderVendors:delete', async (_e, id) => {
    const entry = await getEntry(id);
    await assertOpenPo(entry.purchase_order_id);
    unwrap(await table('purchase_order_vendors').delete().eq('id', id));
    return { ok: true };
  });

  // Invoices from this vendor that are not on any purchase order yet, newest
  // first: the likeliest ones to belong are the recent ones.
  ipcMain.handle('purchaseOrderVendors:candidates', async (_e, id) => {
    const entry = await getEntry(id);
    const [invoices, links] = await Promise.all([
      table('incoming_invoices').select(INVOICE_COLUMNS).eq('vendor_id', entry.vendor_id),
      table('purchase_order_invoices').select('invoice_id'),
    ]);
    const linked = new Set(unwrap(links).map((l) => l.invoice_id));
    return unwrap(invoices)
      .filter((inv) => !linked.has(inv.id))
      .map(coerceInvoice)
      .sort((a, b) => String(b.invoice_date).localeCompare(String(a.invoice_date)) || b.id - a.id);
  });

  ipcMain.handle('purchaseOrderVendors:link', async (_e, id, invoiceIds) => {
    const entry = await getEntry(id);
    await assertOpenPo(entry.purchase_order_id);
    const ids = [...new Set((invoiceIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return { ok: true };
    const { error } = await table('purchase_order_invoices').insert(
      ids.map((invoiceId) => ({ invoice_id: invoiceId, purchase_order_vendor_id: id }))
    );
    // Somebody else linked one of them in the meantime. The insert is one
    // statement, so none of this batch went in.
    if (error && error.code === '23505') {
      throw new Error(
        'One of those invoices has just been put on a purchase order by someone else. ' +
        'Nothing was linked; try again.'
      );
    }
    unwrap({ data: null, error });
    return { ok: true };
  });

  ipcMain.handle('purchaseOrderVendors:unlink', async (_e, invoiceId) => {
    const link = unwrap(
      await table('purchase_order_invoices')
        .select('purchase_order_vendor_id')
        .eq('invoice_id', invoiceId)
        .maybeSingle()
    );
    if (!link) return { ok: true };
    const entry = await getEntry(link.purchase_order_vendor_id);
    await assertOpenPo(entry.purchase_order_id);
    unwrap(await table('purchase_order_invoices').delete().eq('invoice_id', invoiceId));
    return { ok: true };
  });
}

module.exports = { registerPurchaseOrders, registerPurchaseOrderItems, registerPurchaseOrderVendors };

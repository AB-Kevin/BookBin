// The dashboard summary: what is running low, and what happened recently.
//
// Ported to Supabase. The low-stock query used to compare a column against a
// subquery (`quantity_on_hand <= (SELECT low_stock_threshold ...)`), which
// PostgREST cannot express, so the threshold is read first and passed as a
// value. Two round trips instead of one, for a screen that loads once.

const { table, unwrap, toNumber, numericColumns } = require('../db/rest');

const INCOMING_COLUMNS =
  'id, vendor_id, invoice_number, invoice_date, notes, total, shipping_tax, ' +
  'paid, received, attachment_path, attachment_name, created_at';

const OUTGOING_COLUMNS =
  'id, customer_id, invoice_number, invoice_date, notes, total, status, ' +
  'attachment_path, attachment_name, created_at';

const ITEM_COLUMNS =
  'id, sku, name, description, unit, is_inventory, quantity_on_hand, ' +
  'default_cost, default_price, created_at';

const coerceItem = numericColumns('quantity_on_hand', 'default_cost', 'default_price');
const coerceIncoming = numericColumns('total', 'shipping_tax');
const coerceOutgoing = numericColumns('total');

module.exports = function registerDashboard(ipcMain) {
  async function lowStockItems() {
    const settings = unwrap(
      await table('settings').select('low_stock_threshold').eq('id', 1).single()
    );
    const threshold = toNumber(settings.low_stock_threshold) || 0;

    const rows = unwrap(
      await table('items')
        .select(ITEM_COLUMNS)
        .eq('is_inventory', true)
        .lte('quantity_on_hand', threshold)
        .order('quantity_on_hand', { ascending: true })
    );
    return coerceItem(rows);
  }

  async function recentIncoming() {
    const rows = unwrap(
      await table('incoming_invoices')
        .select(`${INCOMING_COLUMNS}, vendors(name)`)
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(5)
    );
    return rows.map((row) => {
      const flat = coerceIncoming(row);
      delete flat.vendors;
      return { ...flat, vendor_name: (row.vendors && row.vendors.name) || null };
    });
  }

  async function recentOutgoing() {
    const rows = unwrap(
      await table('outgoing_invoices')
        .select(`${OUTGOING_COLUMNS}, customers(name)`)
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(5)
    );
    return rows.map((row) => {
      const flat = coerceOutgoing(row);
      delete flat.customers;
      return { ...flat, customer_name: (row.customers && row.customers.name) || null };
    });
  }

  ipcMain.handle('dashboard:summary', async () => {
    // Independent of one another, so they go out together rather than in
    // sequence: this is the first screen after signing in, and three round
    // trips one after another is the difference people actually notice.
    const [items, incoming, outgoing] = await Promise.all([
      lowStockItems(),
      recentIncoming(),
      recentOutgoing(),
    ]);
    return { lowStockItems: items, recentIncoming: incoming, recentOutgoing: outgoing };
  });
};

// The dashboard's cards, each loaded on its own.
//
// Which cards show, and in what order, is chosen per device in the renderer
// (renderer/screens/dashboard.js), so the page asks for each visible card's
// data separately: a hidden card costs nothing, and one that fails (a
// database missing a newer table, say) shows its own error while the rest
// still load.
//
// Low stock compares a column against a setting, which PostgREST cannot
// express as a subquery, so the threshold is read first and passed as a value.

const { table, unwrap, toNumber, numericColumns } = require('../db/rest');
const { boughtQuantities } = require('./purchasing');

const INVOICE_COLUMNS = 'id, invoice_number, invoice_date, total';

const coerceItem = numericColumns('quantity_on_hand', 'default_cost');
const coerceTotal = numericColumns('total');

// PostgREST hands back at most 1000 rows a request; the yearly totals read
// every invoice, which a few years of business can pass.
const PAGE_SIZE = 1000;

async function allRows(query) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = unwrap(await query().order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1));
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function withVendor(row) {
  const { vendors, ...rest } = coerceTotal(row);
  return { ...rest, vendor_name: (vendors && vendors.name) || null };
}

function withCustomer(row) {
  const { customers, ...rest } = coerceTotal(row);
  return { ...rest, customer_name: (customers && customers.name) || null };
}

// Today in the computer's own time zone, as invoice dates are written.
function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Outgoing invoices still in draft have not been sent to anyone, so the
// money figures leave them out.
const notDraft = (query) => query.neq('status', 'draft');

const loaders = {
  // The newest open purchase order: how far along it is, and what is still
  // to buy. Bought counts every invoice line for the item, as the order's own
  // screen does.
  async 'open-po'() {
    const open = unwrap(
      await table('purchase_orders')
        .select('id, name, created_at')
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
    );
    if (!open.length) return { po: null, otherOpen: 0 };
    const po = open[0];

    const lines = unwrap(
      await table('purchase_order_items')
        .select('id, item_id, name, edition, quantity_wanted, max_price')
        .eq('purchase_order_id', po.id)
    );
    const itemIds = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];
    const [bought, costs] = await Promise.all([
      boughtQuantities(itemIds),
      itemIds.length
        ? allRows(() => table('incoming_invoice_lines').select('id, item_id, unit_cost').in('item_id', itemIds))
        : [],
    ]);
    const highestCost = new Map();
    for (const row of costs) {
      const cost = toNumber(row.unit_cost) || 0;
      if (cost > (highestCost.get(row.item_id) || 0)) highestCost.set(row.item_id, cost);
    }

    return {
      po,
      otherOpen: open.length - 1,
      lines: lines.map((line) => ({
        id: line.id,
        name: line.name,
        edition: line.edition,
        wanted: toNumber(line.quantity_wanted) || 0,
        bought: line.item_id ? bought.get(line.item_id) || 0 : 0,
        max_price: toNumber(line.max_price) || 0,
        highest_cost: line.item_id ? highestCost.get(line.item_id) || 0 : 0,
      })),
    };
  },

  // Oldest first: the longest-owed bill, or the longest-awaited box, on top.
  async 'unpaid-incoming'() {
    const rows = unwrap(
      await table('incoming_invoices')
        .select(`${INVOICE_COLUMNS}, vendors(name)`)
        .eq('paid', false)
        .order('invoice_date', { ascending: true })
        .order('id', { ascending: true })
    );
    return rows.map(withVendor);
  },

  async 'not-received'() {
    const rows = unwrap(
      await table('incoming_invoices')
        .select(`${INVOICE_COLUMNS}, vendors(name)`)
        .eq('received', false)
        .order('invoice_date', { ascending: true })
        .order('id', { ascending: true })
    );
    return rows.map(withVendor);
  },

  async 'recent-incoming'() {
    const rows = unwrap(
      await table('incoming_invoices')
        .select(`${INVOICE_COLUMNS}, vendors(name)`)
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(5)
    );
    return rows.map(withVendor);
  },

  async 'recent-outgoing'() {
    const rows = unwrap(
      await table('outgoing_invoices')
        .select(`${INVOICE_COLUMNS}, status, customers(name)`)
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(5)
    );
    return rows.map(withCustomer);
  },

  // Spent and invoiced per calendar year, each year also totalled only up to
  // today's month and day, so this year so far can be set beside the same
  // stretch of earlier years rather than against their whole.
  async 'year-totals'() {
    const today = localToday();
    const monthDay = today.slice(5);
    const [incoming, outgoing] = await Promise.all([
      allRows(() => table('incoming_invoices').select('id, invoice_date, total')),
      allRows(() => notDraft(table('outgoing_invoices').select('id, invoice_date, total'))),
    ]);

    const years = new Map();
    function add(rows, key) {
      for (const row of rows) {
        if (!row.invoice_date) continue;
        const year = Number(row.invoice_date.slice(0, 4));
        if (!years.has(year)) years.set(year, { year, spent: 0, invoiced: 0, spentToDate: 0, invoicedToDate: 0 });
        const entry = years.get(year);
        const total = toNumber(row.total) || 0;
        entry[key] += total;
        if (row.invoice_date.slice(5) <= monthDay) entry[`${key}ToDate`] += total;
      }
    }
    add(incoming, 'spent');
    add(outgoing, 'invoiced');

    return {
      today,
      currentYear: Number(today.slice(0, 4)),
      years: [...years.values()].sort((a, b) => b.year - a.year),
    };
  },

  async 'low-stock'() {
    const settings = unwrap(
      await table('settings').select('low_stock_threshold').eq('id', 1).single()
    );
    const threshold = toNumber(settings.low_stock_threshold) || 0;
    const rows = unwrap(
      await table('items')
        .select('id, name, quantity_on_hand')
        .eq('is_inventory', true)
        .lte('quantity_on_hand', threshold)
        .order('quantity_on_hand', { ascending: true })
    );
    return coerceItem(rows);
  },

  async 'left-to-ship'() {
    const rows = await allRows(() =>
      table('items')
        .select('id, name, quantity_on_hand, default_cost')
        .eq('is_inventory', true)
        .gt('quantity_on_hand', 0)
    );
    return coerceItem(rows).sort((a, b) => b.quantity_on_hand - a.quantity_on_hand);
  },

  async 'draft-outgoing'() {
    const rows = unwrap(
      await table('outgoing_invoices')
        .select(`${INVOICE_COLUMNS}, customers(name)`)
        .eq('status', 'draft')
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
    );
    return rows.map(withCustomer);
  },

  async 'top-customers'() {
    const year = localToday().slice(0, 4);
    const rows = await allRows(() =>
      notDraft(
        table('outgoing_invoices')
          .select('id, customer_id, total, customers(name)')
          .gte('invoice_date', `${year}-01-01`)
          .lte('invoice_date', `${year}-12-31`)
      )
    );
    const byCustomer = new Map();
    for (const row of rows) {
      const key = row.customer_id ?? 'none';
      if (!byCustomer.has(key)) {
        byCustomer.set(key, {
          name: (row.customers && row.customers.name) || null,
          invoices: 0,
          total: 0,
        });
      }
      const entry = byCustomer.get(key);
      entry.invoices += 1;
      entry.total += toNumber(row.total) || 0;
    }
    return [...byCustomer.values()].sort((a, b) => b.total - a.total).slice(0, 5);
  },
};

module.exports = function registerDashboard(ipcMain) {
  ipcMain.handle('dashboard:card', async (_e, id) => {
    const load = loaders[id];
    if (!load) throw new Error(`There is no dashboard card called "${id}".`);
    return load();
  });
};

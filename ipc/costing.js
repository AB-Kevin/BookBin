// Automates the manual costing spreadsheet process: for a given item, pools
// every incoming-invoice line that ever bought it, gives each line its
// proportional share of that invoice's shipping/tax (by the line's percentage
// of the invoice's raw line-item subtotal), and takes a quantity-weighted
// average of the resulting per-unit costs across every invoice. A markup is
// then applied to get the selling price. Recalculating is an explicit,
// on-demand action (not automatic) and writes a permanent snapshot row so
// the exact contributing invoice lines and shares are still visible later,
// even if those invoices are subsequently edited or deleted.
//
// Ported to Supabase with the arithmetic untouched. Only the reads and the
// final write changed: rows arrive over REST, get aggregated here exactly as
// the SQL GROUP BY used to, and the snapshot plus the item's new cost are
// written together by record_item_cost().
//
// The read and the write are no longer one transaction, which the SQLite
// version got for free. In practice that does not matter: recalculating is a
// deliberate button press, and a snapshot records the precise lines it was
// computed from, so a recalculation that raced an invoice edit is visibly
// explained by its own breakdown rather than being silently wrong.

const { getSupabase } = require('../db/supabase');
const { table, unwrap, toNumber, numericColumns } = require('../db/rest');

const SNAPSHOT_COLUMNS = 'id, item_id, cost, price, markup_percent, breakdown, created_at';

const coerceSnapshot = numericColumns('cost', 'price', 'markup_percent');
const coerceItem = numericColumns('quantity_on_hand', 'default_cost', 'default_price');

// breakdown is a jsonb column, so it arrives already parsed. The string branch
// is for rows written by the SQLite version, where it was TEXT.
function withParsedBreakdown(row) {
  if (!row) return row;
  const snapshot = coerceSnapshot(row);
  if (typeof snapshot.breakdown === 'string') {
    try {
      snapshot.breakdown = JSON.parse(snapshot.breakdown);
    } catch (err) {
      snapshot.breakdown = null;
    }
  }
  return snapshot;
}

module.exports = function registerCosting(ipcMain) {
  async function linesForItem(itemId) {
    const rows = unwrap(
      await table('incoming_invoice_lines')
        .select('invoice_id, quantity, unit_cost, incoming_invoices(invoice_number, invoice_date, shipping_tax, vendors(name))')
        .eq('item_id', itemId)
    );
    return rows
      .map((row) => {
        const invoice = row.incoming_invoices || {};
        return {
          invoice_id: row.invoice_id,
          quantity: toNumber(row.quantity) || 0,
          unit_cost: toNumber(row.unit_cost) || 0,
          invoice_number: invoice.invoice_number || null,
          invoice_date: invoice.invoice_date || null,
          shipping_tax: toNumber(invoice.shipping_tax) || 0,
          vendor_name: (invoice.vendors && invoice.vendors.name) || null,
        };
      })
      // Matches the old ORDER BY ii.invoice_date, ii.id.
      .sort((a, b) =>
        String(a.invoice_date).localeCompare(String(b.invoice_date)) || a.invoice_id - b.invoice_id
      );
  }

  // Replaces the old GROUP BY: PostgREST cannot aggregate, so the invoice's
  // lines are fetched and totalled here instead.
  async function invoiceStatsFor(invoiceIds) {
    if (!invoiceIds.length) return new Map();
    const rows = unwrap(
      await table('incoming_invoice_lines')
        .select('invoice_id, quantity, unit_cost')
        .in('invoice_id', invoiceIds)
    );
    const stats = new Map();
    for (const row of rows) {
      const entry = stats.get(row.invoice_id) || { invoice_id: row.invoice_id, subtotal: 0, line_count: 0 };
      entry.subtotal += (toNumber(row.quantity) || 0) * (toNumber(row.unit_cost) || 0);
      entry.line_count += 1;
      stats.set(row.invoice_id, entry);
    }
    return stats;
  }

  // Returns null when the item has never appeared on an incoming invoice —
  // there's nothing to cost it from.
  async function computeItemBreakdown(itemId) {
    const lines = await linesForItem(itemId);
    if (lines.length === 0) return null;

    const invoiceIds = [...new Set(lines.map((l) => l.invoice_id))];
    const statsByInvoice = await invoiceStatsFor(invoiceIds);

    let totalCostWithShipping = 0;
    let totalQuantity = 0;
    const contributions = lines.map((line) => {
      const rawTotal = line.quantity * line.unit_cost;
      const stats = statsByInvoice.get(line.invoice_id) || { subtotal: 0, line_count: 0 };
      const shippingTax = line.shipping_tax || 0;
      // If every line on the invoice is $0 (a free/promo invoice), fall back
      // to splitting the shipping/tax evenly across its lines instead of
      // dividing by a zero subtotal.
      const share = stats.subtotal > 0
        ? (rawTotal / stats.subtotal) * shippingTax
        : (stats.line_count > 0 ? shippingTax / stats.line_count : 0);
      const costWithShipping = rawTotal + share;
      const unitCostEffective = line.quantity > 0 ? costWithShipping / line.quantity : 0;

      totalCostWithShipping += costWithShipping;
      totalQuantity += line.quantity;

      return {
        invoice_id: line.invoice_id,
        invoice_number: line.invoice_number,
        invoice_date: line.invoice_date,
        vendor_name: line.vendor_name,
        quantity: line.quantity,
        unit_cost: line.unit_cost,
        raw_total: rawTotal,
        invoice_raw_subtotal: stats.subtotal,
        invoice_shipping_tax: shippingTax,
        shipping_tax_share: share,
        cost_with_shipping: costWithShipping,
        unit_cost_effective: unitCostEffective,
      };
    });

    const cost = totalQuantity > 0 ? totalCostWithShipping / totalQuantity : 0;
    return { totalQuantity, totalCostWithShipping, cost, contributions };
  }

  async function recalculateItem(itemId) {
    const breakdown = await computeItemBreakdown(itemId);
    if (!breakdown) return { ok: false, reason: 'no-history' };

    const settings = unwrap(
      await table('settings').select('cost_markup_percent').eq('id', 1).single()
    );
    const markupPercent = toNumber(settings.cost_markup_percent) || 0;
    const cost = breakdown.cost;
    const price = Math.round(cost * (1 + markupPercent / 100) * 100) / 100;

    const { data, error } = await getSupabase().rpc('record_item_cost', {
      p_item_id: itemId,
      p_cost: cost,
      p_price: price,
      p_markup_percent: markupPercent,
      p_breakdown: {
        totalQuantity: breakdown.totalQuantity,
        totalCostWithShipping: breakdown.totalCostWithShipping,
        contributions: breakdown.contributions,
      },
    });
    const result = unwrap({ data, error });

    return {
      ok: true,
      snapshot: withParsedBreakdown(result.snapshot),
      item: coerceItem(result.item),
    };
  }

  ipcMain.handle('costing:recalculateItem', (_e, itemId) => recalculateItem(itemId));

  ipcMain.handle('costing:recalculateAll', async () => {
    // Replaces SELECT DISTINCT, which PostgREST has no equivalent for.
    const rows = unwrap(
      await table('incoming_invoice_lines').select('item_id').not('item_id', 'is', null)
    );
    const itemIds = [...new Set(rows.map((r) => r.item_id))];

    // Sequential on purpose: each call writes an item and a snapshot, and
    // firing all of them at once would have every recalculation competing for
    // connections to no benefit on a list this size.
    const results = [];
    for (const itemId of itemIds) {
      results.push({ itemId, ...(await recalculateItem(itemId)) });
    }
    return results;
  });

  ipcMain.handle('costing:history', async (_e, itemId) => {
    const rows = unwrap(
      await table('item_cost_snapshots')
        .select(SNAPSHOT_COLUMNS)
        .eq('item_id', itemId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
    );
    return rows.map(withParsedBreakdown);
  });
};

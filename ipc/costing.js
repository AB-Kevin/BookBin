// Automates the manual costing spreadsheet process: for a given item, pools
// every incoming-invoice line that ever bought it, gives each line its
// proportional share of that invoice's shipping/tax (by the line's percentage
// of the invoice's raw line-item subtotal), and takes a quantity-weighted
// average of the resulting per-unit costs across every invoice. A markup is
// then applied to get the selling price. Recalculating is an explicit,
// on-demand action (not automatic) and writes a permanent snapshot row so
// the exact contributing invoice lines and shares are still visible later,
// even if those invoices are subsequently edited or deleted.
module.exports = function registerCosting(ipcMain, db) {
  const linesForItemStmt = db.prepare(`
    SELECT l.invoice_id, l.quantity, l.unit_cost,
           ii.invoice_number, ii.invoice_date, ii.shipping_tax,
           v.name AS vendor_name
    FROM incoming_invoice_lines l
    JOIN incoming_invoices ii ON ii.id = l.invoice_id
    LEFT JOIN vendors v ON v.id = ii.vendor_id
    WHERE l.item_id = ?
    ORDER BY ii.invoice_date, ii.id
  `);
  const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ?');
  const updateItemCostStmt = db.prepare(
    'UPDATE items SET default_cost = @default_cost, default_price = @default_price WHERE id = @id'
  );
  const getSettingsStmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const insertSnapshotStmt = db.prepare(`
    INSERT INTO item_cost_snapshots (item_id, cost, price, markup_percent, breakdown)
    VALUES (@item_id, @cost, @price, @markup_percent, @breakdown)
  `);
  const getSnapshotStmt = db.prepare('SELECT * FROM item_cost_snapshots WHERE id = ?');
  const historyStmt = db.prepare(
    'SELECT * FROM item_cost_snapshots WHERE item_id = ? ORDER BY created_at DESC, id DESC'
  );
  const itemIdsWithPurchasesStmt = db.prepare(
    'SELECT DISTINCT item_id FROM incoming_invoice_lines WHERE item_id IS NOT NULL'
  );

  function invoiceStatsFor(invoiceIds) {
    const placeholders = invoiceIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT invoice_id, SUM(quantity * unit_cost) AS subtotal, COUNT(*) AS line_count
      FROM incoming_invoice_lines
      WHERE invoice_id IN (${placeholders})
      GROUP BY invoice_id
    `).all(...invoiceIds);
    return new Map(rows.map((r) => [r.invoice_id, r]));
  }

  // Returns null when the item has never appeared on an incoming invoice —
  // there's nothing to cost it from.
  function computeItemBreakdown(itemId) {
    const lines = linesForItemStmt.all(itemId);
    if (lines.length === 0) return null;

    const invoiceIds = [...new Set(lines.map((l) => l.invoice_id))];
    const statsByInvoice = invoiceStatsFor(invoiceIds);

    let totalCostWithShipping = 0;
    let totalQuantity = 0;
    const contributions = lines.map((line) => {
      const rawTotal = line.quantity * line.unit_cost;
      const stats = statsByInvoice.get(line.invoice_id);
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

  const recalculateItemTx = db.transaction((itemId) => {
    const breakdown = computeItemBreakdown(itemId);
    if (!breakdown) return { ok: false, reason: 'no-history' };

    const markupPercent = getSettingsStmt.get().cost_markup_percent;
    const cost = breakdown.cost;
    const price = Math.round(cost * (1 + markupPercent / 100) * 100) / 100;

    const info = insertSnapshotStmt.run({
      item_id: itemId,
      cost,
      price,
      markup_percent: markupPercent,
      breakdown: JSON.stringify({
        totalQuantity: breakdown.totalQuantity,
        totalCostWithShipping: breakdown.totalCostWithShipping,
        contributions: breakdown.contributions,
      }),
    });
    updateItemCostStmt.run({ id: itemId, default_cost: cost, default_price: price });

    return { ok: true, snapshot: withParsedBreakdown(getSnapshotStmt.get(info.lastInsertRowid)), item: getItemStmt.get(itemId) };
  });

  function withParsedBreakdown(row) {
    if (!row) return row;
    return { ...row, breakdown: JSON.parse(row.breakdown) };
  }

  ipcMain.handle('costing:recalculateItem', (_e, itemId) => recalculateItemTx(itemId));

  ipcMain.handle('costing:recalculateAll', () => {
    const itemIds = itemIdsWithPurchasesStmt.all().map((r) => r.item_id);
    return itemIds.map((itemId) => ({ itemId, ...recalculateItemTx(itemId) }));
  });

  ipcMain.handle('costing:history', (_e, itemId) => historyStmt.all(itemId).map(withParsedBreakdown));
};

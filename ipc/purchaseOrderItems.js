module.exports = function registerPurchaseOrderItems(ipcMain, db) {
  const listByPoStmt = db.prepare(
    'SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY created_at DESC, id DESC'
  );
  const getStmt = db.prepare('SELECT * FROM purchase_order_items WHERE id = ?');
  const getPoStmt = db.prepare('SELECT * FROM purchase_orders WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO purchase_order_items (purchase_order_id, item_id, name, edition, isbn, quantity_wanted, max_price, notes)
    VALUES (@purchase_order_id, @item_id, @name, @edition, @isbn, @quantity_wanted, @max_price, @notes)
  `);
  const updateStmt = db.prepare(`
    UPDATE purchase_order_items SET
      item_id = @item_id, name = @name, edition = @edition, isbn = @isbn,
      quantity_wanted = @quantity_wanted, max_price = @max_price, notes = @notes
    WHERE id = @id
  `);
  const deleteStmt = db.prepare('DELETE FROM purchase_order_items WHERE id = ?');

  // Total ever bought of the linked item, across all incoming invoices —
  // not scoped to after this line was created, since stock fully sells
  // through between yearly batches (see schema.sql's comment on this table).
  const boughtQtyStmt = db.prepare(
    'SELECT COALESCE(SUM(quantity), 0) AS qty FROM incoming_invoice_lines WHERE item_id = ?'
  );
  const invoicesForItemStmt = db.prepare(`
    SELECT ii.id, ii.invoice_number, ii.invoice_date, v.name AS vendor_name,
           l.quantity, l.unit_cost
    FROM incoming_invoice_lines l
    JOIN incoming_invoices ii ON ii.id = l.invoice_id
    LEFT JOIN vendors v ON v.id = ii.vendor_id
    WHERE l.item_id = ?
    ORDER BY ii.invoice_date DESC, ii.id DESC
  `);

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

  // A closed order's lines show whatever was true the moment it closed
  // (frozen_bought_quantity), regardless of anything that's happened since;
  // an open order's lines are always computed live.
  function withBoughtQuantity(row) {
    if (!row) return row;
    const po = row.purchase_order_id ? getPoStmt.get(row.purchase_order_id) : null;
    const boughtQuantity = po && po.status === 'closed'
      ? Number(row.frozen_bought_quantity || 0)
      : (row.item_id ? boughtQtyStmt.get(row.item_id).qty : 0);
    return { ...row, bought_quantity: boughtQuantity };
  }

  function assertOpenPo(purchaseOrderId) {
    const po = getPoStmt.get(purchaseOrderId);
    if (po && po.status === 'closed') {
      throw new Error('This purchase order is closed and cannot be changed — reopen it first.');
    }
  }

  ipcMain.handle('purchaseOrderItems:list', (_e, purchaseOrderId) =>
    listByPoStmt.all(purchaseOrderId).map(withBoughtQuantity)
  );
  ipcMain.handle('purchaseOrderItems:get', (_e, id) => withBoughtQuantity(getStmt.get(id)));
  ipcMain.handle('purchaseOrderItems:create', (_e, data) => {
    assertOpenPo(data.purchase_order_id);
    const info = insertStmt.run(withDefaults(data));
    return withBoughtQuantity(getStmt.get(info.lastInsertRowid));
  });
  ipcMain.handle('purchaseOrderItems:update', (_e, id, data) => {
    const current = getStmt.get(id);
    if (current) assertOpenPo(current.purchase_order_id);
    updateStmt.run({ ...withDefaults(data), id });
    return withBoughtQuantity(getStmt.get(id));
  });
  ipcMain.handle('purchaseOrderItems:delete', (_e, id) => {
    const current = getStmt.get(id);
    if (current) assertOpenPo(current.purchase_order_id);
    deleteStmt.run(id);
    return { ok: true };
  });
  ipcMain.handle('purchaseOrderItems:invoices', (_e, id) => {
    const line = getStmt.get(id);
    if (!line || !line.item_id) return [];
    return invoicesForItemStmt.all(line.item_id);
  });
};

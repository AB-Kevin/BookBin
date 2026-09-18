module.exports = function registerPurchaseOrders(ipcMain, db) {
  const listStmt = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC, id DESC');
  const getStmt = db.prepare('SELECT * FROM purchase_orders WHERE id = ?');
  const insertStmt = db.prepare("INSERT INTO purchase_orders (name, status) VALUES (@name, 'open')");
  const updateNameStmt = db.prepare('UPDATE purchase_orders SET name = @name WHERE id = @id');
  const deleteStmt = db.prepare('DELETE FROM purchase_orders WHERE id = ?');
  const setStatusStmt = db.prepare('UPDATE purchase_orders SET status = @status, closed_at = @closed_at WHERE id = @id');

  const linesForPoStmt = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?');
  const boughtQtyStmt = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS qty FROM incoming_invoice_lines WHERE item_id = ?');
  const setFrozenQtyStmt = db.prepare('UPDATE purchase_order_items SET frozen_bought_quantity = @qty WHERE id = @id');
  const clearFrozenQtyStmt = db.prepare('UPDATE purchase_order_items SET frozen_bought_quantity = NULL WHERE purchase_order_id = ?');

  function withSummary(po) {
    if (!po) return po;
    const lines = linesForPoStmt.all(po.id);
    const totalWanted = lines.reduce((sum, l) => sum + Number(l.quantity_wanted || 0), 0);
    const totalBought = lines.reduce((sum, l) => {
      const bought = po.status === 'closed'
        ? Number(l.frozen_bought_quantity || 0)
        : (l.item_id ? boughtQtyStmt.get(l.item_id).qty : 0);
      return sum + bought;
    }, 0);
    return { ...po, line_count: lines.length, total_wanted: totalWanted, total_bought: totalBought };
  }

  ipcMain.handle('purchaseOrders:list', () => listStmt.all().map(withSummary));
  ipcMain.handle('purchaseOrders:get', (_e, id) => withSummary(getStmt.get(id)));
  ipcMain.handle('purchaseOrders:create', (_e, data) => {
    const info = insertStmt.run({ name: data.name });
    return withSummary(getStmt.get(info.lastInsertRowid));
  });
  ipcMain.handle('purchaseOrders:update', (_e, id, data) => {
    updateNameStmt.run({ id, name: data.name });
    return withSummary(getStmt.get(id));
  });
  ipcMain.handle('purchaseOrders:delete', (_e, id) => {
    deleteStmt.run(id); // cascades to its lines
    return { ok: true };
  });

  // Snapshots each line's current bought quantity so the order stops
  // reacting to anything that happens afterward — new invoices, edits to old
  // ones, even the linked item being deleted — until it's reopened.
  const closeTx = db.transaction((id) => {
    const lines = linesForPoStmt.all(id);
    for (const line of lines) {
      const qty = line.item_id ? boughtQtyStmt.get(line.item_id).qty : 0;
      setFrozenQtyStmt.run({ id: line.id, qty });
    }
    setStatusStmt.run({ id, status: 'closed', closed_at: new Date().toISOString() });
  });
  ipcMain.handle('purchaseOrders:close', (_e, id) => {
    closeTx(id);
    return withSummary(getStmt.get(id));
  });

  ipcMain.handle('purchaseOrders:reopen', (_e, id) => {
    clearFrozenQtyStmt.run(id);
    setStatusStmt.run({ id, status: 'open', closed_at: null });
    return withSummary(getStmt.get(id));
  });
};

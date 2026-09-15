module.exports = function registerItems(ipcMain, db) {
  const listStmt = db.prepare('SELECT * FROM items ORDER BY name COLLATE NOCASE');
  const getStmt = db.prepare('SELECT * FROM items WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO items (sku, name, description, unit, is_inventory, quantity_on_hand, default_cost, default_price)
    VALUES (@sku, @name, @description, @unit, @is_inventory, @quantity_on_hand, @default_cost, @default_price)
  `);
  const updateStmt = db.prepare(`
    UPDATE items SET
      sku = @sku, name = @name, description = @description, unit = @unit,
      is_inventory = @is_inventory, default_cost = @default_cost, default_price = @default_price
    WHERE id = @id
  `);
  const deleteStmt = db.prepare('DELETE FROM items WHERE id = ?');
  const historyStmt = db.prepare(`
    SELECT * FROM inventory_adjustments WHERE item_id = ? ORDER BY created_at DESC, id DESC
  `);
  const adjustQtyStmt = db.prepare('UPDATE items SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?');
  const logAdjustmentStmt = db.prepare(`
    INSERT INTO inventory_adjustments (item_id, delta, reason, source_type, source_id)
    VALUES (@item_id, @delta, @reason, @source_type, @source_id)
  `);

  function withDefaults(data) {
    return {
      sku: data.sku || null,
      name: data.name,
      description: data.description || null,
      unit: data.unit || 'ea',
      is_inventory: data.is_inventory ? 1 : 0,
      quantity_on_hand: data.is_inventory ? Number(data.quantity_on_hand || 0) : 0,
      default_cost: Number(data.default_cost || 0),
      default_price: Number(data.default_price || 0),
    };
  }

  ipcMain.handle('items:list', () => listStmt.all());
  ipcMain.handle('items:get', (_e, id) => getStmt.get(id));
  ipcMain.handle('items:create', (_e, data) => {
    const info = insertStmt.run(withDefaults(data));
    return getStmt.get(info.lastInsertRowid);
  });
  ipcMain.handle('items:update', (_e, id, data) => {
    updateStmt.run({ ...withDefaults(data), id });
    return getStmt.get(id);
  });
  ipcMain.handle('items:delete', (_e, id) => {
    deleteStmt.run(id);
    return { ok: true };
  });
  ipcMain.handle('items:history', (_e, id) => historyStmt.all(id));

  // Manual stock correction (e.g. physical count reconciliation), not tied
  // to any invoice.
  ipcMain.handle('items:adjustStock', (_e, id, delta, reason) => {
    const applyAdjustment = db.transaction((itemId, qtyDelta, adjustmentReason) => {
      adjustQtyStmt.run(qtyDelta, itemId);
      logAdjustmentStmt.run({
        item_id: itemId,
        delta: qtyDelta,
        reason: adjustmentReason || 'Manual adjustment',
        source_type: 'manual',
        source_id: null,
      });
    });
    applyAdjustment(id, Number(delta), reason);
    return getStmt.get(id);
  });
};

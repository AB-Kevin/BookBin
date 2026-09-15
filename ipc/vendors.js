module.exports = function registerVendors(ipcMain, db) {
  const listStmt = db.prepare('SELECT * FROM vendors ORDER BY name COLLATE NOCASE');
  const getStmt = db.prepare('SELECT * FROM vendors WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO vendors (name, contact_name, email, phone, address, notes)
    VALUES (@name, @contact_name, @email, @phone, @address, @notes)
  `);
  const updateStmt = db.prepare(`
    UPDATE vendors SET
      name = @name, contact_name = @contact_name, email = @email,
      phone = @phone, address = @address, notes = @notes
    WHERE id = @id
  `);
  const deleteStmt = db.prepare('DELETE FROM vendors WHERE id = ?');

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

  ipcMain.handle('vendors:list', () => listStmt.all());
  ipcMain.handle('vendors:get', (_e, id) => getStmt.get(id));
  ipcMain.handle('vendors:create', (_e, data) => {
    const info = insertStmt.run(withDefaults(data));
    return getStmt.get(info.lastInsertRowid);
  });
  ipcMain.handle('vendors:update', (_e, id, data) => {
    updateStmt.run({ ...withDefaults(data), id });
    return getStmt.get(id);
  });
  ipcMain.handle('vendors:delete', (_e, id) => {
    deleteStmt.run(id);
    return { ok: true };
  });
};

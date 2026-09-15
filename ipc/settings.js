module.exports = function registerSettings(ipcMain, db) {
  const getStmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const updateStmt = db.prepare(`
    UPDATE settings SET
      company_name = @company_name,
      company_address = @company_address,
      company_logo_path = @company_logo_path,
      incoming_prefix = @incoming_prefix,
      incoming_next_number = @incoming_next_number,
      outgoing_prefix = @outgoing_prefix,
      outgoing_next_number = @outgoing_next_number,
      low_stock_threshold = @low_stock_threshold
    WHERE id = 1
  `);

  ipcMain.handle('settings:get', () => getStmt.get());
  ipcMain.handle('settings:update', (_e, data) => {
    const current = getStmt.get();
    updateStmt.run({ ...current, ...data });
    return getStmt.get();
  });
};

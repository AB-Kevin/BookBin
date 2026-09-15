module.exports = function registerDashboard(ipcMain, db) {
  const lowStockStmt = db.prepare(`
    SELECT * FROM items
    WHERE is_inventory = 1 AND quantity_on_hand <= (SELECT low_stock_threshold FROM settings WHERE id = 1)
    ORDER BY quantity_on_hand ASC
  `);
  const recentIncomingStmt = db.prepare(`
    SELECT ii.*, v.name AS vendor_name
    FROM incoming_invoices ii
    LEFT JOIN vendors v ON v.id = ii.vendor_id
    ORDER BY ii.invoice_date DESC, ii.id DESC
    LIMIT 5
  `);
  const recentOutgoingStmt = db.prepare(`
    SELECT oi.*, c.name AS customer_name
    FROM outgoing_invoices oi
    LEFT JOIN customers c ON c.id = oi.customer_id
    ORDER BY oi.invoice_date DESC, oi.id DESC
    LIMIT 5
  `);

  ipcMain.handle('dashboard:summary', () => ({
    lowStockItems: lowStockStmt.all(),
    recentIncoming: recentIncomingStmt.all(),
    recentOutgoing: recentOutgoingStmt.all(),
  }));
};

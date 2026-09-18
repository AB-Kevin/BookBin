const { dialog, shell, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { attachmentsDir } = require('../workspace');

const ATTACHMENT_FILTERS = [
  { name: 'Bills', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
];

module.exports = function registerIncomingInvoices(ipcMain, db, workspaceDir) {
  const dir = attachmentsDir(workspaceDir, 'incoming');

  function removeAttachmentFile(fileName) {
    if (!fileName || path.isAbsolute(fileName)) return;
    fs.rmSync(path.join(dir, fileName), { force: true });
  }

  // Resolves what this save's attachment_path/attachment_name should be:
  // a newly chosen file replaces (and cleans up) any old one, a remove
  // request clears it, and otherwise the existing attachment carries over.
  function resolveAttachment(current, data) {
    if (data.remove_attachment) {
      removeAttachmentFile(current?.attachment_path);
      return { attachment_path: null, attachment_name: null };
    }
    if (data.attachment_source_path) {
      const ext = path.extname(data.attachment_source_path).toLowerCase();
      const fileName = `${crypto.randomUUID()}${ext}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(data.attachment_source_path, path.join(dir, fileName));
      removeAttachmentFile(current?.attachment_path);
      return { attachment_path: fileName, attachment_name: path.basename(data.attachment_source_path) };
    }
    return {
      attachment_path: current?.attachment_path ?? null,
      attachment_name: current?.attachment_name ?? null,
    };
  }

  const listStmt = db.prepare(`
    SELECT ii.*, v.name AS vendor_name
    FROM incoming_invoices ii
    LEFT JOIN vendors v ON v.id = ii.vendor_id
    ORDER BY ii.invoice_date DESC, ii.id DESC
  `);
  const getInvoiceStmt = db.prepare(`
    SELECT ii.*, v.name AS vendor_name
    FROM incoming_invoices ii
    LEFT JOIN vendors v ON v.id = ii.vendor_id
    WHERE ii.id = ?
  `);
  const getLinesStmt = db.prepare(`
    SELECT l.*, i.name AS item_name, i.is_inventory AS item_is_inventory
    FROM incoming_invoice_lines l
    LEFT JOIN items i ON i.id = l.item_id
    WHERE l.invoice_id = ?
    ORDER BY l.id
  `);
  const insertInvoiceStmt = db.prepare(`
    INSERT INTO incoming_invoices (vendor_id, invoice_number, invoice_date, notes, total, shipping_tax, paid, received, attachment_path, attachment_name)
    VALUES (@vendor_id, @invoice_number, @invoice_date, @notes, @total, @shipping_tax, @paid, @received, @attachment_path, @attachment_name)
  `);
  const updateInvoiceStmt = db.prepare(`
    UPDATE incoming_invoices SET
      vendor_id = @vendor_id, invoice_number = @invoice_number,
      invoice_date = @invoice_date, notes = @notes, total = @total, shipping_tax = @shipping_tax,
      paid = @paid, received = @received,
      attachment_path = @attachment_path, attachment_name = @attachment_name
    WHERE id = @id
  `);
  const setFlagsStmt = db.prepare('UPDATE incoming_invoices SET paid = @paid, received = @received WHERE id = @id');
  const deleteInvoiceStmt = db.prepare('DELETE FROM incoming_invoices WHERE id = ?');
  const deleteLinesStmt = db.prepare('DELETE FROM incoming_invoice_lines WHERE invoice_id = ?');
  const insertLineStmt = db.prepare(`
    INSERT INTO incoming_invoice_lines (invoice_id, item_id, description, quantity, unit_cost, line_total)
    VALUES (@invoice_id, @item_id, @description, @quantity, @unit_cost, @line_total)
  `);
  const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ?');
  const adjustQtyStmt = db.prepare('UPDATE items SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?');
  const logAdjustmentStmt = db.prepare(`
    INSERT INTO inventory_adjustments (item_id, delta, reason, source_type, source_id)
    VALUES (@item_id, @delta, @reason, @source_type, @source_id)
  `);
  const getAdjustmentsForSourceStmt = db.prepare(`
    SELECT * FROM inventory_adjustments WHERE source_type = ? AND source_id = ?
  `);
  const getSettingsStmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const bumpIncomingNumberStmt = db.prepare(
    'UPDATE settings SET incoming_next_number = incoming_next_number + 1 WHERE id = 1'
  );

  function nextInvoiceNumber() {
    const settings = getSettingsStmt.get();
    bumpIncomingNumberStmt.run();
    return `${settings.incoming_prefix}${settings.incoming_next_number}`;
  }

  function withInvoiceDefaults(data, current) {
    return {
      vendor_id: data.vendor_id || null,
      invoice_number: data.invoice_number && data.invoice_number.trim() ? data.invoice_number.trim() : null,
      invoice_date: data.invoice_date,
      notes: data.notes || null,
      shipping_tax: Number(data.shipping_tax || 0),
      paid: data.paid ? 1 : 0,
      received: data.received ? 1 : 0,
      ...resolveAttachment(current, data),
    };
  }

  // The invoice's total reflects what was actually paid the vendor, so it
  // includes shipping/tax rather than just the sum of line items.
  function computeTotal(lines, shippingTax) {
    const linesTotal = lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_cost), 0);
    return linesTotal + Number(shippingTax || 0);
  }

  // Reverses any inventory effect a previous save of this invoice caused,
  // writing compensating (negated) log rows rather than mutating history.
  function reverseStockEffects(invoiceId) {
    const rows = getAdjustmentsForSourceStmt.all('incoming_invoice', invoiceId);
    for (const row of rows) {
      adjustQtyStmt.run(-row.delta, row.item_id);
      logAdjustmentStmt.run({
        item_id: row.item_id,
        delta: -row.delta,
        reason: `Reversed: ${row.reason}`,
        source_type: 'incoming_invoice',
        source_id: invoiceId,
      });
    }
  }

  function applyStockEffects(invoiceId, invoiceNumber, lines) {
    for (const line of lines) {
      if (!line.item_id) continue;
      const item = getItemStmt.get(line.item_id);
      if (!item || !item.is_inventory) continue;
      const delta = Number(line.quantity);
      adjustQtyStmt.run(delta, item.id);
      logAdjustmentStmt.run({
        item_id: item.id,
        delta,
        reason: `Incoming invoice ${invoiceNumber}`,
        source_type: 'incoming_invoice',
        source_id: invoiceId,
      });
    }
  }

  // attachment_path is stored as a filename inside <workspace>/attachments/incoming
  // so it stays portable across devices sharing a workspace folder.
  function withAttachmentUrl(row) {
    if (!row) return row;
    if (!row.attachment_path) return { ...row, attachment_url: null };
    const absPath = path.isAbsolute(row.attachment_path) ? row.attachment_path : path.join(dir, row.attachment_path);
    return { ...row, attachment_url: `file://${absPath.replace(/\\/g, '/')}` };
  }

  function getFullInvoice(id) {
    const invoice = withAttachmentUrl(getInvoiceStmt.get(id));
    if (!invoice) return null;
    invoice.lines = getLinesStmt.all(id);
    return invoice;
  }

  const createTx = db.transaction((data) => {
    const header = withInvoiceDefaults(data, null);
    if (!header.invoice_number) header.invoice_number = nextInvoiceNumber();
    const lines = data.lines || [];
    header.total = computeTotal(lines, header.shipping_tax);

    const info = insertInvoiceStmt.run(header);
    const invoiceId = info.lastInsertRowid;

    for (const line of lines) {
      insertLineStmt.run({
        invoice_id: invoiceId,
        item_id: line.item_id || null,
        description: line.description,
        quantity: Number(line.quantity),
        unit_cost: Number(line.unit_cost),
        line_total: Number(line.quantity) * Number(line.unit_cost),
      });
    }

    applyStockEffects(invoiceId, header.invoice_number, lines);
    return invoiceId;
  });

  const updateTx = db.transaction((id, data) => {
    reverseStockEffects(id);
    deleteLinesStmt.run(id);

    const current = getInvoiceStmt.get(id);
    const header = withInvoiceDefaults(data, current);
    if (!header.invoice_number) header.invoice_number = nextInvoiceNumber();
    const lines = data.lines || [];
    header.total = computeTotal(lines, header.shipping_tax);
    header.id = id;
    updateInvoiceStmt.run(header);

    for (const line of lines) {
      insertLineStmt.run({
        invoice_id: id,
        item_id: line.item_id || null,
        description: line.description,
        quantity: Number(line.quantity),
        unit_cost: Number(line.unit_cost),
        line_total: Number(line.quantity) * Number(line.unit_cost),
      });
    }

    applyStockEffects(id, header.invoice_number, lines);
  });

  const deleteTx = db.transaction((id) => {
    const current = getInvoiceStmt.get(id);
    removeAttachmentFile(current?.attachment_path);
    reverseStockEffects(id);
    deleteInvoiceStmt.run(id); // cascades to lines
  });

  ipcMain.handle('incomingInvoices:list', () => listStmt.all());
  ipcMain.handle('incomingInvoices:get', (_e, id) => getFullInvoice(id));
  ipcMain.handle('incomingInvoices:create', (_e, data) => {
    const id = createTx(data);
    return getFullInvoice(id);
  });
  ipcMain.handle('incomingInvoices:update', (_e, id, data) => {
    updateTx(id, data);
    return getFullInvoice(id);
  });
  ipcMain.handle('incomingInvoices:chooseAttachment', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Choose Bill Attachment',
      properties: ['openFile'],
      filters: ATTACHMENT_FILTERS,
    });
    if (canceled || !filePaths.length) return null;
    return { filePath: filePaths[0], fileName: path.basename(filePaths[0]) };
  });
  ipcMain.handle('incomingInvoices:openAttachment', (_e, id) => {
    const invoice = getInvoiceStmt.get(id);
    if (!invoice?.attachment_path) return { ok: false };
    const absPath = path.isAbsolute(invoice.attachment_path) ? invoice.attachment_path : path.join(dir, invoice.attachment_path);
    return shell.openPath(absPath).then((err) => ({ ok: !err, error: err || null }));
  });
  ipcMain.handle('incomingInvoices:delete', (_e, id) => {
    deleteTx(id);
    return { ok: true };
  });
  ipcMain.handle('incomingInvoices:setFlags', (_e, id, flags) => {
    setFlagsStmt.run({ id, paid: flags.paid ? 1 : 0, received: flags.received ? 1 : 0 });
    return getFullInvoice(id);
  });
};

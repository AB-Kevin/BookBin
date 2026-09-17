const { BrowserWindow, dialog, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildInvoiceHtml } = require('../renderer/invoice-template');
const { logoDir, attachmentsDir } = require('../workspace');

const ATTACHMENT_FILTERS = [
  { name: 'Documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
];

module.exports = function registerOutgoingInvoices(ipcMain, db, workspaceDir) {
  const dir = attachmentsDir(workspaceDir, 'outgoing');

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

  // Stores a copy of an exported PDF as the invoice's attachment directly
  // from the in-memory buffer (used right after exportPdf writes it out),
  // so "sending" a PDF invoice attaches it without a separate file picker step.
  function storeGeneratedAttachment(current, buffer) {
    removeAttachmentFile(current?.attachment_path);
    const fileName = `${crypto.randomUUID()}.pdf`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), buffer);
    return { attachment_path: fileName, attachment_name: `${current?.invoice_number || 'invoice'}.pdf` };
  }

  const listStmt = db.prepare(`
    SELECT oi.*, c.name AS customer_name
    FROM outgoing_invoices oi
    LEFT JOIN customers c ON c.id = oi.customer_id
    ORDER BY oi.invoice_date DESC, oi.id DESC
  `);
  const getInvoiceStmt = db.prepare(`
    SELECT oi.*, c.name AS customer_name, c.email AS customer_email, c.address AS customer_address
    FROM outgoing_invoices oi
    LEFT JOIN customers c ON c.id = oi.customer_id
    WHERE oi.id = ?
  `);
  const getLinesStmt = db.prepare(`
    SELECT l.*, i.name AS item_name, i.is_inventory AS item_is_inventory
    FROM outgoing_invoice_lines l
    LEFT JOIN items i ON i.id = l.item_id
    WHERE l.invoice_id = ?
    ORDER BY l.id
  `);
  const insertInvoiceStmt = db.prepare(`
    INSERT INTO outgoing_invoices (customer_id, invoice_number, invoice_date, notes, total, status, attachment_path, attachment_name)
    VALUES (@customer_id, @invoice_number, @invoice_date, @notes, @total, @status, @attachment_path, @attachment_name)
  `);
  const updateInvoiceStmt = db.prepare(`
    UPDATE outgoing_invoices SET
      customer_id = @customer_id, invoice_number = @invoice_number,
      invoice_date = @invoice_date, notes = @notes, total = @total, status = @status,
      attachment_path = @attachment_path, attachment_name = @attachment_name
    WHERE id = @id
  `);
  const setAttachmentStmt = db.prepare(
    'UPDATE outgoing_invoices SET attachment_path = @attachment_path, attachment_name = @attachment_name WHERE id = @id'
  );
  const deleteInvoiceStmt = db.prepare('DELETE FROM outgoing_invoices WHERE id = ?');
  const deleteLinesStmt = db.prepare('DELETE FROM outgoing_invoice_lines WHERE invoice_id = ?');
  const insertLineStmt = db.prepare(`
    INSERT INTO outgoing_invoice_lines (invoice_id, item_id, description, quantity, unit_price, line_total)
    VALUES (@invoice_id, @item_id, @description, @quantity, @unit_price, @line_total)
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
  const bumpOutgoingNumberStmt = db.prepare(
    'UPDATE settings SET outgoing_next_number = outgoing_next_number + 1 WHERE id = 1'
  );

  function nextInvoiceNumber() {
    const settings = getSettingsStmt.get();
    bumpOutgoingNumberStmt.run();
    return `${settings.outgoing_prefix}${settings.outgoing_next_number}`;
  }

  function withInvoiceDefaults(data, current) {
    return {
      customer_id: data.customer_id || null,
      invoice_number: data.invoice_number && data.invoice_number.trim() ? data.invoice_number.trim() : null,
      invoice_date: data.invoice_date,
      notes: data.notes || null,
      status: data.status || 'draft',
      ...resolveAttachment(current, data),
    };
  }

  function computeTotal(lines) {
    return lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_price), 0);
  }

  // Reverses any inventory effect a previous save of this invoice caused,
  // writing compensating (negated) log rows rather than mutating history.
  function reverseStockEffects(invoiceId) {
    const rows = getAdjustmentsForSourceStmt.all('outgoing_invoice', invoiceId);
    for (const row of rows) {
      adjustQtyStmt.run(-row.delta, row.item_id);
      logAdjustmentStmt.run({
        item_id: row.item_id,
        delta: -row.delta,
        reason: `Reversed: ${row.reason}`,
        source_type: 'outgoing_invoice',
        source_id: invoiceId,
      });
    }
  }

  // Outgoing invoices reduce stock (negative delta), mirroring incoming's add.
  function applyStockEffects(invoiceId, invoiceNumber, lines) {
    for (const line of lines) {
      if (!line.item_id) continue;
      const item = getItemStmt.get(line.item_id);
      if (!item || !item.is_inventory) continue;
      const delta = -Number(line.quantity);
      adjustQtyStmt.run(delta, item.id);
      logAdjustmentStmt.run({
        item_id: item.id,
        delta,
        reason: `Outgoing invoice ${invoiceNumber}`,
        source_type: 'outgoing_invoice',
        source_id: invoiceId,
      });
    }
  }

  // attachment_path is stored as a filename inside <workspace>/attachments/outgoing
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
    header.total = computeTotal(lines);

    const info = insertInvoiceStmt.run(header);
    const invoiceId = info.lastInsertRowid;

    for (const line of lines) {
      insertLineStmt.run({
        invoice_id: invoiceId,
        item_id: line.item_id || null,
        description: line.description,
        quantity: Number(line.quantity),
        unit_price: Number(line.unit_price),
        line_total: Number(line.quantity) * Number(line.unit_price),
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
    header.total = computeTotal(lines);
    header.id = id;
    updateInvoiceStmt.run(header);

    for (const line of lines) {
      insertLineStmt.run({
        invoice_id: id,
        item_id: line.item_id || null,
        description: line.description,
        quantity: Number(line.quantity),
        unit_price: Number(line.unit_price),
        line_total: Number(line.quantity) * Number(line.unit_price),
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

  ipcMain.handle('outgoingInvoices:list', () => listStmt.all());
  ipcMain.handle('outgoingInvoices:get', (_e, id) => getFullInvoice(id));
  ipcMain.handle('outgoingInvoices:create', (_e, data) => {
    const id = createTx(data);
    return getFullInvoice(id);
  });
  ipcMain.handle('outgoingInvoices:update', (_e, id, data) => {
    updateTx(id, data);
    return getFullInvoice(id);
  });
  ipcMain.handle('outgoingInvoices:delete', (_e, id) => {
    deleteTx(id);
    return { ok: true };
  });
  ipcMain.handle('outgoingInvoices:chooseAttachment', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Choose Invoice Attachment',
      properties: ['openFile'],
      filters: ATTACHMENT_FILTERS,
    });
    if (canceled || !filePaths.length) return null;
    return { filePath: filePaths[0], fileName: path.basename(filePaths[0]) };
  });
  ipcMain.handle('outgoingInvoices:openAttachment', (_e, id) => {
    const invoice = getInvoiceStmt.get(id);
    if (!invoice?.attachment_path) return { ok: false };
    const absPath = path.isAbsolute(invoice.attachment_path) ? invoice.attachment_path : path.join(dir, invoice.attachment_path);
    return shell.openPath(absPath).then((err) => ({ ok: !err, error: err || null }));
  });

  // company_logo_path is stored as a filename relative to <workspace>/logo;
  // the template needs a real absolute path to build a file:// src from.
  function resolveLogoPath(company) {
    if (!company || !company.company_logo_path) return company;
    if (path.isAbsolute(company.company_logo_path)) return company;
    return { ...company, company_logo_path: path.join(logoDir(workspaceDir), company.company_logo_path) };
  }

  ipcMain.handle('outgoingInvoices:exportPdf', async (event, id) => {
    const invoice = getFullInvoice(id);
    if (!invoice) throw new Error('Invoice not found');
    const company = resolveLogoPath(getSettingsStmt.get());
    const html = buildInvoiceHtml({ invoice, company });

    const tempPath = path.join(os.tmpdir(), `bookbin-invoice-${id}-${Date.now()}.html`);
    fs.writeFileSync(tempPath, html, 'utf8');

    const pdfWindow = new BrowserWindow({ show: false });
    try {
      await pdfWindow.loadFile(tempPath);
      const pdfBuffer = await pdfWindow.webContents.printToPDF({ printBackground: true });

      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const { canceled, filePath } = await dialog.showSaveDialog(parentWindow, {
        title: 'Save Invoice PDF',
        defaultPath: `${invoice.invoice_number || 'invoice'}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };

      fs.writeFileSync(filePath, pdfBuffer);
      // Only a "sent" invoice represents a PDF that actually went out — a
      // draft export is just a preview, so it shouldn't overwrite whatever
      // attachment (or lack of one) the invoice already has.
      if (invoice.status === 'sent') {
        setAttachmentStmt.run({ id, ...storeGeneratedAttachment(invoice, pdfBuffer) });
      }
      return { ok: true, filePath, invoice: getFullInvoice(id) };
    } finally {
      pdfWindow.destroy();
      fs.unlink(tempPath, () => {});
    }
  });
};

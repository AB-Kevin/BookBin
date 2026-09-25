// Outgoing invoices (bills to customers), and the PDF export.
//
// Ported to Supabase. The mirror of incoming invoices: header, lines, stock
// and numbering all move together through save_outgoing_invoice(), because a
// REST client cannot span statements in a transaction. Selling reduces stock
// rather than adding to it, and the total carries no shipping.
//
// Attachments and the company logo stay on local disk for now, as they do for
// incoming invoices.

const { BrowserWindow, dialog, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildInvoiceHtml } = require('../renderer/invoice-template');
const { logoDir, attachmentsDir } = require('../workspace');
const { getSupabase } = require('../db/supabase');
const { table, unwrap, numericColumns } = require('../db/rest');

const ATTACHMENT_FILTERS = [
  { name: 'Documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
];

const INVOICE_COLUMNS =
  'id, customer_id, invoice_number, invoice_date, notes, total, status, ' +
  'attachment_path, attachment_name, created_at';

const LINE_COLUMNS = 'id, invoice_id, item_id, description, quantity, unit_price, line_total';

const coerceInvoice = numericColumns('total');
const coerceLine = numericColumns('quantity', 'unit_price', 'line_total');

module.exports = function registerOutgoingInvoices(ipcMain, workspaceDir) {
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
      removeAttachmentFile(current && current.attachment_path);
      return { attachment_path: null, attachment_name: null };
    }
    if (data.attachment_source_path) {
      const ext = path.extname(data.attachment_source_path).toLowerCase();
      const fileName = `${crypto.randomUUID()}${ext}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(data.attachment_source_path, path.join(dir, fileName));
      removeAttachmentFile(current && current.attachment_path);
      return {
        attachment_path: fileName,
        attachment_name: path.basename(data.attachment_source_path),
      };
    }
    return {
      attachment_path: (current && current.attachment_path) || null,
      attachment_name: (current && current.attachment_name) || null,
    };
  }

  // Stores a copy of an exported PDF as the invoice's attachment directly
  // from the in-memory buffer (used right after exportPdf writes it out),
  // so "sending" a PDF invoice attaches it without a separate file picker step.
  function storeGeneratedAttachment(current, buffer) {
    removeAttachmentFile(current && current.attachment_path);
    const fileName = `${crypto.randomUUID()}.pdf`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), buffer);
    return {
      attachment_path: fileName,
      attachment_name: `${(current && current.invoice_number) || 'invoice'}.pdf`,
    };
  }

  function withAttachmentUrl(row) {
    if (!row) return row;
    if (!row.attachment_path) return { ...row, attachment_url: null };
    const absPath = path.isAbsolute(row.attachment_path)
      ? row.attachment_path
      : path.join(dir, row.attachment_path);
    return { ...row, attachment_url: `file://${absPath.replace(/\\/g, '/')}` };
  }

  async function getFullInvoice(id) {
    const row = unwrap(
      await table('outgoing_invoices')
        .select(`${INVOICE_COLUMNS}, customers(name, email, address), outgoing_invoice_lines(${LINE_COLUMNS}, items(name, is_inventory))`)
        .eq('id', id)
        .maybeSingle()
    );
    if (!row) return null;

    const rawLines = row.outgoing_invoice_lines || [];
    const customer = row.customers || {};
    const invoice = coerceInvoice(row);
    delete invoice.customers;
    delete invoice.outgoing_invoice_lines;

    // Flattened to the exact column names the screen and the PDF template read.
    invoice.customer_name = customer.name || null;
    invoice.customer_email = customer.email || null;
    invoice.customer_address = customer.address || null;

    invoice.lines = rawLines
      .map((line) => {
        const flat = coerceLine(line);
        delete flat.items;
        return {
          ...flat,
          item_name: (line.items && line.items.name) || null,
          item_is_inventory: line.items ? line.items.is_inventory : null,
        };
      })
      .sort((a, b) => a.id - b.id);

    return withAttachmentUrl(invoice);
  }

  function buildHeader(data, current) {
    return {
      customer_id: data.customer_id || null,
      invoice_number:
        data.invoice_number && data.invoice_number.trim() ? data.invoice_number.trim() : null,
      invoice_date: data.invoice_date,
      notes: data.notes || null,
      status: data.status || 'draft',
      ...resolveAttachment(current, data),
    };
  }

  function buildLines(data) {
    return (data.lines || []).map((line) => ({
      item_id: line.item_id || null,
      description: line.description,
      quantity: Number(line.quantity),
      unit_price: Number(line.unit_price),
    }));
  }

  async function save(id, data) {
    const current = id
      ? unwrap(
          await table('outgoing_invoices')
            .select('attachment_path, attachment_name')
            .eq('id', id)
            .maybeSingle()
        )
      : null;

    const { data: savedId, error } = await getSupabase().rpc('save_outgoing_invoice', {
      p_id: id || null,
      p_header: buildHeader(data, current),
      p_lines: buildLines(data),
    });
    return getFullInvoice(unwrap({ data: savedId, error }));
  }

  ipcMain.handle('outgoingInvoices:list', async () => {
    const rows = unwrap(
      await table('outgoing_invoices')
        .select(`${INVOICE_COLUMNS}, customers(name)`)
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
    );
    return rows.map((row) => {
      const flat = coerceInvoice(row);
      delete flat.customers;
      return { ...flat, customer_name: (row.customers && row.customers.name) || null };
    });
  });

  ipcMain.handle('outgoingInvoices:get', (_e, id) => getFullInvoice(id));
  ipcMain.handle('outgoingInvoices:create', (_e, data) => save(null, data));
  ipcMain.handle('outgoingInvoices:update', (_e, id, data) => save(id, data));

  ipcMain.handle('outgoingInvoices:delete', async (_e, id) => {
    // Read the filename before the row goes, or the file is orphaned on disk.
    const current = unwrap(
      await table('outgoing_invoices').select('attachment_path').eq('id', id).maybeSingle()
    );
    const { error } = await getSupabase().rpc('delete_outgoing_invoice', { p_id: id });
    unwrap({ data: null, error });
    removeAttachmentFile(current && current.attachment_path);
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

  ipcMain.handle('outgoingInvoices:openAttachment', async (_e, id) => {
    const invoice = unwrap(
      await table('outgoing_invoices').select('attachment_path').eq('id', id).maybeSingle()
    );
    if (!invoice || !invoice.attachment_path) return { ok: false };
    const absPath = path.isAbsolute(invoice.attachment_path)
      ? invoice.attachment_path
      : path.join(dir, invoice.attachment_path);
    const err = await shell.openPath(absPath);
    return { ok: !err, error: err || null };
  });

  // company_logo_path is stored as a filename relative to <workspace>/logo;
  // the template needs a real absolute path to build a file:// src from.
  function resolveLogoPath(company) {
    if (!company || !company.company_logo_path) return company;
    if (path.isAbsolute(company.company_logo_path)) return company;
    return {
      ...company,
      company_logo_path: path.join(logoDir(workspaceDir), company.company_logo_path),
    };
  }

  ipcMain.handle('outgoingInvoices:exportPdf', async (event, id) => {
    const invoice = await getFullInvoice(id);
    if (!invoice) throw new Error('Invoice not found');

    const settings = unwrap(await table('settings').select('*').eq('id', 1).single());
    const company = resolveLogoPath(settings);
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
        unwrap(
          await table('outgoing_invoices')
            .update(storeGeneratedAttachment(invoice, pdfBuffer))
            .eq('id', id)
        );
      }
      return { ok: true, filePath, invoice: await getFullInvoice(id) };
    } finally {
      pdfWindow.destroy();
      fs.unlink(tempPath, () => {});
    }
  });
};

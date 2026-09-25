// Incoming invoices (bills from vendors).
//
// Ported to Supabase. Everything that has to happen together -- header, lines,
// stock reversal, stock application, invoice numbering -- is one call to
// save_incoming_invoice(), because a REST client cannot span statements in a
// transaction. See the migration for what that function does and why.
//
// Attachments stay on local disk for now. The path stored in the row is a
// filename inside the workspace folder, which means an attachment added on one
// machine is not visible on another: moving these to Supabase Storage is a
// later step, and nothing here assumes they will stay local forever.

const { dialog, shell, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { attachmentsDir } = require('../workspace');
const { getSupabase } = require('../db/supabase');
const { table, unwrap, numericColumns } = require('../db/rest');

const ATTACHMENT_FILTERS = [
  { name: 'Bills', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
];

const INVOICE_COLUMNS =
  'id, vendor_id, invoice_number, invoice_date, notes, total, shipping_tax, ' +
  'paid, received, attachment_path, attachment_name, created_at';

const LINE_COLUMNS = 'id, invoice_id, item_id, description, quantity, unit_cost, line_total';

const coerceInvoice = numericColumns('total', 'shipping_tax');
const coerceLine = numericColumns('quantity', 'unit_cost', 'line_total');

module.exports = function registerIncomingInvoices(ipcMain, workspaceDir) {
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

  function withAttachmentUrl(row) {
    if (!row) return row;
    if (!row.attachment_path) return { ...row, attachment_url: null };
    const absPath = path.isAbsolute(row.attachment_path)
      ? row.attachment_path
      : path.join(dir, row.attachment_path);
    return { ...row, attachment_url: `file://${absPath.replace(/\\/g, '/')}` };
  }

  // The SQLite list flattened the vendor join and rolled the line descriptions
  // into one GROUP_CONCAT string. PostgREST returns them nested instead, so
  // they are flattened back to the exact shape the table screen reads.
  function flattenListRow(row) {
    const lines = row.incoming_invoice_lines || [];
    const names = lines.map((line) => (line.items && line.items.name) || line.description);
    const flat = coerceInvoice(row);
    delete flat.vendors;
    delete flat.incoming_invoice_lines;
    return {
      ...flat,
      vendor_name: (row.vendors && row.vendors.name) || null,
      line_items: names.length ? names.join('||') : null,
    };
  }

  async function getFullInvoice(id) {
    const row = unwrap(
      await table('incoming_invoices')
        .select(`${INVOICE_COLUMNS}, vendors(name), incoming_invoice_lines(${LINE_COLUMNS}, items(name, is_inventory))`)
        .eq('id', id)
        .maybeSingle()
    );
    if (!row) return null;

    const rawLines = row.incoming_invoice_lines || [];
    const invoice = coerceInvoice(row);
    delete invoice.vendors;
    delete invoice.incoming_invoice_lines;

    invoice.vendor_name = (row.vendors && row.vendors.name) || null;
    // Ordered here rather than in the query: PostgREST orders embedded rows
    // awkwardly, and a line list is never long enough for it to matter.
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

  // Everything the save function needs, with the attachment already resolved
  // on this side because that part touches the filesystem, not the database.
  function buildHeader(data, current) {
    return {
      vendor_id: data.vendor_id || null,
      invoice_number:
        data.invoice_number && data.invoice_number.trim() ? data.invoice_number.trim() : null,
      invoice_date: data.invoice_date,
      notes: data.notes || null,
      shipping_tax: Number(data.shipping_tax || 0),
      paid: !!data.paid,
      received: !!data.received,
      ...resolveAttachment(current, data),
    };
  }

  function buildLines(data) {
    return (data.lines || []).map((line) => ({
      item_id: line.item_id || null,
      description: line.description,
      quantity: Number(line.quantity),
      unit_cost: Number(line.unit_cost),
    }));
  }

  async function save(id, data) {
    // The current row is needed only to know which attachment file to replace
    // or clean up; the database function does not need it.
    const current = id
      ? unwrap(
          await table('incoming_invoices')
            .select('attachment_path, attachment_name')
            .eq('id', id)
            .maybeSingle()
        )
      : null;

    const { data: savedId, error } = await getSupabase().rpc('save_incoming_invoice', {
      p_id: id || null,
      p_header: buildHeader(data, current),
      p_lines: buildLines(data),
    });
    return getFullInvoice(unwrap({ data: savedId, error }));
  }

  ipcMain.handle('incomingInvoices:list', async () => {
    const rows = unwrap(
      await table('incoming_invoices')
        .select(`${INVOICE_COLUMNS}, vendors(name), incoming_invoice_lines(description, items(name))`)
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
    );
    return rows.map(flattenListRow);
  });

  ipcMain.handle('incomingInvoices:get', (_e, id) => getFullInvoice(id));
  ipcMain.handle('incomingInvoices:create', (_e, data) => save(null, data));
  ipcMain.handle('incomingInvoices:update', (_e, id, data) => save(id, data));

  ipcMain.handle('incomingInvoices:delete', async (_e, id) => {
    // Read the filename before the row goes, or the file is orphaned on disk.
    const current = unwrap(
      await table('incoming_invoices').select('attachment_path').eq('id', id).maybeSingle()
    );
    const { error } = await getSupabase().rpc('delete_incoming_invoice', { p_id: id });
    unwrap({ data: null, error });
    removeAttachmentFile(current && current.attachment_path);
    return { ok: true };
  });

  ipcMain.handle('incomingInvoices:setFlags', async (_e, id, flags) => {
    unwrap(
      await table('incoming_invoices')
        .update({ paid: !!flags.paid, received: !!flags.received })
        .eq('id', id)
    );
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

  ipcMain.handle('incomingInvoices:openAttachment', async (_e, id) => {
    const invoice = unwrap(
      await table('incoming_invoices').select('attachment_path').eq('id', id).maybeSingle()
    );
    if (!invoice || !invoice.attachment_path) return { ok: false };
    const absPath = path.isAbsolute(invoice.attachment_path)
      ? invoice.attachment_path
      : path.join(dir, invoice.attachment_path);
    const err = await shell.openPath(absPath);
    return { ok: !err, error: err || null };
  });
};

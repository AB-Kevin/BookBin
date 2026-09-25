// Incoming invoices (bills from vendors).
//
// Ported to Supabase. Everything that has to happen together -- header, lines,
// stock reversal, stock application, invoice numbering -- is one call to
// save_incoming_invoice(), because a REST client cannot span statements in a
// transaction. See the migration for what that function does and why.
//
// Attachments live in Supabase Storage, handled by ipc/attachments.js.

const { dialog, BrowserWindow } = require('electron');
const path = require('path');
const createAttachments = require('./attachments');
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
  const attachments = createAttachments('incoming', workspaceDir);

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

    return invoice;
  }

  // Everything the save function needs, with the attachment already resolved
  // on this side because that part touches the filesystem, not the database.
  async function buildHeader(data, current) {
    return {
      vendor_id: data.vendor_id || null,
      invoice_number:
        data.invoice_number && data.invoice_number.trim() ? data.invoice_number.trim() : null,
      invoice_date: data.invoice_date,
      notes: data.notes || null,
      shipping_tax: Number(data.shipping_tax || 0),
      paid: !!data.paid,
      received: !!data.received,
      ...(await attachments.resolve(current, data)),
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
      p_header: await buildHeader(data, current),
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
    await attachments.remove(current && current.attachment_path);
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
    return attachments.open(invoice && invoice.attachment_path);
  });
};

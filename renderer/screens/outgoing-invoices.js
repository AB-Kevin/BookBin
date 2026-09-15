window.Screens = window.Screens || {};

(function () {

window.Screens.outgoingInvoices = async function renderOutgoingInvoices(container, param) {
  if (param === 'new') return renderForm(container, null);
  if (param) return renderForm(container, Number(param));
  return renderList(container);
};

async function renderList(container) {
  const { escapeHtml, formatMoney, formatDate, confirmAction, qs, qsa, sortedRows, sortableHeader, wireSortableHeaders, createSortState } = window.Helpers;

  let invoices = [];
  const sortState = createSortState('invoice_date', 'desc');

  async function load() {
    invoices = await window.api.outgoingInvoices.list();
    render();
  }

  function render() {
    const rows = sortedRows(invoices, sortState);
    container.innerHTML = `
      <div class="page-header">
        <h1>Outgoing Invoices</h1>
        <button class="btn primary" id="new-invoice">+ New Invoice</button>
      </div>
      <section class="card">
        ${invoices.length === 0
          ? '<p class="muted">No outgoing invoices yet.</p>'
          : `<table>
              <thead><tr>
                ${sortableHeader('#', 'invoice_number', sortState)}
                ${sortableHeader('Customer', 'customer_name', sortState)}
                ${sortableHeader('Date', 'invoice_date', sortState)}
                ${sortableHeader('Status', 'status', sortState)}
                ${sortableHeader('Total', 'total', sortState, 'num')}
                <th></th>
              </tr></thead>
              <tbody>
                ${rows
                  .map((inv) => `
                    <tr>
                      <td>${escapeHtml(inv.invoice_number)}</td>
                      <td>${escapeHtml(inv.customer_name || '—')}</td>
                      <td>${formatDate(inv.invoice_date)}</td>
                      <td><span class="badge status-${escapeHtml(inv.status)}">${escapeHtml(inv.status)}</span></td>
                      <td class="num">${formatMoney(inv.total)}</td>
                      <td class="actions">
                        <button class="btn small" data-edit="${inv.id}">Edit</button>
                        <button class="btn small" data-pdf="${inv.id}">PDF</button>
                        <button class="btn small danger" data-delete="${inv.id}">Delete</button>
                      </td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>
    `;

    qs('#new-invoice', container).addEventListener('click', () => window.Helpers.navigate('/outgoing-invoices/new'));
    qsa('[data-edit]', container).forEach((btn) =>
      btn.addEventListener('click', () => window.Helpers.navigate(`/outgoing-invoices/${btn.dataset.edit}`))
    );
    qsa('[data-pdf]', container).forEach((btn) =>
      btn.addEventListener('click', () => exportPdf(Number(btn.dataset.pdf)))
    );
    qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!(await confirmAction('Delete this invoice? Stock removed by it will be restored.'))) return;
        await window.api.outgoingInvoices.delete(Number(btn.dataset.delete));
        load();
      })
    );
    wireSortableHeaders(container, sortState, render);
  }

  await load();
}

async function exportPdf(id) {
  const result = await window.api.outgoingInvoices.exportPdf(id);
  if (result.canceled) return;
  if (result.ok) window.alert(`Saved PDF to:\n${result.filePath}`);
  else window.alert('Could not export PDF.');
}

async function renderForm(container, invoiceId) {
  const { escapeHtml, formatMoney, todayIso, qs, qsa } = window.Helpers;
  const isEdit = Boolean(invoiceId);

  const [customers, items, invoice] = await Promise.all([
    window.api.customers.list(),
    window.api.items.list(),
    isEdit ? window.api.outgoingInvoices.get(invoiceId) : Promise.resolve(null),
  ]);

  const customerOptions = (selectedId) => `<option value="__new__" class="new-entry">+ New Customer…</option>` + customers
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');

  const itemOptions = (selectedId) => `<option value="">(custom line)</option><option value="__new__" class="new-entry">+ New Item…</option>` + items
    .map((i) => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`)
    .join('');

  const STATUSES = ['draft', 'sent', 'paid'];

  function lineRowHtml(line) {
    const item = line?.item_id ? items.find((i) => i.id === line.item_id) : null;
    return `
      <tr class="line-row">
        <td><select class="line-item">${itemOptions(line?.item_id || null)}</select></td>
        <td><input class="line-desc" value="${escapeHtml(line?.description ?? item?.name ?? '')}" required /></td>
        <td><input class="line-qty" type="number" step="any" min="0" value="${line?.quantity ?? 1}" /></td>
        <td><input class="line-price" type="number" step="0.0001" min="0" value="${line?.unit_price ?? item?.default_price ?? 0}" /></td>
        <td class="num line-total">${formatMoney((line?.quantity ?? 1) * (line?.unit_price ?? item?.default_price ?? 0))}</td>
        <td><button type="button" class="btn small danger remove-row">&times;</button></td>
      </tr>
    `;
  }

  container.innerHTML = `
    <h1>${isEdit ? `Edit Invoice ${escapeHtml(invoice.invoice_number)}` : 'New Outgoing Invoice'}</h1>
    <form id="invoice-form" class="card">
      <div class="form-row">
        <label>Customer
          <select name="customer_id" required>
            <option value="">Select customer…</option>
            ${customerOptions(invoice?.customer_id || null)}
          </select>
        </label>
        <label>Invoice #
          <input name="invoice_number" placeholder="auto" value="${escapeHtml(invoice?.invoice_number || '')}" />
        </label>
        <label>Date
          <input name="invoice_date" type="date" required value="${invoice?.invoice_date || todayIso()}" />
        </label>
        <label>Status
          <select name="status">
            ${STATUSES.map((s) => `<option value="${s}" ${invoice?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
      </div>

      <table id="lines-table">
        <thead>
          <tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit Price</th><th class="num">Total</th><th></th></tr>
        </thead>
        <tbody>
          ${(invoice?.lines?.length ? invoice.lines : [null]).map(lineRowHtml).join('')}
        </tbody>
      </table>
      <button type="button" class="btn" id="add-line">+ Add Line</button>

      <div class="totals">
        <strong>Total: <span id="grand-total">${formatMoney(invoice?.total || 0)}</span></strong>
      </div>

      <label>Notes<textarea name="notes">${escapeHtml(invoice?.notes || '')}</textarea></label>

      <div class="modal-actions">
        <button type="button" class="btn" id="cancel-btn">Cancel</button>
        ${isEdit ? '<button type="button" class="btn" id="pdf-btn">Export PDF</button>' : ''}
        <button type="submit" class="btn primary">Save Invoice</button>
      </div>
    </form>
  `;

  const tbody = qs('#lines-table tbody', container);

  const customerSelect = qs('select[name="customer_id"]', container);
  let lastCustomerValue = customerSelect.value;
  customerSelect.addEventListener('change', () => {
    if (customerSelect.value === '__new__') {
      customerSelect.value = lastCustomerValue;
      openNewCustomerModal();
      return;
    }
    lastCustomerValue = customerSelect.value;
  });

  function openNewCustomerModal() {
    const { showModal, hideModal } = window.Helpers;
    const modal = showModal(`
      <h2>New Customer</h2>
      <form id="quick-customer-form">
        <label>Name<input name="name" required /></label>
        <label>Contact Name<input name="contact_name" /></label>
        <label>Email<input name="email" type="email" /></label>
        <label>Phone<input name="phone" /></label>
        <label>Address<textarea name="address"></textarea></label>
        <label>Notes<textarea name="notes"></textarea></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    `);
    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#quick-customer-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const customer = await window.api.customers.create(Object.fromEntries(form.entries()));
      customers.push(customer);
      customers.sort((a, b) => a.name.localeCompare(b.name));
      customerSelect.innerHTML = `<option value="">Select customer…</option>${customerOptions(customer.id)}`;
      lastCustomerValue = customerSelect.value;
      hideModal();
    });
  }

  function refreshItemSelects(targetRow, newItemId) {
    qsa('.line-item', tbody).forEach((select) => {
      const isTarget = select === qs('.line-item', targetRow);
      const selectedId = isTarget ? newItemId : (Number(select.value) || null);
      select.innerHTML = itemOptions(selectedId);
      if (isTarget) select.dataset.prevValue = String(newItemId);
    });
  }

  function openNewItemModal(row) {
    const { showModal, hideModal } = window.Helpers;
    const modal = showModal(`
      <h2>New Item</h2>
      <form id="quick-item-form">
        <label>Name<input name="name" required /></label>
        <label>SKU<input name="sku" /></label>
        <label>Unit<input name="unit" value="ea" /></label>
        <label class="checkbox"><input type="checkbox" name="is_inventory" checked /> Track as inventory</label>
        <label>Default Cost<input name="default_cost" type="number" step="0.0001" value="0" /></label>
        <label>Default Price<input name="default_price" type="number" step="0.0001" value="0" /></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    `);
    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#quick-item-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const item = await window.api.items.create({
        name: form.get('name'),
        sku: form.get('sku'),
        unit: form.get('unit') || 'ea',
        is_inventory: form.get('is_inventory') === 'on',
        quantity_on_hand: 0,
        default_cost: Number(form.get('default_cost') || 0),
        default_price: Number(form.get('default_price') || 0),
      });
      items.push(item);
      items.sort((a, b) => a.name.localeCompare(b.name));
      refreshItemSelects(row, item.id);
      qs('.line-desc', row).value = item.name;
      qs('.line-price', row).value = item.default_price;
      recalcRow(row);
      recalcGrandTotal();
      hideModal();
    });
  }

  function recalcRow(row) {
    const qty = Number(qs('.line-qty', row).value || 0);
    const price = Number(qs('.line-price', row).value || 0);
    qs('.line-total', row).textContent = formatMoney(qty * price);
  }

  function recalcGrandTotal() {
    const total = qsa('.line-row', tbody).reduce((sum, row) => {
      const qty = Number(qs('.line-qty', row).value || 0);
      const price = Number(qs('.line-price', row).value || 0);
      return sum + qty * price;
    }, 0);
    qs('#grand-total', container).textContent = formatMoney(total);
  }

  function wireRow(row) {
    const itemSelect = qs('.line-item', row);
    itemSelect.dataset.prevValue = itemSelect.value;
    itemSelect.addEventListener('change', (e) => {
      if (e.target.value === '__new__') {
        e.target.value = e.target.dataset.prevValue || '';
        openNewItemModal(row);
        return;
      }
      e.target.dataset.prevValue = e.target.value;
      const item = items.find((i) => i.id === Number(e.target.value));
      if (item) {
        qs('.line-desc', row).value = item.name;
        qs('.line-price', row).value = item.default_price;
      }
      recalcRow(row);
      recalcGrandTotal();
    });
    qs('.line-qty', row).addEventListener('input', () => { recalcRow(row); recalcGrandTotal(); });
    qs('.line-price', row).addEventListener('input', () => { recalcRow(row); recalcGrandTotal(); });
    qs('.remove-row', row).addEventListener('click', () => {
      if (qsa('.line-row', tbody).length === 1) return; // keep at least one row
      row.remove();
      recalcGrandTotal();
    });
  }

  qsa('.line-row', tbody).forEach(wireRow);

  qs('#add-line', container).addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', lineRowHtml(null));
    wireRow(tbody.lastElementChild);
  });

  qs('#cancel-btn', container).addEventListener('click', () => window.Helpers.navigate('/outgoing-invoices'));
  if (isEdit) qs('#pdf-btn', container).addEventListener('click', () => exportPdf(invoiceId));

  qs('#invoice-form', container).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const lines = qsa('.line-row', tbody).map((row) => ({
      item_id: qs('.line-item', row).value ? Number(qs('.line-item', row).value) : null,
      description: qs('.line-desc', row).value,
      quantity: Number(qs('.line-qty', row).value || 0),
      unit_price: Number(qs('.line-price', row).value || 0),
    }));

    const payload = {
      customer_id: Number(form.get('customer_id')),
      invoice_number: form.get('invoice_number'),
      invoice_date: form.get('invoice_date'),
      status: form.get('status'),
      notes: form.get('notes'),
      lines,
    };

    if (isEdit) await window.api.outgoingInvoices.update(invoiceId, payload);
    else await window.api.outgoingInvoices.create(payload);
    window.Helpers.navigate('/outgoing-invoices');
  });
}

})();

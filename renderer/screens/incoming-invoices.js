window.Screens = window.Screens || {};

(function () {

window.Screens.incomingInvoices = async function renderIncomingInvoices(container, param) {
  if (param === 'new') return renderForm(container, null);
  if (param) return renderForm(container, Number(param));
  return renderList(container);
};

async function renderList(container) {
  const { escapeHtml, formatMoney, formatDate, confirmAction, qs, qsa, sortedRows, sortableHeader, wireSortableHeaders, createSortState } = window.Helpers;

  let invoices = [];
  const sortState = createSortState('invoice_date', 'desc');

  async function load() {
    invoices = await window.api.incomingInvoices.list();
    render();
  }

  function render() {
    const rows = sortedRows(invoices, sortState);
    container.innerHTML = `
      <div class="page-header">
        <h1>Incoming Invoices</h1>
        <button class="btn primary" id="new-invoice">+ New Invoice</button>
      </div>
      <section class="card">
        ${invoices.length === 0
          ? '<p class="muted">No incoming invoices yet.</p>'
          : `<table>
              <thead><tr>
                ${sortableHeader('#', 'invoice_number', sortState)}
                ${sortableHeader('Vendor', 'vendor_name', sortState)}
                ${sortableHeader('Date', 'invoice_date', sortState)}
                ${sortableHeader('Total', 'total', sortState, 'num')}
                ${sortableHeader('Received', 'received', sortState, 'checkbox-col')}
                ${sortableHeader('Paid', 'paid', sortState, 'checkbox-col')}
                <th></th>
              </tr></thead>
              <tbody>
                ${rows
                  .map((inv) => `
                    <tr>
                      <td>${escapeHtml(inv.invoice_number)}</td>
                      <td>${escapeHtml(inv.vendor_name || '—')}</td>
                      <td>${formatDate(inv.invoice_date)}</td>
                      <td class="num">${formatMoney(inv.total)}</td>
                      <td class="checkbox-col"><input type="checkbox" data-flag="received" data-id="${inv.id}" ${inv.received ? 'checked' : ''} /></td>
                      <td class="checkbox-col"><input type="checkbox" data-flag="paid" data-id="${inv.id}" ${inv.paid ? 'checked' : ''} /></td>
                      <td class="actions">
                        <button class="btn small" data-edit="${inv.id}">Edit</button>
                        <button class="btn small danger" data-delete="${inv.id}">Delete</button>
                      </td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>
    `;

    qs('#new-invoice', container).addEventListener('click', () => window.Helpers.navigate('/incoming-invoices/new'));
    qsa('[data-edit]', container).forEach((btn) =>
      btn.addEventListener('click', () => window.Helpers.navigate(`/incoming-invoices/${btn.dataset.edit}`))
    );
    qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!(await confirmAction('Delete this invoice? Stock added by it will be reversed.'))) return;
        await window.api.incomingInvoices.delete(Number(btn.dataset.delete));
        load();
      })
    );
    qsa('[data-flag]', container).forEach((checkbox) =>
      checkbox.addEventListener('change', async () => {
        const id = Number(checkbox.dataset.id);
        const row = checkbox.closest('tr');
        const paid = row.querySelector('[data-flag="paid"]').checked;
        const received = row.querySelector('[data-flag="received"]').checked;
        checkbox.disabled = true;
        try {
          await window.api.incomingInvoices.setFlags(id, { paid, received });
          const inv = invoices.find((i) => i.id === id);
          if (inv) { inv.paid = paid; inv.received = received; }
        } finally {
          checkbox.disabled = false;
        }
      })
    );
    wireSortableHeaders(container, sortState, render);
  }

  await load();
}

async function renderForm(container, invoiceId) {
  const { escapeHtml, formatMoney, todayIso, qs, qsa } = window.Helpers;
  const isEdit = Boolean(invoiceId);

  const [vendors, items, invoice] = await Promise.all([
    window.api.vendors.list(),
    window.api.items.list(),
    isEdit ? window.api.incomingInvoices.get(invoiceId) : Promise.resolve(null),
  ]);

  const vendorOptions = (selectedId) => `<option value="__new__" class="new-entry">+ New Vendor…</option>` + vendors
    .map((v) => `<option value="${v.id}" ${v.id === selectedId ? 'selected' : ''}>${escapeHtml(v.name)}</option>`)
    .join('');

  const itemOptions = (selectedId) => `<option value="">(custom line)</option><option value="__new__" class="new-entry">+ New Item…</option>` + items
    .map((i) => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`)
    .join('');

  function lineRowHtml(line) {
    const item = line?.item_id ? items.find((i) => i.id === line.item_id) : null;
    return `
      <tr class="line-row">
        <td><select class="line-item">${itemOptions(line?.item_id || null)}</select></td>
        <td><input class="line-desc" value="${escapeHtml(line?.description ?? item?.name ?? '')}" required /></td>
        <td><input class="line-qty" type="number" step="any" min="0" value="${line?.quantity ?? 1}" /></td>
        <td><input class="line-cost" type="number" step="0.0001" min="0" value="${line?.unit_cost ?? item?.default_cost ?? 0}" /></td>
        <td class="num line-total">${formatMoney((line?.quantity ?? 1) * (line?.unit_cost ?? item?.default_cost ?? 0))}</td>
        <td><button type="button" class="btn small danger remove-row">&times;</button></td>
      </tr>
    `;
  }

  container.innerHTML = `
    <h1>${isEdit ? `Edit Invoice ${escapeHtml(invoice.invoice_number)}` : 'New Incoming Invoice'}</h1>
    <form id="invoice-form" class="card">
      <div class="form-row">
        <label>Vendor
          <select name="vendor_id" required>
            <option value="">Select vendor…</option>
            ${vendorOptions(invoice?.vendor_id || null)}
          </select>
        </label>
        <label>Invoice #
          <input name="invoice_number" placeholder="auto" value="${escapeHtml(invoice?.invoice_number || '')}" />
        </label>
        <label>Date
          <input name="invoice_date" type="date" required value="${invoice?.invoice_date || todayIso()}" />
        </label>
      </div>

      <div class="form-row">
        <label class="checkbox"><input type="checkbox" name="received" ${invoice?.received ? 'checked' : ''} /> Received</label>
        <label class="checkbox"><input type="checkbox" name="paid" ${invoice?.paid ? 'checked' : ''} /> Paid</label>
      </div>

      <table id="lines-table">
        <thead>
          <tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit Cost</th><th class="num">Total</th><th></th></tr>
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
        <button type="submit" class="btn primary">Save Invoice</button>
      </div>
    </form>
  `;

  const tbody = qs('#lines-table tbody', container);

  const vendorSelect = qs('select[name="vendor_id"]', container);
  let lastVendorValue = vendorSelect.value;
  vendorSelect.addEventListener('change', () => {
    if (vendorSelect.value === '__new__') {
      vendorSelect.value = lastVendorValue;
      openNewVendorModal();
      return;
    }
    lastVendorValue = vendorSelect.value;
  });

  function openNewVendorModal() {
    const { showModal, hideModal } = window.Helpers;
    const modal = showModal(`
      <h2>New Vendor</h2>
      <form id="quick-vendor-form">
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
    qs('#quick-vendor-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const vendor = await window.api.vendors.create(Object.fromEntries(form.entries()));
      vendors.push(vendor);
      vendors.sort((a, b) => a.name.localeCompare(b.name));
      vendorSelect.innerHTML = `<option value="">Select vendor…</option>${vendorOptions(vendor.id)}`;
      lastVendorValue = vendorSelect.value;
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
      qs('.line-cost', row).value = item.default_cost;
      recalcRow(row);
      recalcGrandTotal();
      hideModal();
    });
  }

  function recalcRow(row) {
    const qty = Number(qs('.line-qty', row).value || 0);
    const cost = Number(qs('.line-cost', row).value || 0);
    qs('.line-total', row).textContent = formatMoney(qty * cost);
  }

  function recalcGrandTotal() {
    const total = qsa('.line-row', tbody).reduce((sum, row) => {
      const qty = Number(qs('.line-qty', row).value || 0);
      const cost = Number(qs('.line-cost', row).value || 0);
      return sum + qty * cost;
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
        qs('.line-cost', row).value = item.default_cost;
      }
      recalcRow(row);
      recalcGrandTotal();
    });
    qs('.line-qty', row).addEventListener('input', () => { recalcRow(row); recalcGrandTotal(); });
    qs('.line-cost', row).addEventListener('input', () => { recalcRow(row); recalcGrandTotal(); });
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

  qs('#cancel-btn', container).addEventListener('click', () => window.Helpers.navigate('/incoming-invoices'));

  qs('#invoice-form', container).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const lines = qsa('.line-row', tbody).map((row) => ({
      item_id: qs('.line-item', row).value ? Number(qs('.line-item', row).value) : null,
      description: qs('.line-desc', row).value,
      quantity: Number(qs('.line-qty', row).value || 0),
      unit_cost: Number(qs('.line-cost', row).value || 0),
    }));

    const payload = {
      vendor_id: Number(form.get('vendor_id')),
      invoice_number: form.get('invoice_number'),
      invoice_date: form.get('invoice_date'),
      notes: form.get('notes'),
      received: form.get('received') === 'on',
      paid: form.get('paid') === 'on',
      lines,
    };

    if (isEdit) await window.api.incomingInvoices.update(invoiceId, payload);
    else await window.api.incomingInvoices.create(payload);
    window.Helpers.navigate('/incoming-invoices');
  });
}

})();

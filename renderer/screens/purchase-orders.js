window.Screens = window.Screens || {};

(function () {

window.Screens.purchaseOrders = async function renderPurchaseOrders(container, param, rest) {
  const segments = rest || [];
  if (segments.length === 0) return renderOrdersList(container);

  const poId = Number(segments[0]);
  if (segments[1] === 'lines') {
    if (segments[2] === 'new') return renderLineForm(container, poId, null);
    if (segments[2]) return renderLineForm(container, poId, Number(segments[2]));
  }
  return renderLinesList(container, poId);
};

async function renderOrdersList(container) {
  const { escapeHtml, confirmAction, qs, qsa, sortedRows, sortableHeader, wireSortableHeaders, createSortState, showModal, hideModal } = window.Helpers;

  let orders = [];
  const sortState = createSortState('created_at', 'desc');

  async function load() {
    orders = await window.api.purchaseOrders.list();
    render();
  }

  function render() {
    const rows = sortedRows(orders, sortState);
    container.innerHTML = `
      <div class="page-header">
        <h1>Purchase Orders</h1>
        <button class="btn primary" id="new-order">+ New Purchase Order</button>
      </div>
      <section class="card">
        ${orders.length === 0
          ? '<p class="muted">No purchase orders yet.</p>'
          : `<table>
              <thead>
                <tr>
                  ${sortableHeader('Name', 'name', sortState)}
                  ${sortableHeader('Status', 'status', sortState)}
                  ${sortableHeader('Lines', 'line_count', sortState, 'num')}
                  ${sortableHeader('Wanted', 'total_wanted', sortState, 'num')}
                  ${sortableHeader('Bought', 'total_bought', sortState, 'num')}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map((po) => `
                    <tr>
                      <td>${escapeHtml(po.name)}</td>
                      <td><span class="badge status-${po.status}">${escapeHtml(po.status)}</span></td>
                      <td class="num">${po.line_count}</td>
                      <td class="num">${po.total_wanted}</td>
                      <td class="num">${po.total_bought}</td>
                      <td class="actions"><div class="actions-row">
                        <button class="btn small" data-edit="${po.id}">Edit</button>
                        ${po.status === 'open'
                          ? `<button class="btn small" data-complete="${po.id}">Complete</button>`
                          : `<button class="btn small" data-reopen="${po.id}">Reopen</button>`}
                        <button class="btn small danger" data-delete="${po.id}">Delete</button>
                      </div></td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>
    `;

    qs('#new-order', container).addEventListener('click', openNewOrderModal);
    qsa('[data-edit]', container).forEach((btn) =>
      btn.addEventListener('click', () => window.Helpers.navigate(`/purchase-orders/${btn.dataset.edit}`))
    );
    qsa('[data-complete]', container).forEach((btn) =>
      btn.addEventListener('click', async () => {
        await window.api.purchaseOrders.close(Number(btn.dataset.complete));
        load();
      })
    );
    qsa('[data-reopen]', container).forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!(await confirmAction(
          "Reopening will unfreeze this purchase order — its bought counts will start reflecting current purchases again, and its lines can be edited. Continue?"
        ))) return;
        await window.api.purchaseOrders.reopen(Number(btn.dataset.reopen));
        load();
      })
    );
    qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!(await confirmAction('Delete this purchase order and all of its lines? This cannot be undone.'))) return;
        await window.api.purchaseOrders.delete(Number(btn.dataset.delete));
        load();
      })
    );
    wireSortableHeaders(container, sortState, render);
  }

  function openNewOrderModal() {
    const modal = showModal(`
      <h2>New Purchase Order</h2>
      <form id="new-order-form">
        <label>Name<input name="name" required placeholder="e.g. 2027 Purchase Order" /></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Create</button>
        </div>
      </form>
    `);
    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#new-order-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const po = await window.api.purchaseOrders.create({ name: form.get('name') });
      hideModal();
      window.Helpers.navigate(`/purchase-orders/${po.id}`);
    });
  }

  await load();
}

async function renderLinesList(container, poId) {
  const { escapeHtml, formatMoney, formatDate, confirmAction, qs, qsa, sortedRows, sortableHeader, wireSortableHeaders, createSortState } = window.Helpers;

  let po = null;
  let lines = [];
  const sortState = createSortState('created_at', 'desc');
  const expandedIds = new Set();
  const invoicesCache = new Map();

  async function load() {
    [po, lines] = await Promise.all([
      window.api.purchaseOrders.get(poId),
      window.api.purchaseOrderItems.list(poId),
    ]);
    render();
  }

  function progressStatus(wanted, bought) {
    if (bought <= 0) return 'none';
    if (wanted > 0 && bought >= wanted) return 'full';
    return 'partial';
  }

  function invoicesRowHtml(id) {
    const cached = invoicesCache.get(id);
    if (!cached) return '<p class="muted small">Loading…</p>';
    if (cached.length === 0) return '<p class="muted small">This item hasn\'t appeared on any incoming invoice yet.</p>';
    return `
      <table class="nested-table">
        <thead><tr><th>Invoice</th><th>Vendor</th><th>Date</th><th class="num">Qty</th><th class="num">Unit Cost</th></tr></thead>
        <tbody>
          ${cached
            .map((inv) => `
              <tr>
                <td>${escapeHtml(inv.invoice_number)}</td>
                <td>${escapeHtml(inv.vendor_name || '—')}</td>
                <td>${formatDate(inv.invoice_date)}</td>
                <td class="num">${inv.quantity}</td>
                <td class="num">${formatMoney(inv.unit_cost)}</td>
              </tr>
            `)
            .join('')}
        </tbody>
      </table>
    `;
  }

  function render() {
    const isClosed = po.status === 'closed';
    const rows = sortedRows(lines, sortState);
    container.innerHTML = `
      <div class="page-header">
        <div>
          <a href="#" id="back-link" class="back-link">← Purchase Orders</a>
          <h1>${escapeHtml(po.name)} <span class="badge status-${po.status}">${escapeHtml(po.status)}</span></h1>
        </div>
        <div class="header-actions">
          ${isClosed
            ? '<button class="btn" id="reopen-btn">Reopen</button>'
            : '<button class="btn" id="complete-btn">Complete</button><button class="btn primary" id="new-line">+ New Line</button>'}
        </div>
      </div>
      ${isClosed ? '<p class="muted small">This purchase order is closed — its bought counts are frozen and its lines can\'t be changed until it\'s reopened.</p>' : ''}
      <section class="card">
        ${lines.length === 0
          ? '<p class="muted">No lines yet.</p>'
          : `<table class="po-table">
              <thead>
                <tr>
                  <th></th>
                  ${sortableHeader('Name', 'name', sortState)}
                  ${sortableHeader('Edition', 'edition', sortState)}
                  ${sortableHeader('ISBN', 'isbn', sortState)}
                  ${sortableHeader('Max Price (CL)', 'max_price', sortState, 'num')}
                  ${sortableHeader('Bought', 'bought_quantity', sortState, 'num')}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map((line) => {
                    const wanted = Number(line.quantity_wanted || 0);
                    const bought = Number(line.bought_quantity || 0);
                    const status = progressStatus(wanted, bought);
                    const expanded = expandedIds.has(line.id);
                    const hasNotes = Boolean(line.notes);
                    const mainIsLast = !hasNotes && !expanded;
                    const notesIsLast = hasNotes && !expanded;
                    return `
                      <tr class="po-row po-row-${status} ${mainIsLast ? 'po-group-end' : ''}">
                        <td class="po-expand-cell">
                          <button type="button" class="expand-toggle" data-toggle="${line.id}" aria-label="Show invoices" title="Show invoices">${expanded ? '▾' : '▸'}</button>
                        </td>
                        <td>${escapeHtml(line.name)}</td>
                        <td>${escapeHtml(line.edition || '')}</td>
                        <td>${escapeHtml(line.isbn || '')}</td>
                        <td class="num">${formatMoney(line.max_price)}</td>
                        <td class="num"><span class="progress-badge">${bought}/${wanted}</span></td>
                        <td class="actions"><div class="actions-row">
                          ${!isClosed ? `
                            <button class="btn small" data-edit="${line.id}">Edit</button>
                            <button class="btn small danger" data-delete="${line.id}">Delete</button>
                          ` : ''}
                        </div></td>
                      </tr>
                      ${hasNotes ? `
                        <tr class="po-notes-row po-row-${status} ${notesIsLast ? 'po-group-end' : ''}">
                          <td></td>
                          <td colspan="6" class="po-notes-cell">${escapeHtml(line.notes)}</td>
                        </tr>
                      ` : ''}
                      ${expanded ? `
                        <tr class="po-invoices-row po-group-end">
                          <td></td>
                          <td colspan="6">${invoicesRowHtml(line.id)}</td>
                        </tr>
                      ` : ''}
                    `;
                  })
                  .join('')}
              </tbody>
            </table>`}
      </section>
    `;

    qs('#back-link', container).addEventListener('click', (e) => {
      e.preventDefault();
      window.Helpers.navigate('/purchase-orders');
    });

    if (!isClosed) {
      qs('#new-line', container).addEventListener('click', () => window.Helpers.navigate(`/purchase-orders/${poId}/lines/new`));
      qs('#complete-btn', container).addEventListener('click', async () => {
        await window.api.purchaseOrders.close(poId);
        load();
      });
      qsa('[data-edit]', container).forEach((btn) =>
        btn.addEventListener('click', () => window.Helpers.navigate(`/purchase-orders/${poId}/lines/${btn.dataset.edit}`))
      );
      qsa('[data-delete]', container).forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (!(await confirmAction('Delete this purchase order item?'))) return;
          await window.api.purchaseOrderItems.delete(Number(btn.dataset.delete));
          load();
        })
      );
    } else {
      qs('#reopen-btn', container).addEventListener('click', async () => {
        if (!(await confirmAction(
          "Reopening will unfreeze this purchase order — its bought counts will start reflecting current purchases again, and its lines can be edited. Continue?"
        ))) return;
        await window.api.purchaseOrders.reopen(poId);
        load();
      });
    }

    qsa('[data-toggle]', container).forEach((btn) =>
      btn.addEventListener('click', () => toggleInvoices(Number(btn.dataset.toggle)))
    );
    wireSortableHeaders(container, sortState, render);
  }

  async function toggleInvoices(id) {
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
      render();
      return;
    }
    expandedIds.add(id);
    render();
    if (!invoicesCache.has(id)) {
      const invoices = await window.api.purchaseOrderItems.invoices(id);
      invoicesCache.set(id, invoices);
      if (expandedIds.has(id)) render();
    }
  }

  await load();
}

async function renderLineForm(container, poId, lineId) {
  const { escapeHtml, qs, qsa } = window.Helpers;
  const isEdit = Boolean(lineId);

  const [po, items, line] = await Promise.all([
    window.api.purchaseOrders.get(poId),
    window.api.items.list(),
    isEdit ? window.api.purchaseOrderItems.get(lineId) : Promise.resolve(null),
  ]);

  // Closed orders don't accept new/edited lines — bounce back defensively in
  // case this was reached via a stale link rather than the (already-hidden)
  // buttons that normally guard this.
  if (!po || po.status === 'closed') {
    window.Helpers.navigate(`/purchase-orders/${poId}`);
    return;
  }

  const itemOptions = (selectedId) => `<option value="">Select item…</option><option value="__new__" class="new-entry">+ New Item…</option>` + items
    .map((i) => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`)
    .join('');

  container.innerHTML = `
    <a href="#" id="back-link" class="back-link">← ${escapeHtml(po.name)}</a>
    <h1>${isEdit ? 'Edit Purchase Order Item' : 'New Purchase Order Item'}</h1>
    <form id="po-form" class="card">
      <label>Book/Item
        <select name="item_id" required>${itemOptions(line?.item_id || null)}</select>
      </label>
      <label>Name<input name="name" required value="${escapeHtml(line?.name || '')}" /></label>
      <div class="form-row">
        <label>Edition<input name="edition" value="${escapeHtml(line?.edition || '')}" /></label>
        <label>ISBN<input name="isbn" value="${escapeHtml(line?.isbn || '')}" /></label>
      </div>
      <div class="form-row">
        <label>Quantity Wanted<input name="quantity_wanted" type="number" step="any" min="0" value="${line?.quantity_wanted ?? 1}" /></label>
        <label>Max Price (CL)<input name="max_price" type="number" step="0.01" min="0" value="${line?.max_price ?? 0}" /></label>
      </div>
      <label>Notes<textarea name="notes">${escapeHtml(line?.notes || '')}</textarea></label>
      <div class="modal-actions">
        <button type="button" class="btn" id="cancel-btn">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>
  `;

  qs('#back-link', container).addEventListener('click', (e) => {
    e.preventDefault();
    window.Helpers.navigate(`/purchase-orders/${poId}`);
  });

  const itemSelect = qs('select[name="item_id"]', container);
  const nameField = qs('input[name="name"]', container);
  let lastItemValue = itemSelect.value;
  itemSelect.addEventListener('change', () => {
    if (itemSelect.value === '__new__') {
      itemSelect.value = lastItemValue;
      openNewItemModal();
      return;
    }
    lastItemValue = itemSelect.value;
    const item = items.find((i) => i.id === Number(itemSelect.value));
    if (item && !nameField.value) nameField.value = item.name;
  });

  function openNewItemModal() {
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
      itemSelect.innerHTML = itemOptions(item.id);
      lastItemValue = itemSelect.value;
      if (!nameField.value) nameField.value = item.name;
      hideModal();
    });
  }

  qs('#cancel-btn', container).addEventListener('click', () => window.Helpers.navigate(`/purchase-orders/${poId}`));

  qs('#po-form', container).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = {
      purchase_order_id: poId,
      item_id: form.get('item_id') ? Number(form.get('item_id')) : null,
      name: form.get('name'),
      edition: form.get('edition'),
      isbn: form.get('isbn'),
      quantity_wanted: Number(form.get('quantity_wanted') || 0),
      max_price: Number(form.get('max_price') || 0),
      notes: form.get('notes'),
    };
    if (isEdit) await window.api.purchaseOrderItems.update(lineId, payload);
    else await window.api.purchaseOrderItems.create(payload);
    window.Helpers.navigate(`/purchase-orders/${poId}`);
  });
}

})();

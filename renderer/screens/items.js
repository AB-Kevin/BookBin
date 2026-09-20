window.Screens = window.Screens || {};

window.Screens.items = async function renderItems(container) {
  const { escapeHtml, formatMoney, formatDate, showModal, hideModal, confirmAction, qs, qsa, sortedRows, sortableHeader, wireSortableHeaders, createSortState } = window.Helpers;

  let items = [];
  let searchTerm = '';
  const sortState = createSortState('name');

  async function load() {
    items = await window.api.items.list();
    render();
  }

  function render() {
    const term = searchTerm.trim().toLowerCase();
    const filteredItems = term
      ? items.filter((item) =>
          [item.name, item.sku, item.description].some((field) =>
            String(field || '').toLowerCase().includes(term)
          )
        )
      : items;
    const rows = sortedRows(filteredItems, sortState);
    const totalOnHand = items
      .filter((item) => item.is_inventory)
      .reduce((sum, item) => sum + Number(item.quantity_on_hand || 0), 0);
    container.innerHTML = `
      <div class="page-header">
        <h1>Items</h1>
        <div class="header-actions">
          <input type="search" id="item-search" class="search-input" placeholder="Search items…" value="${escapeHtml(searchTerm)}" />
          <button class="btn" id="recalc-all">Recalculate All Costs</button>
          <button class="btn primary" id="new-item">+ New Item</button>
        </div>
      </div>
      <section class="card stats-row">
        <div class="stat">
          <div class="stat-label">Total Items In Stock</div>
          <div class="stat-value">${totalOnHand}</div>
        </div>
      </section>
      <section class="card">
        ${items.length === 0
          ? '<p class="muted">No items yet.</p>'
          : rows.length === 0
          ? '<p class="muted">No items match your search.</p>'
          : `<table>
              <thead>
                <tr>
                  ${sortableHeader('Name', 'name', sortState)}
                  ${sortableHeader('SKU', 'sku', sortState)}
                  ${sortableHeader('Type', 'is_inventory', sortState)}
                  ${sortableHeader('On Hand', 'quantity_on_hand', sortState, 'num')}
                  ${sortableHeader('Cost', 'default_cost', sortState, 'num')}
                  ${sortableHeader('Price', 'default_price', sortState, 'num')}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map((item) => `
                    <tr>
                      <td>${escapeHtml(item.name)}</td>
                      <td>${escapeHtml(item.sku || '')}</td>
                      <td>${item.is_inventory ? 'Inventory' : 'Non-inventory'}</td>
                      <td class="num ${item.is_inventory && item.quantity_on_hand <= 0 ? 'warn' : ''}">
                        ${item.is_inventory ? item.quantity_on_hand : '—'}
                      </td>
                      <td class="num">${formatMoney(item.default_cost)}</td>
                      <td class="num">${formatMoney(item.default_price)}</td>
                      <td class="actions"><div class="actions-row">
                        ${item.is_inventory ? `<button class="btn small" data-adjust="${item.id}">Adjust</button>` : ''}
                        ${item.is_inventory ? `<button class="btn small" data-history="${item.id}">History</button>` : ''}
                        <button class="btn small" data-cost="${item.id}">Cost</button>
                        <button class="btn small" data-edit="${item.id}">Edit</button>
                        <button class="btn small danger" data-delete="${item.id}">Delete</button>
                      </div></td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>
    `;

    const searchInput = qs('#item-search', container);
    searchInput.addEventListener('input', (e) => {
      searchTerm = e.target.value;
      const cursorPos = e.target.selectionStart;
      render();
      const newSearchInput = qs('#item-search', container);
      newSearchInput.focus();
      newSearchInput.setSelectionRange(cursorPos, cursorPos);
    });

    qs('#new-item', container).addEventListener('click', () => openForm(null));
    window.Helpers.qsa('[data-edit]', container).forEach((btn) =>
      btn.addEventListener('click', () => openForm(items.find((i) => i.id === Number(btn.dataset.edit))))
    );
    window.Helpers.qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', () => onDelete(Number(btn.dataset.delete)))
    );
    window.Helpers.qsa('[data-adjust]', container).forEach((btn) =>
      btn.addEventListener('click', () => openAdjustForm(Number(btn.dataset.adjust)))
    );
    window.Helpers.qsa('[data-history]', container).forEach((btn) =>
      btn.addEventListener('click', () => openHistory(Number(btn.dataset.history)))
    );
    window.Helpers.qsa('[data-cost]', container).forEach((btn) =>
      btn.addEventListener('click', () => openCostModal(Number(btn.dataset.cost)))
    );
    qs('#recalc-all', container).addEventListener('click', onRecalculateAll);
    wireSortableHeaders(container, sortState, render);
  }

  function openForm(item) {
    const isEdit = Boolean(item);
    const modal = showModal(`
      <h2>${isEdit ? 'Edit Item' : 'New Item'}</h2>
      <form id="item-form">
        <label>Name<input name="name" required value="${escapeHtml(item?.name || '')}" /></label>
        <label>SKU<input name="sku" value="${escapeHtml(item?.sku || '')}" /></label>
        <label>Description<textarea name="description">${escapeHtml(item?.description || '')}</textarea></label>
        <label>Unit<input name="unit" value="${escapeHtml(item?.unit || 'ea')}" /></label>
        <label class="checkbox">
          <input type="checkbox" name="is_inventory" ${!item || item.is_inventory ? 'checked' : ''} />
          Track as inventory
        </label>
        <label class="qty-field" style="${!item ? '' : 'display:none'}">
          Starting quantity on hand
          <input name="quantity_on_hand" type="number" step="any" value="${item ? item.quantity_on_hand : 0}" />
        </label>
        ${isEdit ? '<p class="muted small">Quantity on hand changes via invoices or the Adjust button, not here.</p>' : ''}
        <label>Default Cost<input name="default_cost" type="number" step="0.0001" value="${item?.default_cost ?? 0}" /></label>
        <label>Default Price<input name="default_price" type="number" step="0.0001" value="${item?.default_price ?? 0}" /></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    `);

    const invCheckbox = qs('[name="is_inventory"]', modal);
    const qtyField = qs('.qty-field', modal);
    if (isEdit) qtyField.style.display = 'none';
    else invCheckbox.addEventListener('change', () => {
      qtyField.style.display = invCheckbox.checked ? '' : 'none';
    });

    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#item-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const payload = {
        name: form.get('name'),
        sku: form.get('sku'),
        description: form.get('description'),
        unit: form.get('unit'),
        is_inventory: form.get('is_inventory') === 'on',
        quantity_on_hand: Number(form.get('quantity_on_hand') || 0),
        default_cost: Number(form.get('default_cost') || 0),
        default_price: Number(form.get('default_price') || 0),
      };
      if (isEdit) await window.api.items.update(item.id, payload);
      else await window.api.items.create(payload);
      hideModal();
      load();
    });
  }

  function openAdjustForm(itemId) {
    const modal = showModal(`
      <h2>Adjust Stock</h2>
      <form id="adjust-form">
        <label>Quantity change (use a negative number to remove stock)<input name="delta" type="number" step="any" required /></label>
        <label>Reason<input name="reason" placeholder="e.g. physical count correction" /></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Apply</button>
        </div>
      </form>
    `);
    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#adjust-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      await window.api.items.adjustStock(itemId, Number(form.get('delta')), form.get('reason'));
      hideModal();
      load();
    });
  }

  async function openHistory(itemId) {
    const history = await window.api.items.history(itemId);
    showModal(`
      <h2>Stock History</h2>
      ${history.length === 0
        ? '<p class="muted">No adjustments recorded.</p>'
        : `<table>
            <thead><tr><th>Date</th><th class="num">Change</th><th>Reason</th></tr></thead>
            <tbody>
              ${history
                .map((h) => `
                  <tr>
                    <td>${escapeHtml(h.created_at)}</td>
                    <td class="num">${h.delta > 0 ? '+' : ''}${h.delta}</td>
                    <td>${escapeHtml(h.reason)}</td>
                  </tr>
                `)
                .join('')}
            </tbody>
          </table>`}
      <div class="modal-actions">
        <button type="button" class="btn" id="close-btn">Close</button>
      </div>
    `);
    qs('#close-btn').addEventListener('click', hideModal);
  }

  // Renders the full audit trail for one cost snapshot: every incoming-invoice
  // line that fed into it, its share of that invoice's shipping/tax, and the
  // resulting per-unit cost, plus the weighted-average math that combined them.
  function renderBreakdown(breakdown) {
    const rows = breakdown.contributions
      .map((c) => `
        <tr>
          <td>${escapeHtml(c.invoice_number)}</td>
          <td>${escapeHtml(c.vendor_name || '—')}</td>
          <td>${formatDate(c.invoice_date)}</td>
          <td class="num">${c.quantity}</td>
          <td class="num">${formatMoney(c.unit_cost)}</td>
          <td class="num">${formatMoney(c.raw_total)}</td>
          <td class="num">${formatMoney(c.shipping_tax_share)}</td>
          <td class="num">${formatMoney(c.unit_cost_effective)}</td>
        </tr>
      `)
      .join('');
    const avgCost = breakdown.totalQuantity > 0 ? breakdown.totalCostWithShipping / breakdown.totalQuantity : 0;
    return `
      <table class="cost-breakdown">
        <thead>
          <tr>
            <th>Invoice</th><th>Vendor</th><th>Date</th><th class="num">Qty</th>
            <th class="num">Unit Cost</th><th class="num">Raw Total</th>
            <th class="num">Ship/Tax Share</th><th class="num">Effective Unit Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted small">
        Weighted avg cost = ${formatMoney(breakdown.totalCostWithShipping)} total ÷ ${breakdown.totalQuantity} units = ${formatMoney(avgCost)}
      </p>
    `;
  }

  async function openCostModal(itemId) {
    const item = items.find((i) => i.id === itemId);
    const history = await window.api.costing.history(itemId);
    renderCostModal(item, history);
  }

  function renderCostModal(item, history) {
    const modal = showModal(`
      <h2>Cost &amp; Pricing — ${escapeHtml(item.name)}</h2>
      <p>Current cost: <strong>${formatMoney(item.default_cost)}</strong> &nbsp; Current price: <strong>${formatMoney(item.default_price)}</strong></p>
      <div class="modal-actions" style="justify-content: flex-start;">
        <button type="button" class="btn primary" id="recalc-btn">Recalculate Now</button>
      </div>
      ${history.length === 0
        ? '<p class="muted">No cost history yet — this item has never been on an incoming invoice, or hasn\'t been recalculated.</p>'
        : history
            .map((snap, i) => `
              <details class="cost-snapshot" ${i === 0 ? 'open' : ''}>
                <summary>${escapeHtml(snap.created_at)} — Cost ${formatMoney(snap.cost)}, Price ${formatMoney(snap.price)} (markup ${snap.markup_percent}%)</summary>
                ${renderBreakdown(snap.breakdown)}
              </details>
            `)
            .join('')}
      <div class="modal-actions">
        <button type="button" class="btn" id="close-btn">Close</button>
      </div>
    `, 'wide');
    qs('#close-btn', modal).addEventListener('click', hideModal);
    qs('#recalc-btn', modal).addEventListener('click', async () => {
      const result = await window.api.costing.recalculateItem(item.id);
      if (!result.ok) {
        window.alert("This item has no incoming-invoice purchase history to calculate a cost from.");
        return;
      }
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx !== -1) items[idx] = result.item;
      const newHistory = await window.api.costing.history(item.id);
      renderCostModal(result.item, newHistory);
      render(); // refresh the underlying list's Cost/Price columns too
    });
  }

  async function onRecalculateAll() {
    const results = await window.api.costing.recalculateAll();
    const recalculated = results.filter((r) => r.ok).length;
    window.alert(`Recalculated cost/price for ${recalculated} of ${results.length} item(s) with purchase history.`);
    load();
  }

  async function onDelete(id) {
    if (!(await confirmAction('Delete this item? This cannot be undone.'))) return;
    await window.api.items.delete(id);
    load();
  }

  await load();
};

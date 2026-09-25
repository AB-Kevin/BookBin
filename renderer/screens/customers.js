window.Screens = window.Screens || {};

window.Screens.customers = async function renderCustomers(container) {
  const { escapeHtml, showModal, hideModal, confirmAction, qs, qsa, sortedRows, sortableHeader, wireSortableHeaders, createSortState } = window.Helpers;

  let customers = [];
  const sortState = createSortState('name');

  async function load() {
    customers = await window.api.customers.list();
    render();
  }

  function render() {
    const rows = sortedRows(customers, sortState);
    container.innerHTML = `
      <div class="page-header">
        ${window.Helpers.pageTitle('Customers', 'Records')}
        <button class="btn primary" id="new-customer">${window.Helpers.icon('add')}New customer</button>
      </div>
      <section class="card">
        ${customers.length === 0
          ? '<p class="muted">No customers yet.</p>'
          : `<table>
              <thead><tr>
                ${sortableHeader('Name', 'name', sortState)}
                ${sortableHeader('Contact', 'contact_name', sortState)}
                ${sortableHeader('Email', 'email', sortState)}
                ${sortableHeader('Phone', 'phone', sortState)}
                <th></th>
              </tr></thead>
              <tbody>
                ${rows
                  .map((c) => `
                    <tr>
                      <td>${escapeHtml(c.name)}</td>
                      <td>${escapeHtml(c.contact_name || '')}</td>
                      <td>${escapeHtml(c.email || '')}</td>
                      <td>${escapeHtml(c.phone || '')}</td>
                      <td class="actions"><div class="actions-row">
                        ${window.Helpers.iconButton('edit', 'Edit', `data-edit="${c.id}"`)}
                        ${window.Helpers.iconButton('delete', 'Delete', `data-delete="${c.id}"`, 'danger')}
                      </div></td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>
    `;

    qs('#new-customer', container).addEventListener('click', () => openForm(null));
    qsa('[data-edit]', container).forEach((btn) =>
      btn.addEventListener('click', () => openForm(customers.find((c) => c.id === Number(btn.dataset.edit))))
    );
    qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', () => onDelete(Number(btn.dataset.delete)))
    );
    wireSortableHeaders(container, sortState, render);
  }

  function openForm(customer) {
    const isEdit = Boolean(customer);
    const modal = showModal(`
      <h2>${isEdit ? 'Edit Customer' : 'New Customer'}</h2>
      <form id="customer-form">
        <label>Name<input name="name" required value="${escapeHtml(customer?.name || '')}" /></label>
        <label>Contact Name<input name="contact_name" value="${escapeHtml(customer?.contact_name || '')}" /></label>
        <label>Email<input name="email" type="email" value="${escapeHtml(customer?.email || '')}" /></label>
        <label>Phone<input name="phone" value="${escapeHtml(customer?.phone || '')}" /></label>
        <label>Address<textarea name="address">${escapeHtml(customer?.address || '')}</textarea></label>
        <label>Notes<textarea name="notes">${escapeHtml(customer?.notes || '')}</textarea></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    `);

    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#customer-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const payload = Object.fromEntries(form.entries());
      if (isEdit) await window.api.customers.update(customer.id, payload);
      else await window.api.customers.create(payload);
      hideModal();
      load();
    });
  }

  async function onDelete(id) {
    if (!(await confirmAction('Delete this customer? This cannot be undone.'))) return;
    await window.api.customers.delete(id);
    load();
  }

  await load();
};

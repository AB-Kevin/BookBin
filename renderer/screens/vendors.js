window.Screens = window.Screens || {};

window.Screens.vendors = async function renderVendors(container) {
  const { escapeHtml, showModal, hideModal, confirmAction, qs, qsa, sortedRows, sortableHeader, wireSortableHeaders, createSortState } = window.Helpers;

  let vendors = [];
  const sortState = createSortState('name');

  async function load() {
    vendors = await window.api.vendors.list();
    render();
  }

  function render() {
    const rows = sortedRows(vendors, sortState);
    container.innerHTML = `
      <div class="page-header">
        ${window.Helpers.pageTitle('Vendors', 'Records')}
        <button class="btn primary" id="new-vendor">${window.Helpers.icon('add')}New vendor</button>
      </div>
      <section class="card">
        ${vendors.length === 0
          ? '<p class="muted">No vendors yet.</p>'
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
                  .map((v) => `
                    <tr>
                      <td>${escapeHtml(v.name)}</td>
                      <td>${escapeHtml(v.contact_name || '')}</td>
                      <td>${escapeHtml(v.email || '')}</td>
                      <td>${escapeHtml(v.phone || '')}</td>
                      <td class="actions"><div class="actions-row">
                        ${window.Helpers.iconButton('edit', 'Edit', `data-edit="${v.id}"`)}
                        ${window.Helpers.iconButton('delete', 'Delete', `data-delete="${v.id}"`, 'danger')}
                      </div></td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>
    `;

    qs('#new-vendor', container).addEventListener('click', () => openForm(null));
    qsa('[data-edit]', container).forEach((btn) =>
      btn.addEventListener('click', () => openForm(vendors.find((v) => v.id === Number(btn.dataset.edit))))
    );
    qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', () => onDelete(Number(btn.dataset.delete)))
    );
    wireSortableHeaders(container, sortState, render);
  }

  function openForm(vendor) {
    const isEdit = Boolean(vendor);
    const modal = showModal(`
      <h2>${isEdit ? 'Edit Vendor' : 'New Vendor'}</h2>
      <form id="vendor-form">
        <label>Name<input name="name" required value="${escapeHtml(vendor?.name || '')}" /></label>
        <label>Contact Name<input name="contact_name" value="${escapeHtml(vendor?.contact_name || '')}" /></label>
        <label>Email<input name="email" type="email" value="${escapeHtml(vendor?.email || '')}" /></label>
        <label>Phone<input name="phone" value="${escapeHtml(vendor?.phone || '')}" /></label>
        <label>Address<textarea name="address">${escapeHtml(vendor?.address || '')}</textarea></label>
        <label>Notes<textarea name="notes">${escapeHtml(vendor?.notes || '')}</textarea></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    `);

    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#vendor-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const payload = Object.fromEntries(form.entries());
      if (isEdit) await window.api.vendors.update(vendor.id, payload);
      else await window.api.vendors.create(payload);
      hideModal();
      load();
    });
  }

  async function onDelete(id) {
    if (!(await confirmAction('Delete this vendor? This cannot be undone.'))) return;
    await window.api.vendors.delete(id);
    load();
  }

  await load();
};

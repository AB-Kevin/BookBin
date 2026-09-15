window.Screens = window.Screens || {};

window.Screens.settings = async function renderSettings(container) {
  const { escapeHtml, qs } = window.Helpers;
  const settings = await window.api.settings.get();

  container.innerHTML = `
    <h1>Settings</h1>
    <form id="settings-form" class="card">
      <h2>Company Profile</h2>
      <label>Company Name<input name="company_name" value="${escapeHtml(settings.company_name || '')}" /></label>
      <label>Address<textarea name="company_address">${escapeHtml(settings.company_address || '')}</textarea></label>
      <label>Logo file path (optional)<input name="company_logo_path" value="${escapeHtml(settings.company_logo_path || '')}" placeholder="C:\\path\\to\\logo.png" /></label>

      <h2>Invoice Numbering</h2>
      <div class="form-row">
        <label>Incoming Prefix<input name="incoming_prefix" value="${escapeHtml(settings.incoming_prefix || '')}" /></label>
        <label>Incoming Next Number<input name="incoming_next_number" type="number" min="1" value="${settings.incoming_next_number}" /></label>
      </div>
      <div class="form-row">
        <label>Outgoing Prefix<input name="outgoing_prefix" value="${escapeHtml(settings.outgoing_prefix || '')}" /></label>
        <label>Outgoing Next Number<input name="outgoing_next_number" type="number" min="1" value="${settings.outgoing_next_number}" /></label>
      </div>

      <h2>Inventory</h2>
      <label>Low stock warning threshold<input name="low_stock_threshold" type="number" step="any" value="${settings.low_stock_threshold}" /></label>

      <div class="modal-actions">
        <button type="submit" class="btn primary">Save Settings</button>
      </div>
      <p id="save-confirmation" class="muted" hidden>Saved.</p>
    </form>
  `;

  qs('#settings-form', container).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = {
      company_name: form.get('company_name'),
      company_address: form.get('company_address'),
      company_logo_path: form.get('company_logo_path') || null,
      incoming_prefix: form.get('incoming_prefix'),
      incoming_next_number: Number(form.get('incoming_next_number')),
      outgoing_prefix: form.get('outgoing_prefix'),
      outgoing_next_number: Number(form.get('outgoing_next_number')),
      low_stock_threshold: Number(form.get('low_stock_threshold')),
    };
    await window.api.settings.update(payload);
    const confirmation = qs('#save-confirmation', container);
    confirmation.hidden = false;
    setTimeout(() => { confirmation.hidden = true; }, 2000);
  });
};

window.Screens = window.Screens || {};

window.Screens.settings = async function renderSettings(container) {
  const { escapeHtml, qs, confirmAction } = window.Helpers;

  let settings;

  async function load() {
    settings = await window.api.settings.get();
    render();
  }

  function render() {
    container.innerHTML = `
      <h1>Settings</h1>
      <form id="settings-form" class="card">
        <h2>Company Profile</h2>
        <label>Company Name<input name="company_name" value="${escapeHtml(settings.company_name || '')}" /></label>
        <label>Address<textarea name="company_address">${escapeHtml(settings.company_address || '')}</textarea></label>

        <label>Logo</label>
        <div class="logo-picker">
          ${settings.company_logo_url
            ? `<img class="logo-preview" src="${escapeHtml(settings.company_logo_url)}" alt="Company logo" />`
            : `<div class="logo-preview logo-preview-empty">No logo</div>`}
          <div class="logo-picker-actions">
            <button type="button" class="btn small" id="choose-logo-btn">Choose Logo…</button>
            ${settings.company_logo_path
              ? '<button type="button" class="btn small danger" id="remove-logo-btn">Remove</button>'
              : ''}
          </div>
        </div>

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
        <label>Cost markup % <span class="muted small">(applied when recalculating an item's selling price from its purchase cost)</span>
          <input name="cost_markup_percent" type="number" step="any" value="${settings.cost_markup_percent}" />
        </label>

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
        incoming_prefix: form.get('incoming_prefix'),
        incoming_next_number: Number(form.get('incoming_next_number')),
        outgoing_prefix: form.get('outgoing_prefix'),
        outgoing_next_number: Number(form.get('outgoing_next_number')),
        low_stock_threshold: Number(form.get('low_stock_threshold')),
        cost_markup_percent: Number(form.get('cost_markup_percent')),
      };
      settings = await window.api.settings.update(payload);
      const confirmation = qs('#save-confirmation', container);
      confirmation.hidden = false;
      setTimeout(() => { confirmation.hidden = true; }, 2000);
    });

    qs('#choose-logo-btn', container).addEventListener('click', async () => {
      settings = await window.api.settings.chooseLogo();
      render();
    });

    const removeLogoBtn = qs('#remove-logo-btn', container);
    if (removeLogoBtn) {
      removeLogoBtn.addEventListener('click', async () => {
        settings = await window.api.settings.removeLogo();
        render();
      });
    }

  }

  await load();
};

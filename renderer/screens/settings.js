window.Screens = window.Screens || {};

window.Screens.settings = async function renderSettings(container) {
  const { escapeHtml, qs, confirmAction } = window.Helpers;

  let settings;
  let workspaceDir;

  async function load() {
    settings = await window.api.settings.get();
    workspaceDir = await window.api.workspace.get();
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

        <h2>Shared Workspace</h2>
        <p class="muted small">
          BookBin's data (database and logo) is stored in this folder. Point it at a folder synced by
          OneDrive (or similar) to share this data with another device running BookBin.
        </p>
        <div class="form-row">
          <label>Workspace folder<input value="${escapeHtml(workspaceDir)}" disabled /></label>
        </div>
        <div class="modal-actions" style="justify-content: flex-start; margin-top: 8px;">
          <button type="button" class="btn small" id="choose-workspace-btn">Choose Folder…</button>
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

    qs('#choose-workspace-btn', container).addEventListener('click', async () => {
      const proceed = await confirmAction(
        'Choosing a new workspace folder will restart BookBin. If the folder is empty, your current ' +
        'data will be copied there so it can be shared (e.g. via OneDrive); if it already contains ' +
        "BookBin data, that data will be used instead. Continue?"
      );
      if (!proceed) return;
      const result = await window.api.workspace.choose();
      // A successful choice relaunches the app, so there's nothing left to
      // update here; only a cancel returns control to this screen.
      if (result && result.canceled) return;
    });
  }

  await load();
};

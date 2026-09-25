window.Screens = window.Screens || {};

window.Screens.dashboard = async function renderDashboard(container) {
  const { escapeHtml, formatMoney, formatDate, icon, pageTitle } = window.Helpers;
  const summary = await window.api.dashboard.summary();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const lowCount = summary.lowStockItems.length;

  container.innerHTML = `
    ${pageTitle('Dashboard', today)}

    <section class="card">
      <div class="card-head">
        ${icon('inventory_2', lowCount ? 'danger' : '')}
        <h2>Low stock</h2>
        ${lowCount ? `<span class="badge danger">${lowCount} item${lowCount === 1 ? '' : 's'}</span>` : ''}
      </div>
      ${lowCount === 0
        ? '<p class="muted">Nothing is low on stock.</p>'
        : `<table>
            <thead><tr><th>Item</th><th class="num">On hand</th></tr></thead>
            <tbody>
              ${summary.lowStockItems
                .map((item) => `
                  <tr>
                    <td><a href="#/items">${escapeHtml(item.name)}</a></td>
                    <td class="num">
                      ${Number(item.quantity_on_hand) <= 0 ? '<span class="danger-text">Out of stock</span>&nbsp;&nbsp;' : ''}${item.quantity_on_hand}
                    </td>
                  </tr>
                `)
                .join('')}
            </tbody>
          </table>`}
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-head">
          ${icon('move_to_inbox')}
          <h2>Recent incoming invoices</h2>
          <a href="#/incoming-invoices">View all</a>
        </div>
        ${summary.recentIncoming.length === 0
          ? '<p class="muted">None yet.</p>'
          : `<table>
              <thead><tr><th>#</th><th>Vendor</th><th>Date</th><th class="num">Total</th></tr></thead>
              <tbody>
                ${summary.recentIncoming
                  .map((inv) => `
                    <tr>
                      <td><a class="mono" href="#/incoming-invoices/${inv.id}">${escapeHtml(inv.invoice_number)}</a></td>
                      <td>${escapeHtml(inv.vendor_name || '—')}</td>
                      <td class="muted">${formatDate(inv.invoice_date)}</td>
                      <td class="num">${formatMoney(inv.total)}</td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>

      <section class="card">
        <div class="card-head">
          ${icon('outbox')}
          <h2>Recent outgoing invoices</h2>
          <a href="#/outgoing-invoices">View all</a>
        </div>
        ${summary.recentOutgoing.length === 0
          ? '<p class="muted">None yet.</p>'
          : `<table>
              <thead><tr><th>#</th><th>Customer</th><th>Date</th><th class="num">Total</th></tr></thead>
              <tbody>
                ${summary.recentOutgoing
                  .map((inv) => `
                    <tr>
                      <td><a class="mono" href="#/outgoing-invoices/${inv.id}">${escapeHtml(inv.invoice_number)}</a></td>
                      <td>${escapeHtml(inv.customer_name || '—')}</td>
                      <td class="muted">${formatDate(inv.invoice_date)}</td>
                      <td class="num">${formatMoney(inv.total)}</td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>
    </div>
  `;
};

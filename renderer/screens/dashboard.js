window.Screens = window.Screens || {};

window.Screens.dashboard = async function renderDashboard(container) {
  const { escapeHtml, formatMoney, formatDate } = window.Helpers;
  const summary = await window.api.dashboard.summary();

  container.innerHTML = `
    <h1>Dashboard</h1>

    <section class="card">
      <h2>Low Stock</h2>
      ${summary.lowStockItems.length === 0
        ? '<p class="muted">Nothing is low on stock.</p>'
        : `<table>
            <thead><tr><th>Item</th><th class="num">On Hand</th></tr></thead>
            <tbody>
              ${summary.lowStockItems
                .map((item) => `
                  <tr>
                    <td><a href="#/items">${escapeHtml(item.name)}</a></td>
                    <td class="num">${item.quantity_on_hand}</td>
                  </tr>
                `)
                .join('')}
            </tbody>
          </table>`}
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>Recent Incoming Invoices</h2>
        ${summary.recentIncoming.length === 0
          ? '<p class="muted">None yet.</p>'
          : `<table>
              <thead><tr><th>#</th><th>Vendor</th><th>Date</th><th class="num">Total</th></tr></thead>
              <tbody>
                ${summary.recentIncoming
                  .map((inv) => `
                    <tr>
                      <td><a href="#/incoming-invoices/${inv.id}">${escapeHtml(inv.invoice_number)}</a></td>
                      <td>${escapeHtml(inv.vendor_name || '—')}</td>
                      <td>${formatDate(inv.invoice_date)}</td>
                      <td class="num">${formatMoney(inv.total)}</td>
                    </tr>
                  `)
                  .join('')}
              </tbody>
            </table>`}
      </section>

      <section class="card">
        <h2>Recent Outgoing Invoices</h2>
        ${summary.recentOutgoing.length === 0
          ? '<p class="muted">None yet.</p>'
          : `<table>
              <thead><tr><th>#</th><th>Customer</th><th>Date</th><th class="num">Total</th></tr></thead>
              <tbody>
                ${summary.recentOutgoing
                  .map((inv) => `
                    <tr>
                      <td><a href="#/outgoing-invoices/${inv.id}">${escapeHtml(inv.invoice_number)}</a></td>
                      <td>${escapeHtml(inv.customer_name || '—')}</td>
                      <td>${formatDate(inv.invoice_date)}</td>
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

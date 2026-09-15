// Builds the printable invoice HTML used both for the on-screen preview
// (renderer) and for PDF export (main process, via a hidden BrowserWindow +
// webContents.printToPDF). Kept dependency-free so it can be loaded either
// as a plain <script> in the renderer or via require() in the main process.

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function money(n) {
  const num = Number(n || 0);
  return `$${num.toFixed(2)}`;
}

function buildInvoiceHtml({ invoice, company }) {
  const lineRows = (invoice.lines || [])
    .map((line) => `
      <tr>
        <td>${escapeHtml(line.description)}</td>
        <td class="num">${escapeHtml(line.quantity)}</td>
        <td class="num">${money(line.unit_price)}</td>
        <td class="num">${money(line.line_total)}</td>
      </tr>
    `)
    .join('');

  const logoImg = company && company.company_logo_path
    ? `<img class="logo" src="file://${company.company_logo_path.replace(/\\/g, '/')}" alt="logo" />`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(invoice.invoice_number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .logo { max-height: 60px; max-width: 200px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #666; font-size: 13px; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .parties div { font-size: 13px; line-height: 1.5; }
  .parties h3 { font-size: 12px; text-transform: uppercase; color: #888; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #888; border-bottom: 2px solid #ddd; padding: 8px 6px; }
  td { padding: 8px 6px; border-bottom: 1px solid #eee; font-size: 13px; }
  .num { text-align: right; }
  .totals { display: flex; justify-content: flex-end; }
  .totals table { width: 260px; }
  .totals td { border: none; padding: 4px 6px; }
  .totals .grand td { font-size: 16px; font-weight: bold; border-top: 2px solid #333; }
  .notes { margin-top: 32px; font-size: 12px; color: #555; white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escapeHtml(company && company.company_name ? company.company_name : 'Your Company')}</h1>
      <div class="muted">${escapeHtml(company && company.company_address ? company.company_address : '')}</div>
    </div>
    ${logoImg}
  </div>

  <div class="parties">
    <div>
      <h3>Bill To</h3>
      ${escapeHtml(invoice.customer_name || '')}<br/>
      ${escapeHtml(invoice.customer_address || '')}<br/>
      ${escapeHtml(invoice.customer_email || '')}
    </div>
    <div>
      <h3>Invoice</h3>
      <strong>${escapeHtml(invoice.invoice_number)}</strong><br/>
      Date: ${escapeHtml(invoice.invoice_date)}<br/>
      Status: ${escapeHtml(invoice.status || 'draft')}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit Price</th>
        <th class="num">Line Total</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows}
    </tbody>
  </table>

  <div class="totals">
    <table>
      <tr class="grand"><td>Total</td><td class="num">${money(invoice.total)}</td></tr>
    </table>
  </div>

  ${invoice.notes ? `<div class="notes">${escapeHtml(invoice.notes)}</div>` : ''}
</body>
</html>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildInvoiceHtml };
}

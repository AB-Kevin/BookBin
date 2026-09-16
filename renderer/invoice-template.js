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

// Escapes text and turns embedded newlines into <br/> so multi-line
// addresses render on separate lines instead of collapsing to one.
function escapeMultiline(value) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br/>');
}

function money(n) {
  const num = Number(n || 0);
  return `$${num.toFixed(2)}`;
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.slice(0, 3).map((w) => w[0].toUpperCase()).join('');
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

  const companyName = company && company.company_name ? company.company_name : 'Your Company';

  const logoImg = company && company.company_logo_path
    ? `<img class="logo" src="file://${company.company_logo_path.replace(/\\/g, '/')}" alt="logo" />`
    : `<div class="logo logo-placeholder">${escapeHtml(initials(companyName))}</div>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(invoice.invoice_number)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    color: #1a1a1a;
    margin: 0;
    padding: 48px;
  }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .brand { display: flex; align-items: center; gap: 16px; }
  .logo { max-height: 64px; max-width: 64px; border-radius: 50%; }
  .logo-placeholder {
    display: flex; align-items: center; justify-content: center;
    width: 64px; height: 64px;
    border: 2px solid #2f6f4f; color: #2f6f4f;
    font-family: Georgia, 'Times New Roman', serif; font-size: 20px; font-weight: bold;
  }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 24px; font-weight: normal; margin: 0 0 4px; }
  .muted { color: #666; font-size: 13px; line-height: 1.5; }
  .header-right { text-align: right; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #2f6f4f; font-weight: bold; margin: 0 0 4px; }
  .invoice-number { font-family: Georgia, 'Times New Roman', serif; font-size: 22px; }
  hr { border: none; border-top: 1px solid #d8d2c2; margin: 0 0 24px; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 28px; gap: 32px; }
  .parties > div { font-size: 13px; line-height: 1.5; }
  .parties .right { text-align: right; }
  .customer-name { font-family: Georgia, 'Times New Roman', serif; font-size: 17px; margin: 0 0 6px; }
  .amount-due { font-family: Georgia, 'Times New Roman', serif; font-size: 22px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #2f6f4f; font-weight: bold; border-bottom: 2px solid #2f6f4f; padding: 8px 6px; }
  td { padding: 10px 6px; border-bottom: 1px solid #e5e0d5; font-size: 13px; }
  .num { text-align: right; }
  .totals { display: flex; justify-content: flex-end; align-items: center; border-top: 2px solid #1a1a1a; padding-top: 12px; }
  .totals .label { margin: 0 24px 0 0; }
  .totals .grand { font-family: Georgia, 'Times New Roman', serif; font-size: 24px; }
  .notes { margin-top: 32px; font-size: 12px; color: #555; white-space: pre-wrap; }
  .footer { display: flex; justify-content: space-between; margin-top: 64px; padding-top: 12px; border-top: 1px solid #d8d2c2; font-size: 11px; color: #888; }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">
      ${logoImg}
      <div>
        <h1>${escapeHtml(companyName)}</h1>
        <div class="muted">${escapeMultiline(company && company.company_address ? company.company_address : '')}</div>
      </div>
    </div>
    <div class="header-right">
      <div class="label">Invoice</div>
      <div class="invoice-number">${escapeHtml(invoice.invoice_number)}</div>
    </div>
  </div>

  <hr/>

  <div class="parties">
    <div>
      <div class="label">Bill To</div>
      <div class="customer-name">${escapeHtml(invoice.customer_name || '')}</div>
      <div class="muted">${escapeMultiline(invoice.customer_address || '')}</div>
      <div class="muted">${escapeHtml(invoice.customer_email || '')}</div>
    </div>
    <div class="right">
      <div class="label">Date</div>
      <div class="muted" style="margin-bottom: 16px;">${escapeHtml(invoice.invoice_date)}</div>
      <div class="label">Amount Due</div>
      <div class="amount-due">${money(invoice.total)}</div>
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
    <div class="label">Total</div>
    <div class="grand">${money(invoice.total)}</div>
  </div>

  ${invoice.notes ? `<div class="notes">${escapeHtml(invoice.notes)}</div>` : ''}

  <div class="footer">
    <div>${escapeHtml(companyName)}</div>
    <div>Invoice ${escapeHtml(invoice.invoice_number)}</div>
  </div>
</body>
</html>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildInvoiceHtml };
}

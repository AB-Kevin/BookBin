window.Screens = window.Screens || {};

// The dashboard is a set of cards, each shown or hidden and put in order with
// "Customize". The choice is per device (localStorage), like the theme: it is
// how this screen is laid out here, not something the business shares.
//
// Each card loads its own data (ipc/dashboard.js), so the page appears at once
// and fills in, and a card that fails says so without taking the rest down.

(function () {
  const LAYOUT_KEY = 'bookbin.dashboardLayout';

  function helpers() {
    return window.Helpers;
  }

  function cardHead(iconName, title, extra) {
    const { icon, escapeHtml } = helpers();
    return `<div class="card-head">${icon(iconName)}<h2>${escapeHtml(title)}</h2>${extra || ''}</div>`;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function quantity(n) {
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function invoiceTable(rows, kind) {
    const { escapeHtml, formatMoney, formatDate } = helpers();
    const base = kind === 'incoming' ? '#/incoming-invoices' : '#/outgoing-invoices';
    const who = kind === 'incoming' ? 'Vendor' : 'Customer';
    return `<table>
      <thead><tr><th>#</th><th>${who}</th><th>Date</th><th class="num">Total</th></tr></thead>
      <tbody>
        ${rows.map((inv) => `
          <tr>
            <td><a class="mono" href="${base}/${inv.id}">${escapeHtml(inv.invoice_number)}</a></td>
            <td>${escapeHtml((kind === 'incoming' ? inv.vendor_name : inv.customer_name) || '—')}</td>
            <td class="muted">${formatDate(inv.invoice_date)}</td>
            <td class="num">${formatMoney(inv.total)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  function stat(label, value, note, extraClass) {
    return `<div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${extraClass || ''}">${value}</div>
      ${note ? `<div class="stat-note">${note}</div>` : ''}
    </div>`;
  }

  function sumTotals(rows) {
    return rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  }

  // In the order a new install shows them; the ones off by default go last.
  // `wide` cards take the full row; the rest pair up side by side.
  const CARDS = [
    {
      id: 'open-po',
      title: 'Open purchase order',
      icon: 'shopping_cart',
      description: 'How far along the open order is, and the shopping list of what is still to buy.',
      wide: true,
      shownByDefault: true,
      render(data) {
        const { escapeHtml, formatMoney } = helpers();
        if (!data.po) {
          return cardHead('shopping_cart', 'Open purchase order', '<a href="#/purchase-orders">Purchase orders</a>') +
            '<p class="muted">No purchase order is open.</p>';
        }
        const { po, lines } = data;
        const wanted = lines.reduce((sum, l) => sum + l.wanted, 0);
        const bought = lines.reduce((sum, l) => sum + Math.min(l.bought, l.wanted), 0);
        const toBuy = lines
          .filter((l) => l.bought < l.wanted)
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        const overMax = lines.filter((l) => l.max_price > 0 && l.highest_cost > l.max_price);
        const done = lines.length - toBuy.length;
        const percent = wanted ? Math.round((bought / wanted) * 100) : 100;
        const others = data.otherOpen
          ? `<a href="#/purchase-orders">${plural(data.otherOpen, 'other open order')}</a>`
          : '';

        return `
          ${cardHead('shopping_cart', po.name, `${others}<a href="#/purchase-orders/${po.id}">Open order</a>`)}
          <div class="card-stats">
            ${stat('Books bought', `${quantity(bought)} <span class="stat-of">of ${quantity(wanted)}</span>`, `${percent}% of the order`)}
            ${stat('Titles complete', `${done} <span class="stat-of">of ${lines.length}</span>`)}
            ${stat('Still to buy', quantity(toBuy.reduce((sum, l) => sum + l.wanted - l.bought, 0)),
              plural(toBuy.length, 'title'), toBuy.length ? '' : 'done')}
            ${stat('Paid over max price', overMax.length,
              overMax.length ? overMax.map((l) => escapeHtml(l.name)).slice(0, 3).join(', ') + (overMax.length > 3 ? '…' : '') : 'None',
              overMax.length ? 'warn' : '')}
          </div>
          ${toBuy.length === 0
            ? `<p class="muted">${lines.length ? 'Everything on this order has been bought.' : 'This order has no titles on it yet.'}</p>`
            : `<table>
                <thead><tr><th>Still to buy</th><th>Edition</th><th class="num">Bought</th><th class="num">Need</th><th class="num">Max price</th></tr></thead>
                <tbody>
                  ${toBuy.map((l) => `
                    <tr>
                      <td><a href="#/purchase-orders/${po.id}/lines/${l.id}">${escapeHtml(l.name)}</a></td>
                      <td class="muted">${escapeHtml(l.edition || '')}</td>
                      <td class="num"><span class="progress-badge">${quantity(l.bought)}/${quantity(l.wanted)}</span></td>
                      <td class="num">${quantity(l.wanted - l.bought)}</td>
                      <td class="num">${l.max_price ? formatMoney(l.max_price) : '—'}</td>
                    </tr>`).join('')}
                </tbody>
              </table>`}`;
      },
    },
    {
      id: 'unpaid-incoming',
      title: 'Unpaid vendor invoices',
      icon: 'payments',
      description: 'Vendor invoices not marked paid, oldest first, and the total owed.',
      shownByDefault: true,
      render(rows) {
        const { formatMoney } = helpers();
        const badge = rows.length ? `<span class="badge count">${formatMoney(sumTotals(rows))} owed</span>` : '';
        return cardHead('payments', 'Unpaid vendor invoices', badge) +
          (rows.length ? invoiceTable(rows, 'incoming') : '<p class="muted">Every vendor invoice is paid.</p>');
      },
    },
    {
      id: 'not-received',
      title: 'On the way',
      icon: 'local_shipping',
      description: 'Vendor invoices not marked received yet: what should be on its way.',
      shownByDefault: true,
      render(rows) {
        const badge = rows.length ? `<span class="badge count">${plural(rows.length, 'invoice')}</span>` : '';
        return cardHead('local_shipping', 'On the way', badge) +
          (rows.length ? invoiceTable(rows, 'incoming') : '<p class="muted">Nothing is waiting to arrive.</p>');
      },
    },
    {
      id: 'recent-incoming',
      title: 'Recent incoming invoices',
      icon: 'move_to_inbox',
      description: 'The last five vendor invoices.',
      shownByDefault: true,
      render(rows) {
        return cardHead('move_to_inbox', 'Recent incoming invoices', '<a href="#/incoming-invoices">View all</a>') +
          (rows.length ? invoiceTable(rows, 'incoming') : '<p class="muted">None yet.</p>');
      },
    },
    {
      id: 'recent-outgoing',
      title: 'Recent outgoing invoices',
      icon: 'outbox',
      description: 'The last five invoices to customers.',
      shownByDefault: true,
      render(rows) {
        return cardHead('outbox', 'Recent outgoing invoices', '<a href="#/outgoing-invoices">View all</a>') +
          (rows.length ? invoiceTable(rows, 'outgoing') : '<p class="muted">None yet.</p>');
      },
    },
    {
      id: 'year-totals',
      title: 'Year totals',
      icon: 'calendar_month',
      description: 'Spent and invoiced this year, beside the same point in earlier years.',
      wide: true,
      shownByDefault: true,
      render(data) {
        const { formatMoney, formatDate } = helpers();
        const empty = { spent: 0, invoiced: 0, spentToDate: 0, invoicedToDate: 0 };
        const thisYear = data.years.find((y) => y.year === data.currentYear) || { ...empty, year: data.currentYear };
        const lastYear = data.years.find((y) => y.year === data.currentYear - 1);
        const sameDay = formatDate(data.today).replace(/,? \d{4}$/, '');

        function versus(now, before) {
          if (!lastYear) return '';
          const change = before ? Math.round(((now - before) / Math.abs(before)) * 100) : null;
          const arrow = change === null ? '' : ` (${change >= 0 ? '+' : ''}${change}%)`;
          return `${formatMoney(before)} by ${sameDay} last year${arrow}`;
        }

        const net = (y) => y.invoiced - y.spent;
        return `
          ${cardHead('calendar_month', `${data.currentYear} so far`)}
          <div class="card-stats">
            ${stat('Spent on purchases', formatMoney(thisYear.spentToDate), versus(thisYear.spentToDate, lastYear && lastYear.spentToDate))}
            ${stat('Invoiced to customers', formatMoney(thisYear.invoicedToDate), versus(thisYear.invoicedToDate, lastYear && lastYear.invoicedToDate))}
            ${stat('Invoiced minus spent', formatMoney(thisYear.invoicedToDate - thisYear.spentToDate),
              versus(thisYear.invoicedToDate - thisYear.spentToDate, lastYear && lastYear.invoicedToDate - lastYear.spentToDate),
              thisYear.invoicedToDate - thisYear.spentToDate < 0 ? 'warn' : '')}
          </div>
          ${data.years.length === 0
            ? '<p class="muted">No invoices yet.</p>'
            : `<table>
                <thead><tr><th>Whole year</th><th class="num">Spent</th><th class="num">Invoiced</th><th class="num">Invoiced minus spent</th></tr></thead>
                <tbody>
                  ${data.years.map((y) => `
                    <tr>
                      <td>${y.year}${y.year === data.currentYear ? ' <span class="muted">(so far)</span>' : ''}</td>
                      <td class="num">${formatMoney(y.spent)}</td>
                      <td class="num">${formatMoney(y.invoiced)}</td>
                      <td class="num">${formatMoney(net(y))}</td>
                    </tr>`).join('')}
                </tbody>
              </table>`}
          <p class="card-foot muted small">Draft invoices to customers are not counted.</p>`;
      },
    },
    {
      id: 'low-stock',
      title: 'Low stock',
      icon: 'inventory_2',
      description: 'Items at or below the low-stock level set in Settings.',
      shownByDefault: false,
      render(rows) {
        const { escapeHtml, icon } = helpers();
        const head = `<div class="card-head">${icon('inventory_2', rows.length ? 'danger' : '')}<h2>Low stock</h2>${
          rows.length ? `<span class="badge danger">${plural(rows.length, 'item')}</span>` : ''}</div>`;
        if (!rows.length) return `${head}<p class="muted">Nothing is low on stock.</p>`;
        return `${head}<table>
          <thead><tr><th>Item</th><th class="num">On hand</th></tr></thead>
          <tbody>
            ${rows.map((item) => `
              <tr>
                <td><a href="#/items">${escapeHtml(item.name)}</a></td>
                <td class="num">${item.quantity_on_hand <= 0 ? '<span class="danger-text">Out of stock</span>&nbsp;&nbsp;' : ''}${quantity(item.quantity_on_hand)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
      },
    },
    {
      id: 'left-to-ship',
      title: 'Left to ship',
      icon: 'package_2',
      description: 'Books on hand and what they cost, with the titles you have most of.',
      shownByDefault: false,
      render(rows) {
        const { escapeHtml, formatMoney } = helpers();
        const books = rows.reduce((sum, r) => sum + r.quantity_on_hand, 0);
        const value = rows.reduce((sum, r) => sum + r.quantity_on_hand * (r.default_cost || 0), 0);
        return `
          ${cardHead('package_2', 'Left to ship', '<a href="#/items">Items</a>')}
          <div class="card-stats">
            ${stat('Books on hand', quantity(books))}
            ${stat('Titles', rows.length)}
            ${stat('Value at cost', formatMoney(value))}
          </div>
          ${rows.length === 0
            ? '<p class="muted">Nothing is on hand.</p>'
            : `<table>
                <thead><tr><th>Most on hand</th><th class="num">On hand</th></tr></thead>
                <tbody>
                  ${rows.slice(0, 8).map((r) => `
                    <tr><td>${escapeHtml(r.name)}</td><td class="num">${quantity(r.quantity_on_hand)}</td></tr>`).join('')}
                </tbody>
              </table>`}`;
      },
    },
    {
      id: 'draft-outgoing',
      title: 'Draft invoices',
      icon: 'edit_note',
      description: 'Invoices to customers started but not sent yet.',
      shownByDefault: false,
      render(rows) {
        const badge = rows.length ? `<span class="badge count">${plural(rows.length, 'draft')}</span>` : '';
        return cardHead('edit_note', 'Draft invoices', badge) +
          (rows.length ? invoiceTable(rows, 'outgoing') : '<p class="muted">No drafts waiting to be sent.</p>');
      },
    },
    {
      id: 'top-customers',
      title: 'Top customers this year',
      icon: 'groups',
      description: 'The five customers invoiced the most this year.',
      shownByDefault: false,
      render(rows) {
        const { escapeHtml, formatMoney } = helpers();
        return cardHead('groups', 'Top customers this year', '<a href="#/customers">Customers</a>') +
          (rows.length === 0
            ? '<p class="muted">No invoices to customers yet this year.</p>'
            : `<table>
                <thead><tr><th>Customer</th><th class="num">Invoices</th><th class="num">Total</th></tr></thead>
                <tbody>
                  ${rows.map((c) => `
                    <tr>
                      <td>${escapeHtml(c.name || '(no customer)')}</td>
                      <td class="num">${c.invoices}</td>
                      <td class="num">${formatMoney(c.total)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>`);
      },
    },
  ];

  const CARDS_BY_ID = new Map(CARDS.map((card) => [card.id, card]));

  function defaultLayout() {
    return CARDS.map((card) => ({ id: card.id, shown: card.shownByDefault }));
  }

  // A saved layout keeps its order. Cards it does not mention -- ones added in
  // a later version -- join at the end, as they would on a new install, and
  // cards that no longer exist drop out.
  function loadLayout() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    } catch (err) {
      // Unreadable or unavailable storage: fall back to the default.
    }
    if (!Array.isArray(saved)) return defaultLayout();
    const layout = saved
      .filter((entry) => entry && CARDS_BY_ID.has(entry.id))
      .map((entry) => ({ id: entry.id, shown: !!entry.shown }));
    const known = new Set(layout.map((entry) => entry.id));
    for (const entry of defaultLayout()) {
      if (!known.has(entry.id)) layout.push(entry);
    }
    return layout;
  }

  function saveLayout(layout) {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch (err) {
      // Storage unavailable: the layout lasts until the app closes.
    }
  }

  function loadCard(section, card) {
    const { escapeHtml } = helpers();
    window.api.dashboard.card(card.id).then(
      (data) => {
        section.innerHTML = card.render(data);
      },
      (err) => {
        console.error(err);
        section.innerHTML = cardHead(card.icon, card.title) +
          `<p class="error">Could not load this card: ${escapeHtml(err.message)}</p>`;
      }
    );
  }

  function openEditor(onSave) {
    const { escapeHtml, icon, iconButton, showModal, hideModal, qs, qsa } = helpers();
    let layout = loadLayout();

    const modal = showModal(`
      <h2>Customize dashboard</h2>
      <p class="muted small">Choose which cards to show and the order they go in. This is saved on this device only.</p>
      <form id="dashboard-editor">
        <ul class="dash-editor"></ul>
        <div class="modal-actions">
          <button type="button" class="btn push-left" id="dash-reset">Reset to default</button>
          <button type="button" class="btn" id="dash-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`);
    const list = qs('.dash-editor', modal);

    function draw() {
      list.innerHTML = layout.map((entry, index) => {
        const card = CARDS_BY_ID.get(entry.id);
        return `
          <li class="${entry.shown ? '' : 'off'}">
            <label class="checkbox">
              <input type="checkbox" data-index="${index}" ${entry.shown ? 'checked' : ''} />
              ${icon(card.icon)}
              <span class="dash-editor-text">
                <span class="dash-editor-title">${escapeHtml(card.title)}</span>
                <span class="dash-editor-desc">${escapeHtml(card.description)}</span>
              </span>
            </label>
            ${iconButton('arrow_upward', `Move ${card.title} up`, `data-move="-1" data-index="${index}" ${index === 0 ? 'disabled' : ''}`)}
            ${iconButton('arrow_downward', `Move ${card.title} down`, `data-move="1" data-index="${index}" ${index === layout.length - 1 ? 'disabled' : ''}`)}
          </li>`;
      }).join('');

      qsa('input[type="checkbox"]', list).forEach((box) => {
        box.addEventListener('change', () => {
          layout[Number(box.dataset.index)].shown = box.checked;
          box.closest('li').classList.toggle('off', !box.checked);
        });
      });
      qsa('[data-move]', list).forEach((btn) => {
        btn.addEventListener('click', () => {
          const from = Number(btn.dataset.index);
          const to = from + Number(btn.dataset.move);
          [layout[from], layout[to]] = [layout[to], layout[from]];
          draw();
          // Keep focus on the card that moved, so it can be moved again.
          const again = qs(`[data-move="${btn.dataset.move}"][data-index="${to}"]`, list);
          (again && !again.disabled ? again : qs(`[data-index="${to}"]`, list)).focus();
        });
      });
    }

    draw();
    qs('#dash-reset', modal).addEventListener('click', () => {
      layout = defaultLayout();
      draw();
    });
    qs('#dash-cancel', modal).addEventListener('click', hideModal);
    qs('#dashboard-editor', modal).addEventListener('submit', (e) => {
      e.preventDefault();
      saveLayout(layout);
      hideModal();
      onSave();
    });
  }

  window.Screens.dashboard = async function renderDashboard(container) {
    const { icon, pageTitle, qs, qsa } = helpers();
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const shown = loadLayout().filter((entry) => entry.shown).map((entry) => CARDS_BY_ID.get(entry.id));

    container.innerHTML = `
      <div class="page-header">
        ${pageTitle('Dashboard', today)}
        <button class="btn" id="customize-dashboard">${icon('tune')}Customize</button>
      </div>
      ${shown.length === 0
        ? '<section class="card"><p class="muted">Every card is hidden. Use Customize to choose what to show here.</p></section>'
        : `<div class="dashboard-grid">
            ${shown.map((card) => `
              <section class="card${card.wide ? ' wide' : ''}" data-card="${card.id}">
                ${cardHead(card.icon, card.title)}
                <p class="loading">Loading…</p>
              </section>`).join('')}
          </div>`}
    `;

    qs('#customize-dashboard', container).addEventListener('click', () => openEditor(() => renderDashboard(container)));
    qsa('[data-card]', container).forEach((section) => loadCard(section, CARDS_BY_ID.get(section.dataset.card)));
  };
})();

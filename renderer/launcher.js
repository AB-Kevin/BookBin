// The start screen: choose a database, then sign in to it.
//
// This is everything shown before the app itself. It deliberately needs no
// account -- the update controls live here too, so a broken or outdated
// version can always be updated without signing in first.
//
// Nothing here decides anything about access. Opening a database and signing
// in both happen in the main process; whether an account may read or write a
// single row is settled by row-level security in the database.

(function () {
  const { escapeHtml, showModal, hideModal, confirmAction } = window.Helpers;

  let onSignedIn = () => {};
  let unsubscribeProgress = null;

  function root() {
    return document.getElementById('login-root');
  }

  function $(selector) {
    return root().querySelector(selector);
  }

  // Every view shares the card, the brand and the update footer.
  function frame(inner, { wide = false } = {}) {
    root().innerHTML = `
      <div class="login-card ${wide ? 'launcher-wide' : ''}">
        <div class="login-brand">
          <span class="login-icon">📒</span>
          <span class="login-title">BookBin</span>
        </div>
        ${inner}
        <div class="launcher-footer" data-update-widget></div>
      </div>
    `;
    if (window.renderUpdateWidgets) window.renderUpdateWidgets();
  }

  function setError(message) {
    const box = $('#launcher-error');
    if (box) box.textContent = message || '';
  }

  function busy(button, label) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    return () => {
      button.disabled = false;
      button.textContent = original;
    };
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (err) {
      return url;
    }
  }

  // ------------------------------------------------------------- the list

  async function showList(errorMessage) {
    window.CurrentDatabase = null;
    const list = await window.api.databases.list();

    frame(`
      <p class="login-sub">Choose a database</p>
      ${list.length === 0
        ? '<p class="muted small launcher-empty">No databases yet. Add one you have been given, or set up a new one.</p>'
        : `<ul class="db-list">
            ${list
              .map((db) => `
                <li class="db-item ${db.isLastUsed ? 'last-used' : ''}">
                  <button type="button" class="db-open" data-open="${db.id}">
                    <span class="db-name">${escapeHtml(db.name)}</span>
                    <span class="db-host">${escapeHtml(hostOf(db.url))}${db.hasSavedSession ? ' · signed in' : ''}</span>
                  </button>
                  <button type="button" class="db-menu" data-menu="${db.id}" title="More" aria-label="More options for ${escapeHtml(db.name)}">⋯</button>
                </li>
              `)
              .join('')}
          </ul>`}
      <div class="login-error" id="launcher-error" role="alert">${errorMessage ? escapeHtml(errorMessage) : ''}</div>
      <div class="launcher-actions">
        <button type="button" class="btn" id="add-db">Add a database</button>
        <button type="button" class="btn" id="setup-db">Set up a new one</button>
      </div>
    `, { wide: true });

    root().querySelectorAll('[data-open]').forEach((btn) =>
      btn.addEventListener('click', () => openDatabase(btn.dataset.open, btn))
    );
    root().querySelectorAll('[data-menu]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const db = list.find((d) => d.id === btn.dataset.menu);
        if (db) openDatabaseMenu(db);
      })
    );
    $('#add-db').addEventListener('click', () => showAdd());
    $('#setup-db').addEventListener('click', () => showSetup());
  }

  async function openDatabase(id, button) {
    setError('');
    root().querySelectorAll('[data-open]').forEach((b) => { b.disabled = true; });
    if (button) button.classList.add('opening');
    const result = await window.api.databases.open(id);
    if (!result.ok) {
      showList(result.error);
      return;
    }
    window.CurrentDatabase = result.database;
    if (result.profile) onSignedIn(result.profile);
    else showLogin();
  }

  function openDatabaseMenu(db) {
    const modal = showModal(`
      <h2>${escapeHtml(db.name)}</h2>
      <p class="muted small">${escapeHtml(db.url)}</p>
      <div class="menu-actions">
        <button type="button" class="btn" id="menu-rename">Rename…</button>
        <button type="button" class="btn" id="menu-code">Connection code…</button>
        <button type="button" class="btn danger" id="menu-remove">Remove from this computer</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" id="menu-close">Close</button>
      </div>
    `);
    modal.querySelector('#menu-close').addEventListener('click', hideModal);
    modal.querySelector('#menu-rename').addEventListener('click', () => renameDatabase(db));
    modal.querySelector('#menu-code').addEventListener('click', () => showConnectionCode(db));
    modal.querySelector('#menu-remove').addEventListener('click', async () => {
      hideModal();
      if (!(await confirmAction(
        `Remove "${db.name}" from this computer? Its saved sign-in and backup settings are forgotten. ` +
        'The database itself and everything in it are not touched, and it can be added back later.'
      ))) return;
      await window.api.databases.remove(db.id);
      showList();
    });
  }

  function renameDatabase(db) {
    const modal = showModal(`
      <h2>Rename Database</h2>
      <p class="muted small">Only changes the name shown on this computer.</p>
      <form id="rename-db-form">
        <label>Name<input name="name" required value="${escapeHtml(db.name)}" /></label>
        <div class="form-error" id="rename-error" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    `);
    const input = modal.querySelector('input[name="name"]');
    input.focus();
    input.select();
    modal.querySelector('#cancel-btn').addEventListener('click', hideModal);
    modal.querySelector('#rename-db-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await window.api.databases.rename(db.id, input.value);
      if (!result.ok) {
        modal.querySelector('#rename-error').textContent = result.error;
        return;
      }
      hideModal();
      showList();
    });
  }

  async function showConnectionCode(db) {
    const result = await window.api.databases.connectionCode(db.id);
    if (!result.ok) {
      await confirmAction(result.error);
      return;
    }
    const modal = showModal(`
      <h2>Connection Code</h2>
      <p class="muted small">
        Paste this into "Add a database" on another computer to connect it to
        <strong>${escapeHtml(db.name)}</strong>. It holds the database's address
        and public key, not a password — each person still signs in with their
        own account.
      </p>
      <textarea class="code-box" readonly rows="4">${escapeHtml(result.code)}</textarea>
      <div class="modal-actions">
        <button type="button" class="btn" id="close-btn">Close</button>
        <button type="button" class="btn primary" id="copy-btn">Copy</button>
      </div>
    `);
    const box = modal.querySelector('.code-box');
    box.focus();
    box.select();
    modal.querySelector('#close-btn').addEventListener('click', hideModal);
    modal.querySelector('#copy-btn').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(result.code);
        e.target.textContent = 'Copied';
      } catch (err) {
        // Clipboard refused; the text is selected, so Ctrl+C still works.
        box.select();
      }
    });
  }

  // -------------------------------------------------------------- adding

  function showAdd(mode = 'code') {
    const byCode = mode === 'code';
    frame(`
      <p class="login-sub">Add a database</p>
      <form id="add-form" novalidate>
        ${byCode
          ? `<label class="login-label" for="add-code">Connection code</label>
             <textarea class="login-input code-box" id="add-code" name="code" rows="3"
                       placeholder="bookbin1:…" spellcheck="false"></textarea>
             <p class="muted small">Ask an owner for this: it is under ⋯ → Connection code on their start screen.</p>`
          : `<label class="login-label" for="add-url">Project URL</label>
             <input class="login-input" id="add-url" name="url" placeholder="https://abcdefgh.supabase.co" spellcheck="false" />
             <label class="login-label" for="add-key">Publishable key</label>
             <input class="login-input" id="add-key" name="key" placeholder="sb_publishable_…" spellcheck="false" />
             <p class="muted small">Both are in the Supabase dashboard under Project Settings → API Keys. Never the secret key.</p>`}
        <label class="login-label" for="add-name">Name <span class="muted">(optional)</span></label>
        <input class="login-input" id="add-name" name="name" placeholder="e.g. BookBin" />
        <div class="login-error" id="launcher-error" role="alert"></div>
        <button class="login-submit" id="add-submit" type="submit">Add</button>
      </form>
      <div class="launcher-links">
        <a href="#" id="switch-mode">${byCode ? 'Enter an address and key instead' : 'Use a connection code instead'}</a>
        <a href="#" id="back-link">← Back</a>
      </div>
    `);

    $(byCode ? '#add-code' : '#add-url').focus();
    $('#switch-mode').addEventListener('click', (e) => {
      e.preventDefault();
      showAdd(byCode ? 'manual' : 'code');
    });
    $('#back-link').addEventListener('click', (e) => {
      e.preventDefault();
      showList();
    });
    $('#add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      setError('');
      const done = busy($('#add-submit'), 'Checking…');
      const name = $('#add-name').value;
      const result = byCode
        ? await window.api.databases.addFromCode($('#add-code').value, name)
        : await window.api.databases.add({ name, url: $('#add-url').value, publishableKey: $('#add-key').value });
      if (!result.ok) {
        done();
        setError(result.error);
        return;
      }
      openDatabase(result.database.id);
    });
  }

  // ----------------------------------------------------- setting one up

  const TOKEN_URL = 'https://supabase.com/dashboard/account/tokens';
  const NEW_PROJECT_URL = 'https://supabase.com/dashboard/new';

  function showSetup() {
    frame(`
      <p class="login-sub">Set up a new database</p>
      <ol class="setup-steps">
        <li>Create an empty project at
          <a href="#" data-ext-link="${NEW_PROJECT_URL}">supabase.com</a>. The free plan is fine.
          Wait until its dashboard says it is ready.</li>
        <li>Create an access token under
          <a href="#" data-ext-link="${TOKEN_URL}">Account → Access Tokens</a> and paste it below.</li>
      </ol>
      <form id="token-form" novalidate>
        <label class="login-label" for="setup-token">Access token</label>
        <input class="login-input" id="setup-token" type="password" placeholder="sbp_…" spellcheck="false" autocomplete="off" />
        <p class="muted small">
          BookBin uses the token only while setting up, and never saves it. It can
          change every project in your Supabase account, so delete it on that page
          once setup is finished.
        </p>
        <div class="login-error" id="launcher-error" role="alert"></div>
        <button class="login-submit" id="token-submit" type="submit">Continue</button>
      </form>
      <div class="launcher-links"><a href="#" id="back-link">← Back</a></div>
    `, { wide: true });

    $('#setup-token').focus();
    $('#back-link').addEventListener('click', (e) => {
      e.preventDefault();
      showList();
    });
    $('#token-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = $('#setup-token').value.trim();
      if (!token) {
        setError('Paste your access token first.');
        return;
      }
      setError('');
      const done = busy($('#token-submit'), 'Checking…');
      const result = await window.api.setup.listProjects(token);
      if (!result.ok) {
        done();
        setError(result.error);
        return;
      }
      showProjectPicker(token, result.projects);
    });
  }

  function showProjectPicker(token, projects) {
    frame(`
      <p class="login-sub">Which project?</p>
      ${projects.length === 0
        ? `<p class="muted small launcher-empty">That account has no projects yet. Create one at
             <a href="#" data-ext-link="${NEW_PROJECT_URL}">supabase.com</a>, then come back.</p>`
        : `<ul class="db-list">
            ${projects
              .map((p) => `
                <li class="db-item">
                  <button type="button" class="db-open" data-ref="${escapeHtml(p.ref)}">
                    <span class="db-name">${escapeHtml(p.name)}</span>
                    <span class="db-host">${escapeHtml(p.ref)} · ${escapeHtml(p.region || '')}${p.status === 'ACTIVE_HEALTHY' ? '' : ` · ${escapeHtml(p.status)}`}</span>
                  </button>
                </li>
              `)
              .join('')}
          </ul>`}
      <div class="login-error" id="launcher-error" role="alert"></div>
      <div class="launcher-links"><a href="#" id="back-link">← Back</a></div>
    `, { wide: true });

    $('#back-link').addEventListener('click', (e) => {
      e.preventDefault();
      showSetup();
    });
    root().querySelectorAll('[data-ref]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        setError('');
        root().querySelectorAll('[data-ref]').forEach((b) => { b.disabled = true; });
        const result = await window.api.setup.inspect(token, btn.dataset.ref);
        root().querySelectorAll('[data-ref]').forEach((b) => { b.disabled = false; });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const project = result.project;
        if (!project.ready) {
          setError(
            project.unhealthy && project.unhealthy.length
              ? `That project is still starting up (${project.unhealthy.join(', ')} not ready yet). Try again in a minute.`
              : `That project is not running (${project.status}). If it is paused, resume it from the Supabase dashboard.`
          );
          return;
        }
        showSetupDetails(token, project);
      })
    );
  }

  function showSetupDetails(token, project) {
    const needsOwner = !project.hasOwner;
    frame(`
      <p class="login-sub">${escapeHtml(project.name)}</p>
      ${project.alreadySetUp
        ? `<p class="muted small">This project already has BookBin's tables, and everything in
             them is kept. Setup will ${project.pending.length
               ? `add what this version of BookBin needs that it is missing (${project.pending.length}
                  update${project.pending.length === 1 ? '' : 's'}), `
               : ''}bring its account manager up to date, make sure public sign-ups are
             off${needsOwner ? ', create your owner account' : ''} and add it to this computer.</p>`
        : `<p class="muted small">BookBin will create its tables, install its account manager,
             turn off public sign-ups and create your owner account.</p>`}
      <form id="details-form" novalidate>
        <label class="login-label" for="setup-name">Name on this computer</label>
        <input class="login-input" id="setup-name" value="${escapeHtml(project.name)}" />
        ${needsOwner ? `
          <label class="login-label" for="owner-name">Your name</label>
          <input class="login-input" id="owner-name" autocomplete="name" />
          <label class="login-label" for="owner-email">Your email</label>
          <input class="login-input" id="owner-email" type="email" autocomplete="username" />
          <label class="login-label" for="owner-password">Choose a password</label>
          <input class="login-input" id="owner-password" type="password" autocomplete="new-password" minlength="8" />
          <label class="login-label" for="owner-confirm">Confirm password</label>
          <input class="login-input" id="owner-confirm" type="password" autocomplete="new-password" minlength="8" />
        ` : ''}
        <div class="login-error" id="launcher-error" role="alert"></div>
        <p class="muted small" id="setup-progress" aria-live="polite"></p>
        <button class="login-submit" id="details-submit" type="submit">${project.alreadySetUp ? 'Update and add' : 'Set up'}</button>
      </form>
      <div class="launcher-links"><a href="#" id="back-link">← Back</a></div>
    `, { wide: true });

    $('#back-link').addEventListener('click', async (e) => {
      e.preventDefault();
      const result = await window.api.setup.listProjects(token);
      if (result.ok) showProjectPicker(token, result.projects);
      else showSetup();
    });

    $('#details-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      setError('');
      let owner = null;
      if (needsOwner) {
        owner = {
          fullName: $('#owner-name').value,
          email: $('#owner-email').value.trim(),
          password: $('#owner-password').value,
        };
        if (!owner.email) return setError('Enter your email.');
        if (owner.password.length < 8) return setError('Your password must be at least 8 characters.');
        if (owner.password !== $('#owner-confirm').value) return setError('The passwords do not match.');
      }

      const done = busy($('#details-submit'), 'Working…');
      $('#back-link').hidden = true;
      if (unsubscribeProgress) unsubscribeProgress();
      unsubscribeProgress = window.api.setup.onProgress((message) => {
        const line = $('#setup-progress');
        if (line) line.textContent = message;
      });

      const result = await window.api.setup.run({
        token,
        ref: project.ref,
        name: $('#setup-name').value.trim(),
        owner,
      });
      unsubscribeProgress();
      unsubscribeProgress = null;

      if (!result.ok) {
        done();
        $('#back-link').hidden = false;
        $('#setup-progress').textContent = '';
        setError(result.error);
        return;
      }
      showSetupDone(result, owner && owner.email);
    });
  }

  function showSetupDone(result, ownerEmail) {
    frame(`
      <p class="login-sub">${result.alreadySetUp ? 'Database updated' : 'Your database is ready'}</p>
      <p class="muted small">
        ${result.updatedTables ? `The database's tables were updated (${result.updatedTables} change${result.updatedTables === 1 ? '' : 's'}). ` : ''}
        ${result.createdOwner ? 'Your owner account has been created. ' : ''}
        You can now delete the access token at
        <a href="#" data-ext-link="${TOKEN_URL}">Account → Access Tokens</a> — BookBin did not keep it.
      </p>
      <button class="login-submit" id="continue-btn" type="button">Continue to sign in</button>
    `, { wide: true });
    $('#continue-btn').addEventListener('click', async () => {
      const opened = await window.api.databases.open(result.databaseId);
      if (!opened.ok) {
        showList(opened.error);
        return;
      }
      window.CurrentDatabase = opened.database;
      if (opened.profile) onSignedIn(opened.profile);
      else showLogin(null, ownerEmail);
    });
  }

  // ------------------------------------------------------------ sign-in

  let submitting = false;

  function showLogin(errorMessage, prefillEmail) {
    const db = window.CurrentDatabase;
    if (!db) {
      showList();
      return;
    }
    submitting = false;
    frame(`
      <p class="login-sub">Sign in to <strong>${escapeHtml(db.name)}</strong></p>
      <form id="login-form" autocomplete="on" novalidate>
        <label class="login-label" for="login-email">Email</label>
        <input class="login-input" id="login-email" name="email" type="email"
               autocomplete="username" required value="${escapeHtml(prefillEmail || '')}" />

        <label class="login-label" for="login-password">Password</label>
        <input class="login-input" id="login-password" name="password" type="password"
               autocomplete="current-password" required />

        <div class="login-error" id="launcher-error" role="alert" aria-live="polite">${
          errorMessage ? escapeHtml(errorMessage) : ''
        }</div>

        <button class="login-submit" id="login-submit" type="submit">Sign in</button>
      </form>
      <div class="launcher-links"><a href="#" id="other-db">← Choose a different database</a></div>
    `);

    $('#login-form').addEventListener('submit', onSubmitLogin);
    $('#other-db').addEventListener('click', async (e) => {
      e.preventDefault();
      await window.api.databases.close();
      showList();
    });
    (prefillEmail ? $('#login-password') : $('#login-email')).focus();
  }

  function setSubmitting(value) {
    submitting = value;
    const button = $('#login-submit');
    if (button) {
      button.disabled = value;
      button.textContent = value ? 'Signing in…' : 'Sign in';
    }
    ['#login-email', '#login-password'].forEach((sel) => {
      const field = $(sel);
      if (field) field.disabled = value;
    });
  }

  async function onSubmitLogin(event) {
    event.preventDefault();
    if (submitting) return;

    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (!email || !password) {
      setError('Enter both an email and a password.');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      const result = await window.api.auth.signIn(email, password);
      if (!result.ok) {
        setSubmitting(false);
        setError(result.error);
        const passwordField = $('#login-password');
        passwordField.value = '';
        passwordField.focus();
        return;
      }
      // On success the main process broadcasts auth:changed, and app.js swaps
      // the view. Deliberately leave the button disabled until that happens so
      // a second click cannot fire another sign-in.
    } catch (err) {
      setSubmitting(false);
      setError('Something went wrong signing in. Please try again.');
      console.error('sign-in failed', err);
    }
  }

  window.Launcher = {
    // app.js hands over what to do once somebody is signed in.
    init(handler) {
      onSignedIn = handler;
    },
    showList,
    showLogin,
  };
})();

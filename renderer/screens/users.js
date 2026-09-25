window.Screens = window.Screens || {};

// Accounts and passwords, all in one place.
//
// Everyone sees their own account here and can change their own password.
// Owners also see everybody else's, behind a lock: nothing can be changed
// until they re-enter their own password, and it locks again after a few
// minutes, on leaving this page, or on signing out -- so a window left open is
// not a window open to account changes.
//
// Nothing here is a security control. The lock is kept and enforced in the
// main process, which refuses a change while locked whatever this page does;
// the database refuses a role change from a non-owner, and the Edge Function
// refuses to create, delete, or set a password for one. If this file disagreed
// with them, they would win.
window.Screens.users = async function renderUsers(container) {
  const profile = window.CurrentProfile;
  const isOwner = !!profile && profile.role === 'owner';
  const { escapeHtml, showModal, hideModal, confirmAction, qs, qsa } = window.Helpers;

  let users = [];
  let lock = { unlocked: false, remainingMs: 0 };
  let lockTimer = null;
  let lockError = '';

  async function load() {
    if (isOwner) {
      [users, lock] = await Promise.all([window.api.users.list(), window.api.users.lockStatus()]);
    }
    render();
  }

  function roleLabel(role) {
    return role === 'owner' ? 'Owner' : 'Manager';
  }

  function formatRemaining(ms) {
    const total = Math.ceil(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // Counts down locally for display, and re-draws as locked when it runs
  // out. The main process keeps its own clock; this one only has to agree
  // closely enough that the buttons are not offered after they would fail.
  function startLockTimer() {
    stopLockTimer();
    if (!lock.unlocked) return;
    const endsAt = Date.now() + lock.remainingMs;
    lockTimer = setInterval(() => {
      if (!document.body.contains(container) || !qs('#lock-countdown', container)) {
        stopLockTimer();
        return;
      }
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        lock = { unlocked: false, remainingMs: 0 };
        stopLockTimer();
        render();
        return;
      }
      qs('#lock-countdown', container).textContent = formatRemaining(remaining);
    }, 1000);
  }

  function stopLockTimer() {
    if (lockTimer) clearInterval(lockTimer);
    lockTimer = null;
  }

  function accountCardHtml() {
    return `
      <form id="password-form" class="card">
        <h2>Your Account</h2>
        <p class="muted small">
          Signed in as <strong>${escapeHtml(profile.fullName || profile.email)}</strong>
          (${escapeHtml(profile.email)}), ${roleLabel(profile.role).toLowerCase()}.
        </p>
        <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required /></label>
        <label>New password<input name="newPassword" type="password" autocomplete="new-password" required minlength="8" /></label>
        <label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="8" /></label>
        <div class="form-error" id="password-error" role="alert"></div>
        <div class="modal-actions">
          <button type="submit" class="btn primary" id="password-submit">Change Password</button>
        </div>
        <p id="password-confirmation" class="muted" hidden>Password changed.</p>
      </form>
    `;
  }

  function lockBarHtml() {
    if (lock.unlocked) {
      return `
        <div class="lock-bar unlocked">
          <span class="lock-text">🔓 Unlocked — locks again in <strong id="lock-countdown">${formatRemaining(lock.remainingMs)}</strong></span>
          <button type="button" class="btn small" id="lock-now">Lock now</button>
        </div>
      `;
    }
    return `
      <div class="lock-bar">
        <span class="lock-text">🔒 Enter your password to add, remove or change accounts.</span>
        <form id="unlock-form">
          <input name="password" type="password" autocomplete="current-password" placeholder="Your password" required />
          <button type="submit" class="btn primary small" id="unlock-btn">Unlock</button>
        </form>
      </div>
      ${lockError ? `<p class="form-error">${escapeHtml(lockError)}</p>` : ''}
    `;
  }

  function accountsCardHtml() {
    const locked = !lock.unlocked;
    const disabled = locked ? 'disabled' : '';
    return `
      <section class="card">
        <div class="page-header">
          <h2 style="margin: 0;">All Accounts</h2>
          <button class="btn primary" id="new-user" ${disabled}>+ New User</button>
        </div>
        ${lockBarHtml()}
        <p class="muted small">
          Owners can add and remove accounts, change roles, and set other users'
          passwords. Managers can edit everything else in BookBin but cannot
          touch accounts.
        </p>
        <table>
          <thead><tr>
            <th>Name</th><th>Email</th><th>Role</th><th></th>
          </tr></thead>
          <tbody>
            ${users
              .map((u) => `
                <tr>
                  <td>${escapeHtml(u.fullName || '—')}${u.isSelf ? ' <span class="muted">(you)</span>' : ''}</td>
                  <td>${escapeHtml(u.email || '')}</td>
                  <td>${roleLabel(u.role)}</td>
                  <td class="actions"><div class="actions-row">
                    <button class="btn small" data-role="${u.id}" data-current="${u.role}" ${disabled}>
                      Make ${u.role === 'owner' ? 'Manager' : 'Owner'}
                    </button>
                    <button class="btn small" data-password="${u.id}" ${locked || u.isSelf ? 'disabled' : ''}
                      ${u.isSelf ? 'title="Change your own password under Your Account"' : ''}>
                      Set Password
                    </button>
                    <button class="btn small danger" data-delete="${u.id}" ${locked || u.isSelf ? 'disabled' : ''}>
                      Remove
                    </button>
                  </div></td>
                </tr>
              `)
              .join('')}
          </tbody>
        </table>
      </section>
    `;
  }

  function render() {
    container.innerHTML = `
      <div class="page-header"><h1>Users</h1></div>
      ${accountCardHtml()}
      ${isOwner ? accountsCardHtml() : ''}
    `;

    wirePasswordForm();
    if (!isOwner) return;

    const unlockForm = qs('#unlock-form', container);
    if (unlockForm) {
      unlockForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const button = qs('#unlock-btn', container);
        button.disabled = true;
        button.textContent = 'Checking…';
        const result = await window.api.users.unlock(new FormData(e.target).get('password'));
        if (!result.ok) {
          lockError = result.error;
          render();
          qs('#unlock-form input', container).focus();
          return;
        }
        lockError = '';
        lock = { unlocked: result.unlocked, remainingMs: result.remainingMs };
        render();
      });
    }
    const lockNow = qs('#lock-now', container);
    if (lockNow) {
      lockNow.addEventListener('click', async () => {
        lock = await window.api.users.lock();
        render();
      });
    }

    qs('#new-user', container).addEventListener('click', openForm);
    qsa('[data-role]', container).forEach((btn) =>
      btn.addEventListener('click', () =>
        onChangeRole(btn.dataset.role, btn.dataset.current === 'owner' ? 'manager' : 'owner')
      )
    );
    qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', () => onDelete(btn.dataset.delete))
    );
    qsa('[data-password]', container).forEach((btn) =>
      btn.addEventListener('click', () => openPasswordForm(btn.dataset.password))
    );
    startLockTimer();
  }

  function wirePasswordForm() {
    qs('#password-form', container).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const errorBox = qs('#password-error', container);
      const submit = qs('#password-submit', container);
      errorBox.textContent = '';

      const currentPassword = form.get('currentPassword');
      const newPassword = form.get('newPassword');

      // Checked here as well as in the fields: matching is the one rule the
      // browser's own validation cannot express.
      if (newPassword !== form.get('confirmPassword')) {
        errorBox.textContent = 'The new passwords do not match.';
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Changing…';
      const result = await window.api.auth.changePassword(currentPassword, newPassword);
      submit.disabled = false;
      submit.textContent = 'Change Password';

      if (!result.ok) {
        errorBox.textContent = result.error;
        return;
      }

      // Cleared rather than left filled: the fields hold the password in
      // plain text, and there is nothing left to do with them.
      e.target.reset();
      const confirmation = qs('#password-confirmation', container);
      confirmation.hidden = false;
      setTimeout(() => { confirmation.hidden = true; }, 3000);
    });
  }

  // A change refused because the lock ran out while a dialog was open: say
  // so, and redraw with the lock showing rather than leaving live buttons.
  async function handleFailure(result, errorBox) {
    if (result.locked) {
      hideModal();
      lock = { unlocked: false, remainingMs: 0 };
      lockError = result.error;
      render();
      return;
    }
    if (errorBox) errorBox.textContent = result.error;
    else await confirmAction(result.error);
  }

  // Twelve characters from an alphabet with no lookalikes (0/O, 1/l/I), since
  // the owner will be reading it out or writing it down for someone.
  function generatePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint32Array(12));
    return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
  }

  function openPasswordForm(userId) {
    const user = users.find((u) => u.id === userId);
    if (!user) return;
    const name = user.fullName || user.email;

    // Shown as plain text: the owner has to pass it on, and a masked field
    // with a confirm box would just invite a typo nobody can see.
    const modal = showModal(`
      <h2>Set Password</h2>
      <p class="muted small">
        Sets a new password for <strong>${escapeHtml(name)}</strong>. Their old one
        stops working. BookBin does not send email, so give it to them directly.
      </p>
      <form id="set-password-form">
        <label>New password
          <div style="display: flex; gap: 8px; align-items: center;">
            <input name="password" type="text" autocomplete="off" spellcheck="false" required minlength="8" style="flex: 1;" />
            <button type="button" class="btn" id="generate-btn" style="flex: none;">Generate</button>
          </div>
        </label>
        <div class="form-error" id="set-password-error" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary" id="save-btn">Set Password</button>
        </div>
      </form>
    `);

    const input = qs('input[name="password"]', modal);
    input.focus();
    qs('#generate-btn', modal).addEventListener('click', () => {
      input.value = generatePassword();
      input.select();
    });
    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#set-password-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorBox = qs('#set-password-error', modal);
      const saveBtn = qs('#save-btn', modal);
      errorBox.textContent = '';
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      const result = await window.api.users.setPassword(userId, input.value);
      if (!result.ok) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Set Password';
        await handleFailure(result, errorBox);
        return;
      }
      hideModal();
      await confirmAction(`${name}'s password has been changed.`);
    });
  }

  function openForm() {
    const modal = showModal(`
      <h2>New User</h2>
      <form id="user-form">
        <label>Full Name<input name="fullName" /></label>
        <label>Email<input name="email" type="email" required /></label>
        <label>Password<input name="password" type="password" required minlength="8" /></label>
        <p class="muted small">
          At least 8 characters. Give it to them directly — BookBin does not
          send email, so nothing is delivered to this address.
        </p>
        <label>Role
          <select name="role">
            <option value="manager" selected>Manager</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <div class="form-error" id="user-error" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-btn">Cancel</button>
          <button type="submit" class="btn primary" id="save-btn">Create</button>
        </div>
      </form>
    `);

    qs('#cancel-btn', modal).addEventListener('click', hideModal);
    qs('#user-form', modal).addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorBox = qs('#user-error', modal);
      const saveBtn = qs('#save-btn', modal);
      errorBox.textContent = '';
      saveBtn.disabled = true;
      saveBtn.textContent = 'Creating…';

      const payload = Object.fromEntries(new FormData(e.target).entries());
      const result = await window.api.users.create(payload);

      if (!result.ok) {
        // Kept open with the fields intact: retyping a password because the
        // email was already taken is a pointless punishment.
        saveBtn.disabled = false;
        saveBtn.textContent = 'Create';
        await handleFailure(result, errorBox);
        return;
      }
      hideModal();
      load();
    });
  }

  async function onChangeRole(userId, newRole) {
    const user = users.find((u) => u.id === userId);
    const name = (user && (user.fullName || user.email)) || 'this user';
    const warning = user && user.isSelf && newRole === 'manager'
      ? ' You will no longer be able to manage accounts.'
      : '';
    if (!(await confirmAction(`Make ${name} ${newRole === 'owner' ? 'an owner' : 'a manager'}?${warning}`))) {
      return;
    }
    const result = await window.api.users.setRole(userId, newRole);
    if (!result.ok) {
      await handleFailure(result);
      return;
    }
    // Demoting yourself changes what this page, and the sidebar, should show.
    if (user && user.isSelf) {
      await window.api.auth.refresh();
      return;
    }
    load();
  }

  async function onDelete(userId) {
    const user = users.find((u) => u.id === userId);
    const name = (user && (user.fullName || user.email)) || 'this user';
    if (!(await confirmAction(`Remove ${name}? They will no longer be able to sign in.`))) return;
    const result = await window.api.users.delete(userId);
    if (!result.ok) {
      await handleFailure(result);
      return;
    }
    load();
  }

  await load();
};

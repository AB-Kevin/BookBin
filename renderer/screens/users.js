window.Screens = window.Screens || {};

// Account management, shown only to owners.
//
// Nothing here is a security control. The nav link is hidden from managers and
// this screen would refuse to draw for one, but both are conveniences: the
// database refuses a role change from a non-owner, and the Edge Function
// refuses to create or delete an account for one. If this file disagreed with
// them, they would win.
window.Screens.users = async function renderUsers(container) {
  const profile = window.CurrentProfile;
  const { escapeHtml, showModal, hideModal, confirmAction, qs, qsa } = window.Helpers;

  if (!profile || profile.role !== 'owner') {
    container.innerHTML = `
      <h1>Users</h1>
      <section class="card"><p class="muted">Only an owner can manage accounts.</p></section>
    `;
    return;
  }

  let users = [];

  async function load() {
    users = await window.api.users.list();
    render();
  }

  function roleLabel(role) {
    return role === 'owner' ? 'Owner' : 'Manager';
  }

  function render() {
    container.innerHTML = `
      <div class="page-header">
        <h1>Users</h1>
        <button class="btn primary" id="new-user">+ New User</button>
      </div>
      <section class="card">
        <p class="muted small">
          Owners can add and remove accounts and change roles. Managers can edit
          everything else in BookBin but cannot touch accounts.
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
                    <button class="btn small" data-role="${u.id}" data-current="${u.role}">
                      Make ${u.role === 'owner' ? 'Manager' : 'Owner'}
                    </button>
                    <button class="btn small danger" data-delete="${u.id}" ${u.isSelf ? 'disabled' : ''}>
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

    qs('#new-user', container).addEventListener('click', openForm);
    qsa('[data-role]', container).forEach((btn) =>
      btn.addEventListener('click', () =>
        onChangeRole(btn.dataset.role, btn.dataset.current === 'owner' ? 'manager' : 'owner')
      )
    );
    qsa('[data-delete]', container).forEach((btn) =>
      btn.addEventListener('click', () => onDelete(btn.dataset.delete))
    );
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
        errorBox.textContent = result.error;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Create';
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
      ? ' You will lose access to this screen.'
      : '';
    if (!(await confirmAction(`Make ${name} ${newRole === 'owner' ? 'an owner' : 'a manager'}?${warning}`))) {
      return;
    }
    const result = await window.api.users.setRole(userId, newRole);
    if (!result.ok) {
      await confirmAction(result.error);
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
      await confirmAction(result.error);
      return;
    }
    load();
  }

  await load();
};

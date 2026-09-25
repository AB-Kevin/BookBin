// Account management, for owners.
//
// Listing and role changes go straight to the database, where the policies
// decide: staff may read the roster, only an owner may change a role, and
// set_user_role() refuses anyone else regardless of what this file does.
//
// Creating and deleting accounts need Supabase's admin API and therefore the
// service_role key, which cannot ship in the app. Those two go through the
// manage-users Edge Function, which re-checks the caller is an owner before
// touching anything.

const { getSupabase } = require('../db/supabase');
const { table, unwrap } = require('../db/rest');

const PROFILE_COLUMNS = 'id, email, full_name, role, created_at';

// functions.invoke reports a non-2xx as a generic FunctionsHttpError, with the
// actual message left in the response body. Digging it out is the difference
// between "An account with that email already exists" and "Edge Function
// returned a non-2xx status code".
//
// A reply is only a success if it says so. An absent error is not enough:
// anything that returns 200 without confirming what it did -- a stub, a
// proxy, a misrouted request -- would otherwise be reported as an account
// created, closing the dialog and leaving nothing behind.
async function invokeManageUsers(body) {
  const { data, error } = await getSupabase().functions.invoke('manage-users', { body });

  if (!error) {
    if (data && data.ok === true) return data;
    throw new Error(
      'The server did not confirm that it worked. Check the manage-users ' +
      'function is deployed, then look at its logs.'
    );
  }

  const status = (error.context && error.context.status) || 0;
  let message = error.message;
  try {
    if (error.context && typeof error.context.json === 'function') {
      const details = await error.context.json();
      if (details && details.error) message = details.error;
    }
  } catch (err) {
    // Body was not JSON; the generic message is all there is.
  }

  // Match on the status, not the message: the generic text says only that the
  // status was not 2xx, so a missing function reads like any other failure.
  if (status === 404) {
    message = 'Account management is not set up on the server yet — the manage-users function is not deployed.';
  } else if (/Failed to fetch|fetch failed|network/i.test(message)) {
    message = 'Cannot reach the server. Check your internet connection.';
  }
  throw new Error(message);
}

module.exports = function registerUsers(ipcMain, getProfile) {
  ipcMain.handle('users:list', async () => {
    const rows = unwrap(
      await table('profiles').select(PROFILE_COLUMNS).order('created_at', { ascending: true })
    );
    const me = getProfile();
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      createdAt: row.created_at,
      isSelf: !!me && me.id === row.id,
    }));
  });

  ipcMain.handle('users:create', async (_e, data) => {
    try {
      const result = await invokeManageUsers({
        action: 'create',
        email: data.email,
        password: data.password,
        fullName: data.fullName,
        role: data.role,
      });
      return { ok: true, user: result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('users:delete', async (_e, userId) => {
    try {
      await invokeManageUsers({ action: 'delete', userId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('users:setRole', async (_e, userId, role) => {
    const { error } = await getSupabase().rpc('set_user_role', {
      target_user: userId,
      new_role: role,
    });
    if (error) {
      // The database raises these, so they arrive already phrased for a person.
      return { ok: false, error: error.message };
    }
    return { ok: true };
  });
};

// Account management, for owners.
//
// Every change needs the owner to have re-entered their own password within
// the last few minutes -- see requireUnlocked below.
//
// Listing and role changes go straight to the database, where the policies
// decide: staff may read the roster, only an owner may change a role, and
// set_user_role() refuses anyone else regardless of what this file does.
//
// Creating and deleting accounts, and setting another user's password, need
// Supabase's admin API and therefore the service_role key, which cannot ship
// in the app. Those go through the
// manage-users Edge Function, which re-checks the caller is an owner before
// touching anything.

const { getSupabase, getCurrentDatabase } = require('../db/supabase');
const { table, unwrap } = require('../db/rest');
const { describeConnectionFailure } = require('../db/errors');

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
  } else {
    const connection = describeConnectionFailure(error);
    if (connection) message = connection;
  }
  throw new Error(message);
}

// How long an owner's password unlocks account management for. Short on
// purpose: the point is that a window left open does not stay open to account
// changes for the rest of the day.
const UNLOCK_MS = 5 * 60 * 1000;

module.exports = function registerUsers(ipcMain, { getProfile, verifyPassword }) {
  // Kept here, in the main process, not in the page. The page shows a lock
  // and a countdown, but it is this check that refuses a change: the page's
  // JavaScript can be poked at, and this cannot be reached except through
  // the handlers below.
  let unlockedUntil = 0;
  let unlockedFor = null;

  function whoIsSignedIn() {
    const me = getProfile();
    const db = getCurrentDatabase();
    return me && db ? `${db.id}:${me.id}` : null;
  }

  function lock() {
    unlockedUntil = 0;
    unlockedFor = null;
  }

  function lockStatus() {
    const who = whoIsSignedIn();
    const remainingMs = who && who === unlockedFor ? Math.max(0, unlockedUntil - Date.now()) : 0;
    return { unlocked: remainingMs > 0, remainingMs };
  }

  // Every account change goes through this first. The database and the Edge
  // Function still check the caller is an owner; this adds "and has just
  // proved it is really them".
  function requireUnlocked() {
    const me = getProfile();
    if (!me || me.role !== 'owner') throw new Error('Only an owner can manage accounts.');
    if (!lockStatus().unlocked) {
      throw new Error('User management has locked again. Enter your password to unlock it.');
    }
  }

  // Wraps a handler so it refuses while locked and reports failures as
  // { ok: false, error } like the rest of this screen's calls.
  function guarded(handler) {
    return async (...args) => {
      try {
        requireUnlocked();
        return await handler(...args);
      } catch (err) {
        return { ok: false, error: err.message, locked: !lockStatus().unlocked };
      }
    };
  }

  ipcMain.handle('users:lockStatus', () => lockStatus());

  ipcMain.handle('users:unlock', async (_e, password) => {
    const me = getProfile();
    if (!me || me.role !== 'owner') return { ok: false, error: 'Only an owner can manage accounts.' };
    const check = await verifyPassword(me.email, password);
    if (!check.ok) return { ok: false, error: check.connection || 'That password is not correct.' };
    unlockedFor = whoIsSignedIn();
    unlockedUntil = Date.now() + UNLOCK_MS;
    return { ok: true, ...lockStatus() };
  });

  ipcMain.handle('users:lock', () => {
    lock();
    return lockStatus();
  });

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

  ipcMain.handle('users:create', guarded(async (_e, data) => {
    const result = await invokeManageUsers({
      action: 'create',
      email: data.email,
      password: data.password,
      fullName: data.fullName,
      role: data.role,
    });
    return { ok: true, user: result };
  }));

  ipcMain.handle('users:delete', guarded(async (_e, userId) => {
    await invokeManageUsers({ action: 'delete', userId });
    return { ok: true };
  }));

  ipcMain.handle('users:setPassword', guarded(async (_e, userId, password) => {
    try {
      await invokeManageUsers({ action: 'setPassword', userId, password });
    } catch (err) {
      // An older function is deployed and answers, but has never heard of this.
      if (/unknown action/i.test(err.message)) {
        throw new Error(
          'The manage-users function on the server is out of date. Update it with ' +
          '"Set up a new database" on the start screen, or redeploy it by hand.'
        );
      }
      throw err;
    }
    return { ok: true };
  }));

  ipcMain.handle('users:setRole', guarded(async (_e, userId, role) => {
    const { error } = await getSupabase().rpc('set_user_role', {
      target_user: userId,
      new_role: role,
    });
    // The database raises these, so they arrive already phrased for a person.
    if (error) throw new Error(error.message);
    return { ok: true };
  }));

  return { lock };
};

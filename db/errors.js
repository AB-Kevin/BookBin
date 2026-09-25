// Working out why BookBin cannot reach its database, and saying so accurately.
//
// Every failure used to read "Check your internet connection", which is a
// confident answer to a question nobody asked. A free Supabase project pauses
// itself after about a week without use, and when that happens the app is
// working perfectly, the connection is fine, and the advice is wrong.
//
// The useful discriminator is whether a reply came back at all:
//
//   a status code   -- something answered, so the network is fine and the
//                      problem is at the other end
//   no reply        -- could be either, so say so rather than guessing

const PAUSED =
  'The BookBin database is paused. Free Supabase projects pause after about ' +
  'a week without use — an owner can resume it from the Supabase dashboard.';

const SERVER_ERROR =
  'The BookBin database is not responding. If this lasts, check the Supabase ' +
  'dashboard for the project status.';

const UNREACHABLE =
  'Cannot reach the BookBin database. Check your internet connection — and if ' +
  'it is fine, the database may be paused, which an owner can resume from the ' +
  'Supabase dashboard.';

function statusOf(error) {
  if (!error) return 0;
  if (typeof error.status === 'number') return error.status;
  if (error.context && typeof error.context.status === 'number') return error.context.status;
  return 0;
}

function isNetworkFailure(message) {
  return /fetch failed|failed to fetch|network|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i
    .test(String(message || ''));
}

/**
 * Returns a readable explanation, or null when this is not a connection
 * problem at all and the caller should keep its own message.
 */
function describeConnectionFailure(error) {
  const status = statusOf(error);
  const message = String((error && error.message) || error || '');

  // Supabase answers for a paused project at the gateway rather than the
  // database, so the exact code has moved about between 503, 540 and 544.
  // Matching the word as well means a change of code is not a change of
  // behaviour here.
  if (/paused|project is not active/i.test(message)) return PAUSED;
  if (status === 503 || status === 540 || status === 544) return PAUSED;
  if (status >= 500) return SERVER_ERROR;

  // No status at all: the request never got an answer.
  if (!status && isNetworkFailure(message)) return UNREACHABLE;

  return null;
}

module.exports = { describeConnectionFailure, isNetworkFailure, PAUSED, SERVER_ERROR, UNREACHABLE };

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

// A database entry pointed at the wrong address fails on the first request
// with a PostgREST routing error, which names a code and a path and nothing a
// person can act on. Saying which address is in use turns it into a fixable
// fact.
function configuredUrl() {
  try {
    const db = require('./supabase').getCurrentDatabase();
    return db && db.url;
  } catch (err) {
    return null;
  }
}

function wrongAddressMessage() {
  const url = configuredUrl();
  return (
    'BookBin is pointed at the wrong address' + (url ? ` (${url})` : '') + '. ' +
    'The address should be just the project origin, with no /rest/v1 or ' +
    'other path on the end. Remove the database from the list and add it again.'
  );
}

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

// Requests go through Electron's net.fetch, which fails with Chromium's codes
// (net::ERR_NAME_NOT_RESOLVED and so on). The Node codes stay for dev runs
// and for anything that still reaches the network some other way.
const NETWORK_CODE =
  /net::ERR_[A-Z0-9_]+|\b(?:ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ECONNRESET|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED)\b/;

function isNetworkFailure(message) {
  const text = String(message || '');
  return NETWORK_CODE.test(text) || /fetch failed|failed to fetch|network/i.test(text);
}

// The code that says what actually went wrong is rarely on the error the
// caller holds: supabase-js wraps it, and each sub-client in its own place --
// functions under `context`, storage under `originalError`, Node under
// `cause`. Without it a report from somebody else's machine says only
// "cannot reach", which is where every diagnosis has to start from scratch.
function networkCode(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length) {
    const e = queue.shift();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    const found = String(e.message || (typeof e === 'string' ? e : '')).match(NETWORK_CODE);
    if (found) return found[0];
    if (typeof e.code === 'string' && NETWORK_CODE.test(e.code)) return e.code;
    if (typeof e === 'object') queue.push(e.cause, e.context, e.originalError);
  }
  return null;
}

function unreachableMessage(code) {
  if (!code) return UNREACHABLE;
  let text = UNREACHABLE;
  // A certificate failure means something did answer, so "paused" and "check
  // your connection" are both the wrong lead.
  if (/DATE_INVALID|EXPIRED/.test(code)) {
    text = 'Cannot open a secure connection to the BookBin database. Check that ' +
      "this computer's date and time are correct.";
  } else if (/CERT|SSL|SIGNATURE/.test(code)) {
    text = 'Cannot open a secure connection to the BookBin database. Something ' +
      'on this computer or network — often an antivirus program\'s web ' +
      'protection — is interfering with it.';
  }
  return `${text} (Details: ${code})`;
}

/**
 * Returns a readable explanation, or null when this is not a connection
 * problem at all and the caller should keep its own message.
 */
function describeConnectionFailure(error) {
  const status = statusOf(error);
  const message = String((error && error.message) || error || '');
  const code = (error && error.code) || '';

  // PGRST125 is PostgREST saying the path it was handed is not one of its
  // routes -- in practice, a URL with an extra path segment baked in.
  if (code === 'PGRST125' || /invalid path specified in request url/i.test(message)) {
    return wrongAddressMessage();
  }

  // Supabase answers for a paused project at the gateway rather than the
  // database, so the exact code has moved about between 503, 540 and 544.
  // Matching the word as well means a change of code is not a change of
  // behaviour here.
  if (/paused|project is not active/i.test(message)) return PAUSED;
  if (status === 503 || status === 540 || status === 544) return PAUSED;
  if (status >= 500) return SERVER_ERROR;

  // No status at all: the request never got an answer.
  if (!status) {
    const detail = networkCode(error);
    if (detail || isNetworkFailure(message)) {
      console.error('BookBin: request got no reply —', detail || message);
      return unreachableMessage(detail);
    }
  }

  return null;
}

module.exports = {
  describeConnectionFailure,
  isNetworkFailure,
  networkCode,
  wrongAddressMessage,
  PAUSED,
  SERVER_ERROR,
  UNREACHABLE,
};

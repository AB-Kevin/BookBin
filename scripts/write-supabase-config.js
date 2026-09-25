#!/usr/bin/env node
// Bakes the Supabase URL and anon key into the app at package time.
//
// A packaged build has no .env beside it and no environment variables set, so
// the values have to be written to a file that electron-builder bundles. This
// runs from the dist/release npm scripts, before electron-builder.
//
// It refuses to write a service_role key. That key bypasses every row-level
// security policy in the database, and shipping one inside a desktop app --
// where any user can unpack the asar and read it -- would hand complete
// control of the data to anyone who installs BookBin. It is an easy key to
// grab by mistake, since it sits directly below the anon key on the same
// dashboard page, so the check is here rather than in a comment nobody reads.

const fs = require('fs');
const path = require('path');

const { normalizeUrl } = require('../config/supabase');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'config', 'supabase.generated.json');

function readEnvFile() {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch (err) {
    return {};
  }
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      if (value[0] === value[value.length - 1]) value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

// Supabase has issued keys in two shapes: the newer sb_publishable_ /
// sb_secret_ prefixes, and older JWTs carrying a "role" claim. Check both.
function looksLikeServiceKey(key) {
  if (key.startsWith('sb_secret_')) return true;

  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.role === 'service_role';
  } catch (err) {
    return false;
  }
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const env = readEnvFile();
const pick = (name) => process.env[name] || env[name] || '';

const rawUrl = pick('SUPABASE_URL');
const url = normalizeUrl(rawUrl);
// Either name works: Supabase is mid-migration from the legacy anon JWT to
// sb_publishable_ keys, and which one appears on the dashboard depends on how
// old the project is.
const publishableKey = pick('SUPABASE_PUBLISHABLE_KEY') || pick('SUPABASE_ANON_KEY');

if (!url || !publishableKey) {
  const missing = [!url && 'SUPABASE_URL', !publishableKey && 'SUPABASE_PUBLISHABLE_KEY']
    .filter(Boolean)
    .join(' and ');
  fail(
    `Cannot build: ${missing} not set.\n` +
    '  Locally, copy .env.example to .env and fill it in.\n' +
    '  In CI, add them as repository secrets and pass them to the build step.'
  );
}

if (looksLikeServiceKey(publishableKey)) {
  fail(
    'Refusing to build: that key looks like a secret / service_role key.\n' +
    '  That key ignores row-level security, and packaging it would give\n' +
    '  anyone who installs BookBin full read/write access to the database.\n' +
    '  Use the publishable (anon) key from Settings -> API instead.'
  );
}

// Anchored at both ends: the old pattern checked only the start, so the REST
// endpoint from the dashboard passed validation and shipped an app that could
// not sign in. normalizeUrl has already dropped any path by this point, so
// this now only rejects an address that is not a Supabase project at all.
if (!/^https:\/\/[a-z0-9-]+\.supabase\.[a-z.]+$/i.test(url)) {
  fail(`Refusing to build: SUPABASE_URL does not look like a Supabase project URL:\n  ${rawUrl}`);
}

// Loud, but not fatal: the value works once the path is dropped, and a build
// that fails here is a release somebody has to run twice.
if (String(rawUrl).trim() !== url) {
  console.warn(
    `\n  Note: SUPABASE_URL was given as\n    ${String(rawUrl).trim()}\n` +
    `  and has been reduced to the project origin\n    ${url}\n` +
    '  Only the origin belongs here — the /rest/v1 endpoint shown on the\n' +
    '  dashboard sends every request down a wrong path.\n'
  );
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify({ url, publishableKey }, null, 2) + '\n', 'utf8');

console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} for ${url}`);

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
const url = process.env.SUPABASE_URL || env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  const missing = [!url && 'SUPABASE_URL', !anonKey && 'SUPABASE_ANON_KEY']
    .filter(Boolean)
    .join(' and ');
  fail(
    `Cannot build: ${missing} not set.\n` +
    '  Locally, copy .env.example to .env and fill it in.\n' +
    '  In CI, add them as repository secrets and pass them to the build step.'
  );
}

if (looksLikeServiceKey(anonKey)) {
  fail(
    'Refusing to build: SUPABASE_ANON_KEY looks like a service_role key.\n' +
    '  That key ignores row-level security, and packaging it would give\n' +
    '  anyone who installs BookBin full read/write access to the database.\n' +
    '  Use the anon (publishable) key from Settings -> API instead.'
  );
}

if (!/^https:\/\/[a-z0-9-]+\.supabase\./i.test(url)) {
  fail(`Refusing to build: SUPABASE_URL does not look like a Supabase URL:\n  ${url}`);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify({ url, anonKey }, null, 2) + '\n', 'utf8');

console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} for ${url}`);

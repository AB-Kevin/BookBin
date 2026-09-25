# BookBin

A desktop app for recording incoming (purchase) invoices, tracking inventory
off of them, and producing outgoing (sales) invoices as PDFs. Electron on the
front, Postgres (via Supabase) behind it, so several people can work in the
same books at once.

BookBin opens to a list of databases. Pick one, then sign in to it. Updates
are offered on that screen, so installing one never needs an account. There
are two kinds of account: **owners**, who can create and remove accounts,
change roles and set other people's passwords, and **managers**, who can edit
everything else but cannot touch accounts. All of that is on the Users page.
Owners re-enter their own password there before changing anything, and it
locks again after five minutes.

## Setup

```
npm install
```

The `.env` described below is optional. It names the database that a build
offers on first launch, and every other database is added in the app. To make
one, create a `.env` in the repo root (copy `.env.example`) with the values
from your Supabase project under **Settings → API** and **Settings → Data
API**. `SUPABASE_URL` is the project origin — `https://<ref>.supabase.co` —
**not** the RESTful endpoint shown beside it, which ends in `/rest/v1` and
sends every request down a wrong path:

```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

`.env` is gitignored, and this repo is public. Use the **publishable** (or
legacy anon) key — never the secret / `service_role` key. That one bypasses
every security policy in the database; the build refuses to package it.

```
npm run config   # checks the values resolve
npm start
```

## Setting up a Supabase project from scratch

The easy way is in the app. Create an empty project at supabase.com, then on
BookBin's start screen choose **Set up a new one** and paste a personal access
token (supabase.com → Account → Access Tokens). BookBin then:

- creates the tables,
- deploys `manage-users`,
- turns off public sign-ups,
- creates your owner account,
- adds the database to the list.

The token is used for that one run and never saved, so delete it afterwards.
Running setup against a project that already has BookBin's tables leaves the
tables alone and only updates the function and the sign-up setting. That also
makes it the simplest way to deploy a newer `manage-users`.

Other computers join with **Add a database**, using the project URL and
publishable key or a connection code, which is under ⋯ → Connection code on
any start screen that already has the database.

By hand, run these in the SQL Editor, in order:

1. `supabase/migrations/*.sql` — schema, security policies, and the functions
   that make multi-statement operations atomic.
2. `supabase/verify.sql` — confirms row-level security is on everywhere and
   the security functions exist. Everything should say `PASS`.

Then:

3. **Authentication → Providers → Email**: turn *Enable Email provider* **on**
   and *Allow new users to sign up* **off**. Accounts are created by owners
   from inside the app, never by self-signup.
4. **Authentication → Users → Add user** (tick *Auto Confirm User*), then make
   that first account an owner — there is nobody yet who could:

   ```sql
   insert into public.profiles (id, email, role)
   select id, email, 'owner' from auth.users where email = 'you@example.com'
   on conflict (id) do update set role = 'owner';
   ```

5. **Deploy the Edge Function** that creates accounts:

   ```
   npx supabase functions deploy manage-users
   ```

   It holds the `service_role` key server-side, which is the only way an app
   that users can unpack is allowed to create accounts at all.

### Migrating data from the old SQLite version

`scripts/export-to-supabase.js` reads a v1 `bookbin.db` and writes a
transactional SQL file plus a verification query with the expected row counts,
sums and totals baked in:

```
npm run export
```

Load `supabase/seed/bookbin-data.sql`, then run
`supabase/seed/verify-data.sql`. Both files are gitignored — they contain real
business data.

## What it does

- **Items** — your catalog. Items can be marked "inventory" (stock is tracked)
  or "non-inventory" (e.g. Shipping, a misc fee) — non-inventory items appear
  on invoices but never affect stock counts. Each item has a manual "Adjust
  Stock" action for physical-count corrections, and a full history of every
  quantity change.
- **Vendors / Customers** — simple contact records.
- **Incoming Invoices** — record what you bought. Saving one adds each
  inventory line's quantity to on-hand stock. Editing or deleting an invoice
  reverses its old stock effect first, by appending compensating entries
  rather than rewriting history.
- **Outgoing Invoices** — record what you sold. Saving one subtracts stock the
  same way. Each has an **Export PDF** button; a PDF exported from a "sent"
  invoice is also kept as its attachment.
- **Costing** — pools every incoming line that ever bought an item, gives each
  its share of that invoice's shipping and tax, and takes a quantity-weighted
  average. Each recalculation writes a permanent snapshot, so a price stays
  explainable even after the invoices behind it change.
- **Purchase Orders** — a wanted list per buying season, showing how much of
  each item has been bought. Closing one freezes those numbers; reopening
  makes them live again. **Vendor orders** track whole invoices instead, for
  books somebody else orders and you pay for. Each tracked vendor ships either
  to the warehouse (the invoice only needs paying) or to you (it needs paying
  and receiving). Invoices are linked by hand from that vendor's unlinked ones.
- **Dashboard** — low-stock warnings and the most recent invoices of each kind.
- **Settings** — company name, address and logo (shown on PDF invoices),
  invoice prefixes and counters, markup percentage, low-stock threshold.
- **Users** — everyone changes their own password here. Owners also create
  accounts, change roles, set passwords and remove accounts, after
  re-entering their own password.

Invoice attachments and the company logo live in Supabase Storage, so a file
attached on one machine opens on another.

## Security

Access is enforced by the database, not the app. Every table has row-level
security; a client holding nothing but the publishable key — which is what
anyone who unpacks the installer has — is refused on every read and write.

The app's own role check decides only what to draw. A manager who reaches the
Users screen anyway is refused by Postgres, not by the interface.

## Releasing (both platforms, from either OS)

Releases are automated via
[.github/workflows/release.yml](.github/workflows/release.yml). Bump the
version, commit, and push the tag `npm version` creates:

```
npm version patch   # or: minor / major
git push --follow-tags
```

GitHub Actions builds the Windows `.exe` and the Mac `.dmg`/`.zip` and
publishes both to the GitHub Release for that tag — no local Mac needed.

**The build needs the Supabase values as repository secrets**
(Settings → Secrets and variables → Actions): `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`. Repository secrets, not environment secrets — the
workflow declares no environment, so an environment secret would arrive empty.
Without them the build fails with a clear message rather than shipping an app
that cannot connect.

`SUPABASE_URL` must be the project origin. A path on the end is reduced to
the origin at build time, with a warning in the build log.

The sidebar footer shows the installed version and checks that release feed on
launch. On Windows it installs the update in place; on Mac — only ad-hoc
signed, not enough for a silent install — it opens the release page instead.

## Project layout

```
main.js                Electron entry point, wires up IPC handlers
preload.js             contextBridge surface exposed to the renderer as window.api
config/supabase.js     Resolves the project URL and key (env, .env, or baked in)
db/
  supabase.js          The client, plus the encrypted session store
  rest.js              Shared query helpers and numeric coercion
  storage.js           Attachment and logo uploads/downloads
ipc/                   One module per domain — all database access happens
                        here, in the main process, so the renderer never holds
                        an access token. auth.js and users.js cover sign-in and
                        account management; updates.js wraps electron-updater.
renderer/              Plain HTML/CSS/JS UI, no framework, no build step
  screens/             One file per screen
  invoice-template.js  Builds the printable invoice HTML (shared by PDF export)
scripts/               Build-time config writer and the one-off SQLite export
supabase/
  migrations/          Schema, policies, and functions
  functions/           Edge Functions (account creation)
```

No bundler, no framework — every renderer file is loaded directly as a
`<script>` tag from `index.html`.

### A note on numbers

Postgres returns `numeric` columns as **strings**, to avoid handing back a
float it cannot represent exactly. `"5" + 2` is `"52"`, so every numeric column
is coerced through `db/rest.js` on the way out. If a total ever renders as
concatenated digits, that is the coercion missing a column.

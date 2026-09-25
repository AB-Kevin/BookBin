-- Accounts, roles, and row-level security.
--
-- The security model in one sentence: BookBin ships as an Electron app, every
-- line of which the user can read, so NOTHING here may depend on the app
-- behaving itself. Hiding the "New user" button is cosmetic. These policies
-- are the actual lock.
--
-- Two roles:
--   owner    -- everything a manager can do, plus creating accounts and
--               changing roles.
--   manager  -- full read/write on business data, no access to accounts.
--
-- Accounts are never created by the app talking to the database directly.
-- Creating a user needs Supabase's admin API, which needs the service_role
-- key, and that key must never be shipped inside the app -- it bypasses every
-- policy in this file. Account creation goes through an Edge Function that
-- verifies the caller is an owner first.
--
-- BOOTSTRAP: the first owner has to be made by hand, once, because there is
-- nobody yet to authorize it. Create the user in the Supabase dashboard
-- (Authentication -> Users -> Add user), then run:
--
--     update public.profiles set role = 'owner' where email = 'you@example.com';
--
-- Also turn OFF public signups (Authentication -> Providers -> Email ->
-- "Enable sign ups"). Otherwise anyone who finds the app's anon key can make
-- themselves a manager account.

-- ----------------------------------------------------------------- profiles

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'manager' check (role in ('owner', 'manager')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists touch_updated_at on public.profiles;
create trigger touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Every auth user gets a profile automatically. The role is read from
-- app_metadata, NOT user_metadata: user_metadata is whatever the client sent
-- at signup and is therefore attacker-controlled, while app_metadata can only
-- be set through the admin API. Reading the role from user_metadata would let
-- someone sign themselves up as an owner.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    case
      when new.raw_app_meta_data ->> 'role' = 'owner' then 'owner'
      else 'manager'
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------- role predicates

-- These are SECURITY DEFINER on purpose, and it is not incidental: a policy
-- on public.profiles that itself selects from public.profiles recurses
-- forever. Running as the definer skips RLS inside the function body, which
-- breaks the cycle. search_path is pinned to empty so a caller cannot shadow
-- "profiles" with their own table and fake a role.

create or replace function public.bookbin_role()
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.role from public.profiles p where p.id = (select auth.uid());
$fn$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()));
$fn$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'owner'
  );
$fn$;

-- ------------------------------------------------- do not strand the tenant

-- Without this, an owner can demote or delete the last owner -- including
-- themselves, with one careless click -- and then nobody can ever create an
-- account again without going back to the Supabase dashboard.
create or replace function public.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  remaining integer;
begin
  if tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner' then
    select count(*) into remaining
      from public.profiles where role = 'owner' and id <> old.id;
    if remaining = 0 then
      raise exception 'Cannot demote the last owner. Promote another owner first.';
    end if;
  elsif tg_op = 'DELETE' and old.role = 'owner' then
    select count(*) into remaining
      from public.profiles where role = 'owner' and id <> old.id;
    if remaining = 0 then
      raise exception 'Cannot remove the last owner. Promote another owner first.';
    end if;
  end if;
  return coalesce(new, old);
end;
$fn$;

drop trigger if exists guard_last_owner on public.profiles;
create trigger guard_last_owner
  before update or delete on public.profiles
  for each row execute function public.guard_last_owner();

-- --------------------------------------------------------- RLS: enable all

alter table public.profiles               enable row level security;
alter table public.settings               enable row level security;
alter table public.vendors                enable row level security;
alter table public.customers              enable row level security;
alter table public.items                  enable row level security;
alter table public.incoming_invoices      enable row level security;
alter table public.incoming_invoice_lines enable row level security;
alter table public.outgoing_invoices      enable row level security;
alter table public.outgoing_invoice_lines enable row level security;
alter table public.inventory_adjustments  enable row level security;
alter table public.item_cost_snapshots    enable row level security;
alter table public.purchase_orders        enable row level security;
alter table public.purchase_order_items   enable row level security;

-- Belt and braces. Supabase grants the anon role access to new tables in
-- public by default; RLS already denies it for want of a policy, but there is
-- no reason for the grant to exist at all.
revoke all on all tables in schema public from anon;

-- ------------------------------------------------------ RLS: business data

-- Staff (either role) get full read/write on everything that is not an
-- account. Written as a loop because thirteen hand-copied policy blocks is
-- thirteen chances to typo one table into being world-writable.
do $rls$
declare
  t text;
begin
  foreach t in array array[
    'settings', 'vendors', 'customers', 'items',
    'incoming_invoices', 'incoming_invoice_lines',
    'outgoing_invoices', 'outgoing_invoice_lines',
    'inventory_adjustments', 'item_cost_snapshots',
    'purchase_orders', 'purchase_order_items'
  ]
  loop
    execute format('drop policy if exists staff_all on public.%I', t);
    execute format(
      'create policy staff_all on public.%I '
      'for all to authenticated '
      'using (public.is_staff()) '
      'with check (public.is_staff())', t);
  end loop;
end;
$rls$;

-- ----------------------------------------------------------- RLS: profiles

-- Anyone on staff can see the roster: the app shows who else is in, and an
-- owner needs the list to manage it.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (public.is_staff());

-- Only owners touch accounts. Note there is deliberately no "users can update
-- their own profile" policy covering role -- that is exactly the hole that
-- would let a manager promote themselves.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (public.is_owner());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete to authenticated
  using (public.is_owner());

-- A person may fix their own display name, and nothing else.
drop policy if exists profiles_update_self_name on public.profiles;
create policy profiles_update_self_name on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- The policy above says WHICH ROWS may be updated; it cannot say which
-- COLUMNS, and "your own row" plus an unrestricted column set is precisely
-- how a manager would promote themselves. Column grants are the only thing
-- that can express this, so the authenticated role is given exactly one
-- writable column and no more.
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

-- Which leaves owners unable to change anyone's role by direct UPDATE either
-- -- intentionally. Role changes go through this function instead, where the
-- owner check happens in one auditable place. The guard_last_owner trigger
-- still fires underneath it.
create or replace function public.set_user_role(target_user uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not public.is_owner() then
    raise exception 'Only an owner can change roles.';
  end if;
  if new_role not in ('owner', 'manager') then
    raise exception 'Unknown role: %', new_role;
  end if;
  update public.profiles set role = new_role where id = target_user;
  if not found then
    raise exception 'No such user.';
  end if;
end;
$fn$;

revoke all on function public.set_user_role(uuid, text) from public, anon;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- Run this after the two migrations. It changes nothing; it only reports.
-- Every row in every section should match what the comments say to expect.

-- 1. Tables, and whether row-level security is actually on.
--    Expect 13 rows. rls_enabled must be true for ALL of them -- a false here
--    means that table is readable by anyone holding the anon key.
select
  t.tablename,
  t.rowsecurity as rls_enabled,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = t.tablename) as policy_count
from pg_tables t
where t.schemaname = 'public'
order by t.tablename;

-- 2. Security-relevant functions.
--    Expect exactly these 7: bookbin_role, guard_last_owner, handle_new_user,
--    is_owner, is_staff, set_user_role, touch_updated_at.
--    The four marked security_definer must say true, or the role checks can
--    be defeated by a caller's own search_path.
select
  p.proname as function_name,
  p.prosecdef as security_definer,
  pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
where p.pronamespace = 'public'::regnamespace
order by p.proname;

-- 3. The trigger that gives every new auth user a profile.
--    Expect one row: on_auth_user_created.
select tgname as trigger_name, tgrelid::regclass as on_table
from pg_trigger
where not tgisinternal and tgrelid = 'auth.users'::regclass;

-- 4. Column-level write permissions on profiles.
--    Expect exactly ONE update row for 'authenticated', on full_name.
--    If 'role' appears here, any manager can promote themselves to owner.
select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'profiles'
  and privilege_type = 'UPDATE'
  and grantee in ('authenticated', 'anon')
order by grantee, column_name;

-- 5. Who owns the place.
--    Before you promote yourself this is empty, which is expected.
--    After, it should list exactly you.
select email, role, created_at from public.profiles order by created_at;

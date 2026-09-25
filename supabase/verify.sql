-- Post-migration check. Reads only; changes nothing.
--
-- Deliberately ONE statement. The Supabase SQL Editor shows a single result
-- set per run, so a file of separate SELECTs silently throws away all but one
-- of them. Everything below folds into one table with an explicit verdict per
-- row: scan the status column, and anything not starting with PASS wants
-- attention.

select x.area, x.detail, x.status
from (

  -- Every table must have RLS on AND at least one policy. RLS without a
  -- policy is not "secure", it is "locked to everybody including the app".
  select 1 as sort, 'RLS' as area, t.tablename::text as detail,
    case
      when not t.rowsecurity then 'FAIL - RLS is off'
      when (select count(*) from pg_policies p
             where p.schemaname = 'public' and p.tablename = t.tablename) = 0
        then 'FAIL - RLS on but no policies; nobody can read this'
      else 'PASS'
    end as status
  from pg_tables t
  where t.schemaname = 'public'

  union all
  select 2, 'Table count', 'expected 13',
    case when (select count(*) from pg_tables where schemaname = 'public') = 13
      then 'PASS'
      else 'FAIL - found ' || (select count(*) from pg_tables where schemaname = 'public')::text
    end

  union all
  select 3, 'Function', fn,
    case when exists (
      select 1 from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = fn
    ) then 'PASS' else 'FAIL - missing' end
  from unnest(array[
    'touch_updated_at', 'handle_new_user', 'bookbin_role',
    'is_staff', 'is_owner', 'guard_last_owner', 'set_user_role'
  ]) as fn

  -- The six role-related functions must be SECURITY DEFINER. Without it the
  -- policies on profiles recurse into themselves, and a caller could shadow
  -- "profiles" with their own table to fake a role. touch_updated_at is
  -- correctly NOT definer -- it only stamps a timestamp.
  union all
  select 4, 'Security definer', p.proname::text,
    case when p.prosecdef then 'PASS' else 'FAIL - not SECURITY DEFINER' end
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in (
      'handle_new_user', 'bookbin_role', 'is_staff',
      'is_owner', 'guard_last_owner', 'set_user_role'
    )

  union all
  select 5, 'Auth trigger', 'on_auth_user_created',
    case when exists (
      select 1 from pg_trigger
      where not tgisinternal
        and tgrelid = 'auth.users'::regclass
        and tgname = 'on_auth_user_created'
    ) then 'PASS' else 'FAIL - new users will get no profile' end

  -- The security check that matters most. If "role" or "email" shows up here,
  -- any manager can promote themselves to owner with a single REST call.
  union all
  select 6, 'profiles writable columns',
    coalesce(string_agg(cp.column_name::text, ', ' order by cp.column_name), '(none)'),
    case when coalesce(string_agg(cp.column_name::text, ',' order by cp.column_name), '') = 'full_name'
      then 'PASS' else 'FAIL - must be full_name and nothing else' end
  from information_schema.column_privileges cp
  where cp.table_schema = 'public'
    and cp.table_name = 'profiles'
    and cp.privilege_type = 'UPDATE'
    and cp.grantee in ('authenticated', 'anon')

  union all
  select 7, 'anon table grants', 'expected none',
    case when (select count(*) from information_schema.role_table_grants
                where table_schema = 'public' and grantee = 'anon') = 0
      then 'PASS'
      else 'WARN - anon still granted on '
           || (select count(distinct table_name)::text from information_schema.role_table_grants
                where table_schema = 'public' and grantee = 'anon') || ' table(s)'
    end

  union all
  select 8, 'Owners',
    coalesce((select string_agg(pr.email, ', ') from public.profiles pr where pr.role = 'owner'), '(none yet)'),
    case when exists (select 1 from public.profiles where role = 'owner')
      then 'PASS' else 'TODO - create your user, then promote it to owner' end

) x
order by x.sort, x.detail;

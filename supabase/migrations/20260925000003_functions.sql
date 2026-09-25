-- Operations that must happen all-or-nothing.
--
-- A Supabase client cannot wrap several statements in a transaction: each REST
-- call is its own. Anything that has to be atomic therefore lives here, as a
-- function, because a function body IS a transaction. The alternative -- two
-- REST calls from the app -- would leave stock adjusted with no record of why
-- the moment a network drops between them.
--
-- These are SECURITY INVOKER (the default), deliberately. Making them DEFINER
-- would run them as their owner and bypass row-level security, turning every
-- function into a hole straight through the policies. Running as the caller
-- means the same policies that guard a direct write guard these too.

-- Applies a manual stock correction and records why, as one unit.
--
-- The quantity is adjusted with `quantity_on_hand + p_delta` rather than by
-- reading the value and writing back a computed one: two people counting the
-- same shelf at the same time must both have their corrections applied, and a
-- read-then-write would silently discard one of them.
create or replace function public.adjust_item_stock(
  p_item_id bigint,
  p_delta numeric,
  p_reason text default null
)
returns public.items
language plpgsql
set search_path = ''
as $fn$
declare
  updated public.items;
begin
  update public.items
     set quantity_on_hand = quantity_on_hand + p_delta
   where id = p_item_id
  returning * into updated;

  if updated.id is null then
    raise exception 'No such item: %', p_item_id;
  end if;

  insert into public.inventory_adjustments (item_id, delta, reason, source_type, source_id)
  values (
    p_item_id,
    p_delta,
    coalesce(nullif(btrim(p_reason), ''), 'Manual adjustment'),
    'manual',
    null
  );

  return updated;
end;
$fn$;

revoke all on function public.adjust_item_stock(bigint, numeric, text) from public, anon;
grant execute on function public.adjust_item_stock(bigint, numeric, text) to authenticated;

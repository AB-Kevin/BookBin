-- Recording a costing result.
--
-- Only the writing half of costing lives here. The calculation itself -- the
-- proportional shipping shares and the quantity-weighted average -- stays in
-- JavaScript, unchanged, because translating that arithmetic into plpgsql
-- would be a rewrite of subtle money logic with no way to prove the two
-- versions agree. What it does need from the database is that the snapshot
-- and the item's new cost land together: a snapshot with no matching item, or
-- an item whose price no record explains, is worse than neither.
create or replace function public.record_item_cost(
  p_item_id bigint,
  p_cost numeric,
  p_price numeric,
  p_markup_percent numeric,
  p_breakdown jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_snapshot public.item_cost_snapshots;
  v_item public.items;
begin
  update public.items
     set default_cost = p_cost,
         default_price = p_price
   where id = p_item_id
  returning * into v_item;

  if v_item.id is null then
    raise exception 'No such item: %', p_item_id;
  end if;

  insert into public.item_cost_snapshots (item_id, cost, price, markup_percent, breakdown)
  values (p_item_id, p_cost, p_price, p_markup_percent, p_breakdown)
  returning * into v_snapshot;

  return jsonb_build_object('snapshot', to_jsonb(v_snapshot), 'item', to_jsonb(v_item));
end;
$fn$;

revoke all on function public.record_item_cost(bigint, numeric, numeric, numeric, jsonb) from public, anon;
grant execute on function public.record_item_cost(bigint, numeric, numeric, numeric, jsonb) to authenticated;

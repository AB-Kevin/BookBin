-- Purchase orders: bought quantities, closing, and reopening.

-- How much of each item has ever been bought, across all incoming invoices.
--
-- Not scoped to anything later than the purchase-order line's creation, on
-- purpose: stock fully sells through between yearly batches, so an item's
-- all-time purchased total is exactly what an open order wants to show.
--
-- This exists as a function because PostgREST cannot express a GROUP BY, and
-- doing it in the app would mean pulling every invoice line across the wire to
-- add up numbers the database is already holding. Takes an array so a whole
-- order costs one round trip rather than one per line.
create or replace function public.bought_quantities(p_item_ids bigint[])
returns table (item_id bigint, quantity numeric)
language sql
stable
set search_path = ''
as $fn$
  select l.item_id, coalesce(sum(l.quantity), 0)
    from public.incoming_invoice_lines l
   where l.item_id = any(p_item_ids)
   group by l.item_id;
$fn$;

-- Snapshots each line's current bought quantity so the order stops reacting
-- to anything that happens afterwards -- new invoices, edits to old ones,
-- even the linked item being deleted -- until it is reopened.
--
-- The freeze and the status change must land together: a closed order whose
-- lines were never frozen would silently keep moving, which is the one thing
-- closing is supposed to prevent.
create or replace function public.close_purchase_order(p_id bigint)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  update public.purchase_order_items poi
     set frozen_bought_quantity = coalesce(
           (select sum(l.quantity)
              from public.incoming_invoice_lines l
             where l.item_id = poi.item_id),
           0)
   where poi.purchase_order_id = p_id;

  update public.purchase_orders
     set status = 'closed', closed_at = now()
   where id = p_id;

  if not found then
    raise exception 'No such purchase order: %', p_id;
  end if;
end;
$fn$;

-- Clears the freeze so the lines go back to being computed live.
create or replace function public.reopen_purchase_order(p_id bigint)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  update public.purchase_order_items
     set frozen_bought_quantity = null
   where purchase_order_id = p_id;

  update public.purchase_orders
     set status = 'open', closed_at = null
   where id = p_id;

  if not found then
    raise exception 'No such purchase order: %', p_id;
  end if;
end;
$fn$;

revoke all on function public.bought_quantities(bigint[]) from public, anon;
revoke all on function public.close_purchase_order(bigint) from public, anon;
revoke all on function public.reopen_purchase_order(bigint) from public, anon;

grant execute on function public.bought_quantities(bigint[]) to authenticated;
grant execute on function public.close_purchase_order(bigint) to authenticated;
grant execute on function public.reopen_purchase_order(bigint) to authenticated;

-- Stock reversal writes one net row per item, and the history it bloated is
-- compacted.
--
-- reverse_invoice_stock() used to negate every adjustment an invoice had ever
-- written -- including the reversal rows from earlier saves. The quantities
-- stayed right, because each pass nets to zero, but the row count doubled on
-- every save: N lines became 3N, then 7N, 15N, ... until a save of an invoice
-- that had been edited a couple of dozen times was writing millions of rows
-- and hitting the statement timeout.

create or replace function public.reverse_invoice_stock(
  p_source_type text,
  p_invoice_id bigint
)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  -- One row per item, cancelling whatever this invoice currently has on it,
  -- so each save adds at most one reversal per item however often it is
  -- edited. Both statements below read the snapshot taken before either
  -- runs, so the insert does not see the stock update or its own rows.
  with net as (
    select a.item_id,
           sum(a.delta) as delta,
           (array_agg(a.reason order by a.id desc)
              filter (where a.reason not like 'Reversed: %'))[1] as reason
      from public.inventory_adjustments a
     where a.source_type = p_source_type and a.source_id = p_invoice_id
     group by a.item_id
    having sum(a.delta) <> 0
  ), moved as (
    update public.items i
       set quantity_on_hand = i.quantity_on_hand - net.delta
      from net
     where i.id = net.item_id
  )
  insert into public.inventory_adjustments (item_id, delta, reason, source_type, source_id)
  select net.item_id, -net.delta, 'Reversed: ' || coalesce(net.reason, 'invoice'), p_source_type, p_invoice_id
    from net;
end;
$fn$;

-- Collapse every item's history on an invoice that has been reversed at
-- least once into a single row carrying its net effect. Every per-invoice,
-- per-item sum is unchanged, so quantity_on_hand still matches and later
-- reversals still cancel exactly; what goes is the pile of "Reversed:
-- Reversed: ..." rows. An item whose net is zero (taken off the invoice) is
-- left with no rows, as it would have been had it never been added.
with bloated as (
  select source_type, source_id, item_id,
         sum(delta) as delta,
         (array_agg(reason order by id desc)
            filter (where reason not like 'Reversed: %'))[1] as reason,
         max(created_at) filter (where reason not like 'Reversed: %') as created_at
    from public.inventory_adjustments
   where source_type in ('incoming_invoice', 'outgoing_invoice')
   group by source_type, source_id, item_id
  having bool_or(reason like 'Reversed: %')
), removed as (
  delete from public.inventory_adjustments a
   using bloated b
   where a.source_type = b.source_type
     and a.source_id = b.source_id
     and a.item_id = b.item_id
)
insert into public.inventory_adjustments (item_id, delta, reason, source_type, source_id, created_at)
select item_id, delta, coalesce(reason, 'Invoice'), source_type, source_id, coalesce(created_at, now())
  from bloated
 where delta <> 0;

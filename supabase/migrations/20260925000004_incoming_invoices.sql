-- Incoming invoices: saving one, and deleting one.
--
-- An incoming invoice is not a single row. Saving one writes a header,
-- replaces its lines, reverses whatever stock the previous version of it
-- moved, applies the new stock, and may consume an invoice number. Half of
-- that having happened is not a state the business can be left in, so it all
-- lives in one function, where the whole body is one transaction.
--
-- SECURITY INVOKER throughout, so row-level security still applies.

-- Hands out the next incoming invoice number.
--
-- The SQLite version read the counter and then bumped it, in two statements.
-- Under one writer that was fine; with several people invoicing at once it is
-- a race that hands two invoices the same number. A single UPDATE ... RETURNING
-- cannot interleave: the row is locked for the duration, so every caller gets
-- a distinct number. RETURNING sees the new value, hence the -1 to report the
-- number this caller was actually given.
create or replace function public.next_incoming_invoice_number()
returns text
language sql
set search_path = ''
as $fn$
  update public.settings
     set incoming_next_number = incoming_next_number + 1
   where id = 1
  returning incoming_prefix || (incoming_next_number - 1)::text;
$fn$;

-- Undoes every stock movement this invoice has ever caused.
--
-- It negates ALL adjustment rows for the invoice, including reversals written
-- by earlier edits. That looks like it would double-count, and it is in fact
-- what makes repeated edits correct: negating the entire history for a source
-- always returns that source's net effect to zero, whatever happened before,
-- so the new lines can then be applied to a clean slate.
--
-- History is never rewritten -- each reversal is a new row -- so an item's
-- ledger still explains how it reached its current count.
create or replace function public.reverse_incoming_stock(p_invoice_id bigint)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  -- Must run before the reversal rows are inserted, or the totals it sums
  -- would include them.
  update public.items i
     set quantity_on_hand = i.quantity_on_hand - agg.delta
    from (
      select a.item_id, sum(a.delta) as delta
        from public.inventory_adjustments a
       where a.source_type = 'incoming_invoice' and a.source_id = p_invoice_id
       group by a.item_id
    ) agg
   where i.id = agg.item_id;

  -- INSERT ... SELECT reads a snapshot taken before the insert, so this does
  -- not negate the rows it is in the middle of writing.
  insert into public.inventory_adjustments (item_id, delta, reason, source_type, source_id)
  select a.item_id, -a.delta, 'Reversed: ' || a.reason, 'incoming_invoice', p_invoice_id
    from public.inventory_adjustments a
   where a.source_type = 'incoming_invoice' and a.source_id = p_invoice_id;
end;
$fn$;

-- Creates (p_id null) or replaces an invoice, and returns its id.
create or replace function public.save_incoming_invoice(
  p_id bigint,
  p_header jsonb,
  p_lines jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $fn$
declare
  v_id bigint := p_id;
  v_number text;
  v_total numeric;
  v_shipping numeric := coalesce((p_header ->> 'shipping_tax')::numeric, 0);
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
begin
  -- The total is what the vendor was actually paid, so it carries shipping and
  -- tax rather than being only the sum of the lines.
  select coalesce(sum((l ->> 'quantity')::numeric * (l ->> 'unit_cost')::numeric), 0)
    into v_total
    from jsonb_array_elements(v_lines) as l;
  v_total := v_total + v_shipping;

  v_number := nullif(btrim(coalesce(p_header ->> 'invoice_number', '')), '');

  if v_id is null then
    if v_number is null then
      v_number := public.next_incoming_invoice_number();
    end if;

    insert into public.incoming_invoices (
      vendor_id, invoice_number, invoice_date, notes, total, shipping_tax,
      paid, received, attachment_path, attachment_name
    ) values (
      nullif(p_header ->> 'vendor_id', '')::bigint,
      v_number,
      (p_header ->> 'invoice_date')::date,
      p_header ->> 'notes',
      v_total,
      v_shipping,
      coalesce((p_header ->> 'paid')::boolean, false),
      coalesce((p_header ->> 'received')::boolean, false),
      p_header ->> 'attachment_path',
      p_header ->> 'attachment_name'
    )
    returning id into v_id;
  else
    perform public.reverse_incoming_stock(v_id);
    delete from public.incoming_invoice_lines where invoice_id = v_id;

    if v_number is null then
      v_number := public.next_incoming_invoice_number();
    end if;

    update public.incoming_invoices set
      vendor_id = nullif(p_header ->> 'vendor_id', '')::bigint,
      invoice_number = v_number,
      invoice_date = (p_header ->> 'invoice_date')::date,
      notes = p_header ->> 'notes',
      total = v_total,
      shipping_tax = v_shipping,
      paid = coalesce((p_header ->> 'paid')::boolean, false),
      received = coalesce((p_header ->> 'received')::boolean, false),
      attachment_path = p_header ->> 'attachment_path',
      attachment_name = p_header ->> 'attachment_name'
    where id = v_id;

    if not found then
      raise exception 'No such incoming invoice: %', v_id;
    end if;
  end if;

  insert into public.incoming_invoice_lines (
    invoice_id, item_id, description, quantity, unit_cost, line_total
  )
  select
    v_id,
    nullif(l ->> 'item_id', '')::bigint,
    l ->> 'description',
    (l ->> 'quantity')::numeric,
    (l ->> 'unit_cost')::numeric,
    (l ->> 'quantity')::numeric * (l ->> 'unit_cost')::numeric
  from jsonb_array_elements(v_lines) as l;

  -- Stock moves only for lines pointing at an item that is tracked as
  -- inventory; a line with no item, or a non-inventory one, is money only.
  update public.items i
     set quantity_on_hand = i.quantity_on_hand + agg.qty
    from (
      select tracked.id, sum((l ->> 'quantity')::numeric) as qty
        from jsonb_array_elements(v_lines) as l
        join public.items tracked on tracked.id = nullif(l ->> 'item_id', '')::bigint
       where tracked.is_inventory
       group by tracked.id
    ) agg
   where i.id = agg.id;

  -- One adjustment row per line, not per item: two lines for the same item
  -- stay two entries in its history, as they were before.
  insert into public.inventory_adjustments (item_id, delta, reason, source_type, source_id)
  select
    tracked.id,
    (l ->> 'quantity')::numeric,
    'Incoming invoice ' || v_number,
    'incoming_invoice',
    v_id
  from jsonb_array_elements(v_lines) as l
  join public.items tracked on tracked.id = nullif(l ->> 'item_id', '')::bigint
  where tracked.is_inventory;

  return v_id;
end;
$fn$;

-- Removes an invoice, undoing its stock effect first. Lines go by cascade.
create or replace function public.delete_incoming_invoice(p_id bigint)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  perform public.reverse_incoming_stock(p_id);
  delete from public.incoming_invoices where id = p_id;
end;
$fn$;

revoke all on function public.next_incoming_invoice_number() from public, anon;
revoke all on function public.reverse_incoming_stock(bigint) from public, anon;
revoke all on function public.save_incoming_invoice(bigint, jsonb, jsonb) from public, anon;
revoke all on function public.delete_incoming_invoice(bigint) from public, anon;

grant execute on function public.next_incoming_invoice_number() to authenticated;
grant execute on function public.reverse_incoming_stock(bigint) to authenticated;
grant execute on function public.save_incoming_invoice(bigint, jsonb, jsonb) to authenticated;
grant execute on function public.delete_incoming_invoice(bigint) to authenticated;

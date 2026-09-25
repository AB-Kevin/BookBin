-- Outgoing invoices, and a shared stock reversal.
--
-- Outgoing invoices are the mirror of incoming ones: same header-plus-lines
-- shape, same need for the whole save to be one transaction, but stock moves
-- down instead of up and the total carries no shipping.

-- Reversal is identical for both directions -- negate every adjustment this
-- invoice ever caused -- so it is one function taking the source type rather
-- than two that must be kept in step. reverse_incoming_stock() is redefined
-- below to call it, so there is a single implementation of the rule.
create or replace function public.reverse_invoice_stock(
  p_source_type text,
  p_invoice_id bigint
)
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
       where a.source_type = p_source_type and a.source_id = p_invoice_id
       group by a.item_id
    ) agg
   where i.id = agg.item_id;

  -- INSERT ... SELECT reads a snapshot taken before the insert, so this does
  -- not negate the rows it is in the middle of writing.
  insert into public.inventory_adjustments (item_id, delta, reason, source_type, source_id)
  select a.item_id, -a.delta, 'Reversed: ' || a.reason, p_source_type, p_invoice_id
    from public.inventory_adjustments a
   where a.source_type = p_source_type and a.source_id = p_invoice_id;
end;
$fn$;

create or replace function public.reverse_incoming_stock(p_invoice_id bigint)
returns void
language sql
set search_path = ''
as $fn$
  select public.reverse_invoice_stock('incoming_invoice', p_invoice_id);
$fn$;

-- Same race fix as the incoming counter: one statement, so two people
-- invoicing at once cannot be handed the same number.
create or replace function public.next_outgoing_invoice_number()
returns text
language sql
set search_path = ''
as $fn$
  update public.settings
     set outgoing_next_number = outgoing_next_number + 1
   where id = 1
  returning outgoing_prefix || (outgoing_next_number - 1)::text;
$fn$;

create or replace function public.save_outgoing_invoice(
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
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
begin
  -- No shipping component here, unlike incoming: an outgoing invoice totals
  -- exactly what was billed on its lines.
  select coalesce(sum((l ->> 'quantity')::numeric * (l ->> 'unit_price')::numeric), 0)
    into v_total
    from jsonb_array_elements(v_lines) as l;

  v_number := nullif(btrim(coalesce(p_header ->> 'invoice_number', '')), '');

  if v_id is null then
    if v_number is null then
      v_number := public.next_outgoing_invoice_number();
    end if;

    insert into public.outgoing_invoices (
      customer_id, invoice_number, invoice_date, notes, total, status,
      attachment_path, attachment_name
    ) values (
      nullif(p_header ->> 'customer_id', '')::bigint,
      v_number,
      (p_header ->> 'invoice_date')::date,
      p_header ->> 'notes',
      v_total,
      coalesce(nullif(p_header ->> 'status', ''), 'draft'),
      p_header ->> 'attachment_path',
      p_header ->> 'attachment_name'
    )
    returning id into v_id;
  else
    perform public.reverse_invoice_stock('outgoing_invoice', v_id);
    delete from public.outgoing_invoice_lines where invoice_id = v_id;

    if v_number is null then
      v_number := public.next_outgoing_invoice_number();
    end if;

    update public.outgoing_invoices set
      customer_id = nullif(p_header ->> 'customer_id', '')::bigint,
      invoice_number = v_number,
      invoice_date = (p_header ->> 'invoice_date')::date,
      notes = p_header ->> 'notes',
      total = v_total,
      status = coalesce(nullif(p_header ->> 'status', ''), 'draft'),
      attachment_path = p_header ->> 'attachment_path',
      attachment_name = p_header ->> 'attachment_name'
    where id = v_id;

    if not found then
      raise exception 'No such outgoing invoice: %', v_id;
    end if;
  end if;

  insert into public.outgoing_invoice_lines (
    invoice_id, item_id, description, quantity, unit_price, line_total
  )
  select
    v_id,
    nullif(l ->> 'item_id', '')::bigint,
    l ->> 'description',
    (l ->> 'quantity')::numeric,
    (l ->> 'unit_price')::numeric,
    (l ->> 'quantity')::numeric * (l ->> 'unit_price')::numeric
  from jsonb_array_elements(v_lines) as l;

  -- Selling reduces stock, hence the negation. Deliberately NOT clamped at
  -- zero: the SQLite version allowed stock to go negative, and hiding an
  -- oversold item behind a floor of zero would make the error harder to
  -- notice, not less real.
  update public.items i
     set quantity_on_hand = i.quantity_on_hand - agg.qty
    from (
      select tracked.id, sum((l ->> 'quantity')::numeric) as qty
        from jsonb_array_elements(v_lines) as l
        join public.items tracked on tracked.id = nullif(l ->> 'item_id', '')::bigint
       where tracked.is_inventory
       group by tracked.id
    ) agg
   where i.id = agg.id;

  insert into public.inventory_adjustments (item_id, delta, reason, source_type, source_id)
  select
    tracked.id,
    -(l ->> 'quantity')::numeric,
    'Outgoing invoice ' || v_number,
    'outgoing_invoice',
    v_id
  from jsonb_array_elements(v_lines) as l
  join public.items tracked on tracked.id = nullif(l ->> 'item_id', '')::bigint
  where tracked.is_inventory;

  return v_id;
end;
$fn$;

create or replace function public.delete_outgoing_invoice(p_id bigint)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  perform public.reverse_invoice_stock('outgoing_invoice', p_id);
  delete from public.outgoing_invoices where id = p_id;
end;
$fn$;

revoke all on function public.reverse_invoice_stock(text, bigint) from public, anon;
revoke all on function public.next_outgoing_invoice_number() from public, anon;
revoke all on function public.save_outgoing_invoice(bigint, jsonb, jsonb) from public, anon;
revoke all on function public.delete_outgoing_invoice(bigint) from public, anon;

grant execute on function public.reverse_invoice_stock(text, bigint) to authenticated;
grant execute on function public.next_outgoing_invoice_number() to authenticated;
grant execute on function public.save_outgoing_invoice(bigint, jsonb, jsonb) to authenticated;
grant execute on function public.delete_outgoing_invoice(bigint) to authenticated;

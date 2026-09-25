-- DESTRUCTIVE. Empties every business table so a fresh export can be loaded.
--
-- Run this only when you intend to replace all BookBin data with the contents
-- of a newly generated seed/bookbin-data.sql. Everything these tables hold is
-- gone afterwards, and there is no undo.
--
-- What it deliberately does NOT touch:
--
--   public.profiles and auth.users -- the accounts. Wiping those would delete
--   your owner account along with the data, leaving nobody able to sign in or
--   to create a replacement, and the first owner has to be made by hand in
--   the dashboard.
--
--   The schema itself: tables, policies, functions and grants all survive.
--   Only rows are removed, so nothing needs re-running afterwards except the
--   data load.
--
-- RESTART IDENTITY matters: without it the id counters keep climbing from
-- where they were, and the seed file loads explicit ids that would then sit
-- behind the sequence, so the next invoice created in the app would collide
-- with an existing row.

begin;

truncate
  public.incoming_invoice_lines,
  public.outgoing_invoice_lines,
  public.inventory_adjustments,
  public.item_cost_snapshots,
  public.purchase_order_invoices,
  public.purchase_order_vendors,
  public.purchase_order_items,
  public.incoming_invoices,
  public.outgoing_invoices,
  public.purchase_orders,
  public.items,
  public.vendors,
  public.customers
restart identity cascade;

-- settings is a single fixed row rather than a sequence-backed table, so it is
-- reset by hand. The data load updates this row rather than inserting one.
delete from public.settings where id = 1;
insert into public.settings (id) values (1);

commit;

-- Confirms the tables the data load's guard checks are actually empty. All
-- three counts must be 0, or the load will refuse to run.
select
  (select count(*) from public.items) as items,
  (select count(*) from public.vendors) as vendors,
  (select count(*) from public.incoming_invoices) as incoming_invoices,
  (select count(*) from public.profiles) as profiles_kept;

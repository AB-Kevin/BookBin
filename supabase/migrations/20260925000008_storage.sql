-- File storage for invoice attachments and the company logo.
--
-- These were local files in a synced folder, which worked only because every
-- machine had that folder. With the database online, an attachment added on
-- one computer was invisible on another: the invoice row named a file that
-- did not exist there. A bucket puts the files where the rows already are.
--
-- The bucket is PRIVATE. A public bucket serves every object to anyone who
-- guesses its URL, with no login involved -- these are supplier invoices and
-- customer bills, so they are read through the authenticated client instead.

insert into storage.buckets (id, name, public)
values ('bookbin', 'bookbin', false)
on conflict (id) do nothing;

-- Same rule as every business table: signed-in staff, nobody else. RLS is
-- already enabled on storage.objects by Supabase, so without these policies
-- the bucket is simply unreadable.
--
-- The bucket_id check matters. Policies on storage.objects apply to every
-- bucket in the project, so one without it would grant access to buckets
-- added later for entirely unrelated reasons.

drop policy if exists bookbin_staff_read on storage.objects;
create policy bookbin_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'bookbin' and public.is_staff());

drop policy if exists bookbin_staff_insert on storage.objects;
create policy bookbin_staff_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'bookbin' and public.is_staff());

drop policy if exists bookbin_staff_update on storage.objects;
create policy bookbin_staff_update on storage.objects
  for update to authenticated
  using (bucket_id = 'bookbin' and public.is_staff())
  with check (bucket_id = 'bookbin' and public.is_staff());

drop policy if exists bookbin_staff_delete on storage.objects;
create policy bookbin_staff_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'bookbin' and public.is_staff());

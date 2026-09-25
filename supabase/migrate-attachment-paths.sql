-- One-off: point existing rows at uploaded storage objects.
--
-- Run this AFTER uploading the files themselves into the `bookbin` bucket
-- (Storage in the dashboard), keeping their existing filenames:
--
--   <workspace>/attachments/incoming/*  ->  bookbin/incoming/
--   <workspace>/attachments/outgoing/*  ->  bookbin/outgoing/
--   <workspace>/logo/*                  ->  bookbin/logo/
--
-- The app tells a storage object from a legacy local file by the slash, so
-- prefixing the folder is the whole migration for attachments. Rows already
-- containing a slash are skipped, which makes this safe to run twice.
--
-- Nothing here deletes the local files. Leave them until the attachments have
-- been opened from another machine and confirmed working.

update public.incoming_invoices
   set attachment_path = 'incoming/' || attachment_path
 where attachment_path is not null
   and attachment_path not like '%/%'
   and attachment_path not like '%:\%';

update public.outgoing_invoices
   set attachment_path = 'outgoing/' || attachment_path
 where attachment_path is not null
   and attachment_path not like '%/%'
   and attachment_path not like '%:\%';

-- The logo is set by hand: its stored value is an absolute Windows path from
-- before workspaces existed, so there is no filename to prefix. Upload the
-- image to bookbin/logo/ and put its object path here. Avoid spaces in the
-- name -- they are legal in a storage key and a nuisance everywhere else.
--
--   update public.settings
--      set company_logo_path = 'logo/logo-2026.png'
--    where id = 1;

-- Check: every remaining value should either contain a slash (a storage
-- object) or be null. Anything else is still a local file.
select
  'incoming_invoices' as source, attachment_path
  from public.incoming_invoices where attachment_path is not null
union all
select
  'outgoing_invoices', attachment_path
  from public.outgoing_invoices where attachment_path is not null
union all
select
  'settings.logo', company_logo_path
  from public.settings where company_logo_path is not null;

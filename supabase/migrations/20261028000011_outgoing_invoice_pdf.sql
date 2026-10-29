-- The exported PDF gets its own place on an outgoing invoice.
--
-- Export used to store the PDF it made as the invoice's attachment, so
-- exporting replaced whatever file had been attached by hand (a signed copy,
-- a delivery note) and attaching one replaced the PDF. They are two different
-- things now: pdf_path/pdf_name hold the latest export and are rewritten by
-- every export, while attachment_path/attachment_name stay the person's own.
--
-- save_outgoing_invoice() names its columns, so it leaves these alone and
-- needs no change. Export writes them directly.

alter table public.outgoing_invoices
  add column if not exists pdf_path text,
  add column if not exists pdf_name text;

-- An attachment named the way export names its file was put there by an
-- earlier export, so it moves across. Anything else was chosen by hand and
-- stays where it is.
update public.outgoing_invoices
   set pdf_path = attachment_path,
       pdf_name = attachment_name,
       attachment_path = null,
       attachment_name = null
 where pdf_path is null
   and attachment_path is not null
   and attachment_name = coalesce(invoice_number, 'invoice') || '.pdf';

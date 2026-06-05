-- Polish-9: storage bucket for user-uploaded reference creatives that
-- drive auto-detect routing on the generation form. Polish-6 already
-- added the generation_jobs.reference_creative_storage_path column;
-- this migration creates the bucket the path points into.
--
-- Path convention: <userId>/<uuid>/<filename> — same prefix-by-owner
-- pattern as the 'concepts' bucket so RLS gates per-user.
--
-- Limit: 104857600 bytes (100 MB). Big enough for any UGC reference
-- ad video (typically 5–30 MB) without exposing the storage to
-- multi-gig uploads.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('reference-creatives', 'reference-creatives', false, 104857600,
   array[
     'video/mp4',
     'video/quicktime',
     'video/x-m4v',
     'video/webm',
     'image/png',
     'image/jpeg',
     'image/webp'
   ])
on conflict (id) do nothing;

drop policy if exists "reference-creatives owner read"   on storage.objects;
drop policy if exists "reference-creatives owner write"  on storage.objects;
drop policy if exists "reference-creatives owner delete" on storage.objects;

create policy "reference-creatives owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reference-creatives'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "reference-creatives owner write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'reference-creatives'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "reference-creatives owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'reference-creatives'
    and split_part(name, '/', 1) = auth.uid()::text
  );

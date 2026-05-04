-- Storage buckets for user-uploaded concept videos and generated creatives.
-- Bucket-level policies scope reads/writes to the owner via the file path
-- prefix `<user_id>/...`.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('concepts', 'concepts', false, 524288000,
   array['video/mp4', 'video/quicktime', 'video/x-m4v']),
  ('generated-creatives', 'generated-creatives', false, 524288000,
   array['video/mp4', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "concepts owner read"   on storage.objects;
drop policy if exists "concepts owner write"  on storage.objects;
drop policy if exists "concepts owner delete" on storage.objects;

create policy "concepts owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'concepts' and split_part(name, '/', 1) = auth.uid()::text);

create policy "concepts owner write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'concepts' and split_part(name, '/', 1) = auth.uid()::text);

create policy "concepts owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'concepts' and split_part(name, '/', 1) = auth.uid()::text);

drop policy if exists "generated owner read" on storage.objects;
create policy "generated owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'generated-creatives' and split_part(name, '/', 1) = auth.uid()::text);
-- Writes to generated-creatives only via service_role (background jobs).

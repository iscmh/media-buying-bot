-- Polish-9.1: extend the concepts bucket mime allowlist to include
-- static images. The original 0006 migration only listed video mime
-- types because the Polish-2 era only handled UGC. Static concepts
-- worked via server-action upload because the SDK path didn't enforce
-- allowed_mime_types — but the new signed-URL direct upload (Polish-9.1)
-- DOES enforce them at the bucket level.
--
-- Idempotent: upserts the bucket row with the extended mime list. Other
-- fields (public, file_size_limit) stay at their original values via
-- on conflict do update.

update storage.buckets
   set allowed_mime_types = array[
         'video/mp4',
         'video/quicktime',
         'video/x-m4v',
         'video/webm',
         'image/png',
         'image/jpeg',
         'image/webp'
       ]
 where id = 'concepts';

-- Polish-25.3 Commit 18b-hotfix-2: flip generated-creatives to public.
--
-- Root cause: the initial 0006_storage_buckets.sql declared the bucket
-- `public=false`, but packages/jobs/src/lib/storage.ts:uploadGeneratedImage
-- persists `supabase.storage.from('generated-creatives').getPublicUrl(path).data.publicUrl`
-- to generated_creatives.file_url. On a private bucket, getPublicUrl()
-- still returns a `.../object/public/...` URL, but that URL returns
-- 400 on GET without a signed token — every generated image /video
-- URL rendered by the review page would silently fail.
--
-- The docstring in storage.ts:60-61 has always asserted the bucket
-- is public. Some environments had it flipped in the Supabase
-- dashboard out-of-band (which is why UGC video variants rendered);
-- others (including operator's fresh install) did not, which is
-- why the Polish-25.3 static-ad walkthrough surfaced this as a
-- new "images don't render" bug on 18b.
--
-- Public IS the correct posture for this bucket: the deliverables
-- are Meta ad creatives — Meta itself fetches them by URL and
-- displays them to millions of viewers. Nothing in the bucket is
-- meant to stay private. The `select to authenticated` RLS policy
-- from 0006 becomes redundant but stays in place (defense in
-- depth — writes are still gated to service_role via the absence
-- of an INSERT policy).
--
-- Idempotent: the update is a no-op when the bucket is already
-- public.

update storage.buckets
  set public = true
  where id = 'generated-creatives';

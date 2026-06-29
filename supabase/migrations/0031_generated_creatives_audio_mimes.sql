-- Polish-19.0.2 hotfix: extend the generated-creatives bucket's mime
-- allowlist to include audio types. The Polish-11 cinematic-voiceover
-- pipeline added the uploadGeneratedAudio helper but never landed a
-- matching migration here — the bucket has rejected every audio upload
-- since (silently latent until Polish-19's Kling Avatar v2 worker
-- exercised it end-to-end in live mode).
--
-- ElevenLabs returns audio/mpeg for mp3 output. kie.ai's Kling Avatar
-- v2 audio_url accepts mpeg/wav/aac/mp4/ogg per its public docs
-- (kie.ai/docs/kling-avatar-v2). Add all five so future TTS providers
-- (Cartesia, PlayHT, etc.) don't need another migration.
--
-- Idempotent: pure UPDATE on the existing row. Other fields (public,
-- file_size_limit, the three pre-existing video/image mimes) are
-- preserved by listing them explicitly.

update storage.buckets
   set allowed_mime_types = array[
         -- pre-existing (0006_storage_buckets.sql)
         'video/mp4',
         'image/png',
         'image/jpeg',
         -- Polish-19.0.2: audio types for TTS-driven pipelines
         'audio/mpeg',  -- canonical MP3 (ElevenLabs default)
         'audio/mp3',   -- alias some callers send instead of audio/mpeg
         'audio/wav',
         'audio/x-wav', -- alias for WAV some HTTP libs emit
         'audio/aac',
         'audio/mp4',
         'audio/ogg'
       ]
 where id = 'generated-creatives';

-- Polish-3: per-concept user-editable name.
--
-- Previously the concepts list/detail surfaces fell back to
-- staticHeadline or content_type for a label, which made the list
-- read as "Static · Static · Static" once you had a few uploads.
-- This column gives every concept a stable, editable display name.
--
-- Default pre-fill: at upload time, the form sets name to the
-- filename with its extension stripped. NULL on legacy rows; UI
-- falls back to staticHeadline / contentType when null.

alter table public.concepts
  add column if not exists name text;

-- Polish-28.0.0 Commit 64: first-time acknowledgment of the HeyGen
-- Avatar IV likeness-rights TOS.
--
-- HeyGen's Avatar IV image-to-video accepts arbitrary reference images
-- but their Acceptable Use policy assigns liability for likeness rights
-- to the caller (see help.heygen.com articles on avatar consent). The
-- Polish-28 generation form surfaces a one-time acknowledgment modal
-- before the first cloned-UGC dispatch; this column stores the
-- timestamp so the modal fires exactly once per user.
--
-- NULL = user has never fired a Polish-28 job → modal required on next
-- generation attempt. Non-NULL = timestamp of acknowledgment; modal
-- suppressed.
--
-- Additive migration — safe on live rows. Existing users get NULL and
-- see the modal on their first Polish-28 attempt.

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS polish28_rights_accepted_at timestamptz;

COMMENT ON COLUMN public.user_settings.polish28_rights_accepted_at IS
  'Polish-28.0.0 Commit 64: timestamp of user acknowledgment of the HeyGen Avatar IV likeness-rights TOS. NULL = never acknowledged; first Polish-28 generation attempt surfaces the modal. Non-NULL = timestamp of acceptance; modal suppressed thereafter.';

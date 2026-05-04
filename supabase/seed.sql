-- Local-dev seed. Safe to re-run.

-- Default global feature flag for the dry-run safety gate, off by default.
-- Toggle via admin panel later.
insert into public.feature_flags (flag_name, enabled, scope, description)
values
  ('meta_api.live_writes', false, 'global',
   'Master flag: when false, all Meta mutation jobs are skipped entirely (additional safety on top of BOT_DRY_RUN env).')
on conflict do nothing;

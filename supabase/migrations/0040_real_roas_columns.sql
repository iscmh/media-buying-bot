-- Polish-25.7 Commit 39 (Part B): real ROAS from Meta insights
-- action_values + user-configurable assumed conversion value fallback.
--
-- Two additive columns, no data migration needed. Existing rows read
-- as 0 for launched_ads.conversion_value_usd (falls back to heuristic
-- via user_settings.assumed_conversion_value_usd × conversions) and
-- default $20 for the assumed value (matches the hardcoded
-- ASSUMED_CONVERSION_VALUE_USD in @mbb/shared/safety.ts that was in
-- use pre-Commit-39).
--
-- Both are numeric(10,2). Positive-only check on assumed value —
-- makes no sense to configure a negative or zero conversion value.

alter table launched_ads
  add column if not exists conversion_value_usd numeric(10, 2) not null default 0;

comment on column launched_ads.conversion_value_usd is
  'Polish-25.7 Commit 39: sum of Meta insights action_values (purchase / omni_purchase / lead_value / etc.) in USD, populated by poll-ad-performance every tick. Zero when Meta returns no value data — dashboard falls back to user_settings.assumed_conversion_value_usd × meta_conversions.';

alter table user_settings
  add column if not exists assumed_conversion_value_usd numeric(10, 2)
    not null
    default 20.00;

alter table user_settings
  add constraint user_settings_assumed_conversion_value_positive
  check (assumed_conversion_value_usd > 0);

comment on column user_settings.assumed_conversion_value_usd is
  'Polish-25.7 Commit 39: per-user override for the assumed dollar value of one conversion, used when Meta insights returns conversions but no action_values. Default $20 (matches the pre-Commit-39 ASSUMED_CONVERSION_VALUE_USD constant). Media buyers configure this to match their offer AOV so implied-ROAS reads meaningfully.';

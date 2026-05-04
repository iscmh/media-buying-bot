-- Hot-path indexes. RLS adds (user_id = auth.uid()) to most queries, so
-- nearly every user-scoped table benefits from a (user_id) index, often
-- composite with (created_at desc) for dashboards.

create index if not exists idx_meta_connections_user_id      on public.meta_connections (user_id);
create index if not exists idx_telegram_connections_user_id  on public.telegram_connections (user_id);
create index if not exists idx_ai_provider_connections_user  on public.ai_provider_connections (user_id);

create index if not exists idx_concepts_user_created
  on public.concepts (user_id, created_at desc);

create index if not exists idx_generation_jobs_user_status
  on public.generation_jobs (user_id, status);

create index if not exists idx_generated_creatives_user_job
  on public.generated_creatives (user_id, generation_job_id);

create index if not exists idx_campaigns_user             on public.campaigns (user_id);
create index if not exists idx_ad_sets_user_campaign      on public.ad_sets (user_id, campaign_id);
create index if not exists idx_ads_user_status            on public.ads (user_id, status);
create index if not exists idx_ads_ad_set                 on public.ads (ad_set_id);

create index if not exists idx_performance_logs_ad_hour
  on public.performance_logs (ad_id, hour_mark);

create index if not exists idx_daily_summaries_user_date
  on public.daily_summaries (user_id, date desc);

create index if not exists idx_audit_logs_user_created
  on public.audit_logs (user_id, created_at desc);

create index if not exists idx_meta_api_call_logs_user_called
  on public.meta_api_call_logs (user_id, called_at desc);

create index if not exists idx_user_pause_log_user_active
  on public.user_pause_log (user_id) where unpaused_at is null;

create index if not exists idx_rate_limit_events_user_hit
  on public.rate_limit_events (user_id, hit_at desc);

create index if not exists idx_partner_referrals_user      on public.partner_referrals (user_id);
create index if not exists idx_partner_referrals_partner   on public.partner_referrals (partner_id);

create unique index if not exists uniq_feature_flags_global
  on public.feature_flags (flag_name) where scope = 'global';
create unique index if not exists uniq_feature_flags_user
  on public.feature_flags (flag_name, user_id) where scope = 'user';

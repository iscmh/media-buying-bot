import { pgEnum } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

export const connectionMethodEnum = pgEnum('connection_method', ['byok', 'oauth']);

export const connectionStatusEnum = pgEnum('connection_status', [
  'pending',
  'active',
  'expired',
  'revoked',
  'error',
]);

export const aiProviderEnum = pgEnum('ai_provider', ['arcads', 'heygen', 'creatify']);

export const campaignObjectiveEnum = pgEnum('campaign_objective', ['CBO', 'ABO']);

export const conceptContentTypeEnum = pgEnum('concept_content_type', ['video', 'text']);

export const conceptStatusEnum = pgEnum('concept_status', [
  'pending_review',
  'approved',
  'rejected',
  'archived',
]);

export const generationJobStatusEnum = pgEnum('generation_job_status', [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
]);

export const creativeStatusEnum = pgEnum('creative_status', [
  'pending',
  'ready',
  'launched',
  'rejected',
  'archived',
]);

export const adStatusEnum = pgEnum('ad_status', [
  'pending',
  'launching',
  'active',
  'killed',
  'scaled',
  'completed',
  'rejected',
  'paused',
]);

export const aspectRatioEnum = pgEnum('aspect_ratio', ['9:16', '1:1', '4:5']);

export const pauseActorEnum = pgEnum('pause_actor', ['user', 'admin', 'auto']);

export const partnerStatusEnum = pgEnum('partner_status', ['active', 'inactive', 'pending']);

export const partnerReferralStatusEnum = pgEnum('partner_referral_status', [
  'referred',
  'signup_confirmed',
  'bm_provisioned',
  'churned',
]);

export const featureFlagScopeEnum = pgEnum('feature_flag_scope', ['global', 'user']);

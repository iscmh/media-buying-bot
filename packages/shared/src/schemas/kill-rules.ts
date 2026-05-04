import { z } from 'zod';

export const KillReasonSchema = z.enum([
  'cpc_high_ctr_low',
  'cpc_high_ctr_ok_grace_failed',
  'no_conversions_hour_6',
  'manual_user_kill',
  'manual_admin_kill',
  'auto_pause_suspicious',
  'platform_ceiling_breach',
  'rejected_by_meta',
]);

export type KillReason = z.infer<typeof KillReasonSchema>;

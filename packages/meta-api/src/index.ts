export { callMeta, type MetaCallInput, type MetaCallResult } from './client';
export { isRateLimitError, RATE_LIMIT_ERROR_CODES } from './errors';
export {
  createCampaign,
  createAdSet,
  createAdCreative,
  createAd,
  uploadAdImage,
  deleteCampaign,
  deleteAdSet,
  effectiveLaunchMode,
  type CreateCampaignInput,
  type CreateAdSetInput,
  type CreateAdCreativeInput,
  type CreateAdInput,
  type UploadAdImageInput,
  type UploadAdImageResult,
  type DeleteMetaObjectInput,
  type LaunchMode,
  type MetaCreateResult,
} from './launch';
export { fetchUserPages, type MetaPageSummary } from './pages';
export {
  getAdInsights,
  type AdInsights,
  type GetAdInsightsInput,
  type GetAdInsightsResult,
} from './insights';
export {
  pauseAd,
  scaleAdBudget,
  type PauseAdInput,
  type ScaleAdBudgetInput,
  type LifecycleResult,
} from './lifecycle';

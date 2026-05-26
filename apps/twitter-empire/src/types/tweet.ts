export type TweetType =
  | 'sauce'
  | 'hot-take'
  | 'story'
  | 'flex'
  | 'launch'
  | 'personal'
  | 'engagement'
  | 'callout';
export type TweetRarity = 'common' | 'rare' | 'epic' | 'legendary';
export type TweetStatus = 'draft' | 'ready' | 'deployed';
export type PerformanceRating = 'flop' | 'mid' | 'heat' | 'viral' | 'legendary';

export interface Tweet {
  id: string;
  accountId: string;
  text: string;
  type: TweetType;
  status: TweetStatus;
  views: number;
  likes: number;
  replies: number;
  retweets: number;
  xpEarned: number;
  createdAt: string;
  deployedAt: string | null;
}

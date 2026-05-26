export type AchievementCategory = 'setup' | 'growth' | 'revenue' | 'consistency' | 'mastery';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  category: AchievementCategory;
  icon: string;
  xpReward: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

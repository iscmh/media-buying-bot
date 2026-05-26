export type AccountHealth = 'healthy' | 'warning' | 'dying' | 'dead';

export interface TwitterAccount {
  id: string;
  handle: string;
  niche: string;
  color: string;
  level: number;
  xp: number;
  followers: number;
  revenue: number;
  notes: string;
  tweetsPosted: number;
  avgViews: number;
  currentStreak: number;
  lastPostedAt: string | null;
  createdAt: string;
  gridPosition: { row: number; col: number };
}

export interface LevelRequirement {
  level: number;
  followers: number;
  revenue?: number;
  tweets?: number;
  tweetsOver5K?: number;
  tweetsOver10K?: number;
}

export type QuestPeriod = 'daily' | 'weekly' | 'monthly';
export type QuestStatus = 'active' | 'completed' | 'failed';

export interface Quest {
  id: string;
  period: QuestPeriod;
  title: string;
  description: string;
  xpReward: number;
  xpPenalty: number;
  status: QuestStatus;
  progress: number;
  target: number;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}

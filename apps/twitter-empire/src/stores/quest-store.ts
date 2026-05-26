import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Quest, QuestPeriod } from '@/types';
import { generateId } from '@/lib/utils';

interface QuestState {
  quests: Quest[];
  lastDailyReset: string | null;

  addQuest: (quest: {
    period: QuestPeriod;
    title: string;
    description: string;
    xpReward: number;
    target: number;
  }) => void;
  completeQuest: (id: string) => void;
  failQuest: (id: string) => void;
  updateQuestProgress: (id: string, progress: number) => void;
  removeQuest: (id: string) => void;
  generateDailyGoals: (accountHandles: string[]) => void;
  getQuestsByPeriod: (period: QuestPeriod) => Quest[];
}

function getExpiresAt(period: QuestPeriod): string {
  const now = new Date();
  if (period === 'daily') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.toISOString();
  }
  if (period === 'weekly') {
    const nextSunday = new Date(now);
    nextSunday.setDate(nextSunday.getDate() + (7 - nextSunday.getDay()));
    nextSunday.setHours(23, 59, 59, 999);
    return nextSunday.toISOString();
  }
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return endOfMonth.toISOString();
}

export const useQuestStore = create<QuestState>()(
  persist(
    (set, get) => ({
      quests: [],
      lastDailyReset: null,

      addQuest: (quest) =>
        set((state) => ({
          quests: [
            ...state.quests,
            {
              ...quest,
              id: generateId(),
              xpPenalty: quest.period === 'weekly' ? 50 : 0,
              status: 'active',
              progress: 0,
              createdAt: new Date().toISOString(),
              expiresAt: getExpiresAt(quest.period),
              completedAt: null,
            },
          ],
        })),

      completeQuest: (id) =>
        set((state) => ({
          quests: state.quests.map((q) =>
            q.id === id
              ? {
                  ...q,
                  status: 'completed',
                  progress: q.target,
                  completedAt: new Date().toISOString(),
                }
              : q,
          ),
        })),

      failQuest: (id) =>
        set((state) => ({
          quests: state.quests.map((q) => (q.id === id ? { ...q, status: 'failed' } : q)),
        })),

      updateQuestProgress: (id, progress) =>
        set((state) => ({
          quests: state.quests.map((q) =>
            q.id === id ? { ...q, progress: Math.min(progress, q.target) } : q,
          ),
        })),

      removeQuest: (id) => set((state) => ({ quests: state.quests.filter((q) => q.id !== id) })),

      generateDailyGoals: (accountHandles) => {
        const today = new Date().toISOString().split('T')[0];
        const state = get();
        if (state.lastDailyReset === today) return;

        const existingDaily = state.quests.filter(
          (q) => q.period === 'daily' && q.status === 'active',
        );
        const failedIds = existingDaily.map((q) => q.id);

        const goals: Omit<Quest, 'id'>[] = [];
        const topAccounts = accountHandles.slice(0, 3);
        for (const handle of topAccounts) {
          goals.push({
            period: 'daily',
            title: `Post on ${handle}`,
            description: `Deploy a tweet on ${handle}`,
            xpReward: 10,
            xpPenalty: 0,
            status: 'active',
            progress: 0,
            target: 1,
            createdAt: new Date().toISOString(),
            expiresAt: getExpiresAt('daily'),
            completedAt: null,
          });
        }
        goals.push({
          period: 'daily',
          title: 'Write 2 draft tweets',
          description: 'Create 2 new tweet drafts',
          xpReward: 10,
          xpPenalty: 0,
          status: 'active',
          progress: 0,
          target: 2,
          createdAt: new Date().toISOString(),
          expiresAt: getExpiresAt('daily'),
          completedAt: null,
        });
        goals.push({
          period: 'daily',
          title: 'Update stats on one account',
          description: 'Update follower count or revenue on any account',
          xpReward: 5,
          xpPenalty: 0,
          status: 'active',
          progress: 0,
          target: 1,
          createdAt: new Date().toISOString(),
          expiresAt: getExpiresAt('daily'),
          completedAt: null,
        });

        set((state) => ({
          quests: [
            ...state.quests
              .filter((q) => !failedIds.includes(q.id))
              .map((q) => (failedIds.includes(q.id) ? { ...q, status: 'failed' as const } : q)),
            ...goals.map((g) => ({ ...g, id: generateId() })),
          ],
          lastDailyReset: today,
        }));
      },

      getQuestsByPeriod: (period) => get().quests.filter((q) => q.period === period),
    }),
    { name: 'te-quests' },
  ),
);

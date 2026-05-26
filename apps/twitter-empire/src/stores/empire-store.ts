import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TwitterAccount } from '@/types';
import { DEFAULT_ACCOUNTS } from '@/lib/constants';
import { generateId } from '@/lib/utils';

interface EmpireState {
  accounts: TwitterAccount[];
  totalXP: number;
  currentStreak: number;
  longestStreak: number;
  streakStartDate: string | null;
  lastActiveDate: string | null;
  revenueHistory: { month: string; amount: number }[];

  addAccount: (
    account: Omit<
      TwitterAccount,
      | 'id'
      | 'createdAt'
      | 'tweetsPosted'
      | 'avgViews'
      | 'currentStreak'
      | 'lastPostedAt'
      | 'xp'
      | 'gridPosition'
    >,
  ) => void;
  removeAccount: (id: string) => void;
  updateAccount: (id: string, updates: Partial<TwitterAccount>) => void;
  addXP: (accountId: string, xp: number) => void;
  addGlobalXP: (xp: number) => void;
  levelUpAccount: (id: string) => void;
  recordPost: (accountId: string) => void;
  updateStreak: () => void;
  addRevenueEntry: (month: string, amount: number) => void;
}

function getNextGridPosition(accounts: TwitterAccount[]): { row: number; col: number } {
  const used = new Set(accounts.map((a) => `${a.gridPosition.row},${a.gridPosition.col}`));
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 5; col++) {
      if (!used.has(`${row},${col}`)) return { row, col };
    }
  }
  return { row: accounts.length, col: 0 };
}

export const useEmpireStore = create<EmpireState>()(
  persist(
    (set) => ({
      accounts: DEFAULT_ACCOUNTS,
      totalXP: 0,
      currentStreak: 0,
      longestStreak: 0,
      streakStartDate: null,
      lastActiveDate: null,
      revenueHistory: [],

      addAccount: (account) =>
        set((state) => ({
          accounts: [
            ...state.accounts,
            {
              ...account,
              id: generateId(),
              xp: 0,
              tweetsPosted: 0,
              avgViews: 0,
              currentStreak: 0,
              lastPostedAt: null,
              createdAt: new Date().toISOString(),
              gridPosition: getNextGridPosition(state.accounts),
            },
          ],
        })),

      removeAccount: (id) =>
        set((state) => ({
          accounts: state.accounts.filter((a) => a.id !== id),
        })),

      updateAccount: (id, updates) =>
        set((state) => ({
          accounts: state.accounts.map((a) => (a.id === id ? { ...a, ...updates } : a)),
        })),

      addXP: (accountId, xp) =>
        set((state) => ({
          accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, xp: a.xp + xp } : a)),
          totalXP: state.totalXP + xp,
        })),

      addGlobalXP: (xp) =>
        set((state) => ({
          totalXP: state.totalXP + xp,
        })),

      levelUpAccount: (id) =>
        set((state) => ({
          accounts: state.accounts.map((a) =>
            a.id === id ? { ...a, level: a.level + 1, xp: 0 } : a,
          ),
        })),

      recordPost: (accountId) =>
        set((state) => ({
          accounts: state.accounts.map((a) =>
            a.id === accountId
              ? {
                  ...a,
                  tweetsPosted: a.tweetsPosted + 1,
                  lastPostedAt: new Date().toISOString(),
                  currentStreak: a.currentStreak + 1,
                }
              : a,
          ),
        })),

      updateStreak: () =>
        set((state) => {
          const today = new Date().toISOString().split('T')[0];
          if (state.lastActiveDate === today) return state;

          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().split('T')[0];

          const isConsecutive = state.lastActiveDate === yesterdayStr;
          const newStreak = isConsecutive ? state.currentStreak + 1 : 1;

          return {
            currentStreak: newStreak,
            longestStreak: Math.max(newStreak, state.longestStreak),
            streakStartDate: isConsecutive ? state.streakStartDate : today,
            lastActiveDate: today,
          };
        }),

      addRevenueEntry: (month, amount) =>
        set((state) => {
          const existing = state.revenueHistory.findIndex((r) => r.month === month);
          if (existing >= 0) {
            const updated = [...state.revenueHistory];
            updated[existing] = { month, amount };
            return { revenueHistory: updated };
          }
          return { revenueHistory: [...state.revenueHistory, { month, amount }] };
        }),
    }),
    { name: 'te-empire' },
  ),
);

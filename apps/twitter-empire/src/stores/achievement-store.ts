import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Achievement, AchievementCategory } from '@/types';

const ALL_ACHIEVEMENTS: Omit<Achievement, 'unlocked' | 'unlockedAt'>[] = [
  // Setup
  {
    id: 'first-blood',
    name: 'First Blood',
    description: 'Post first tweet on any account',
    category: 'setup',
    icon: '⚔️',
    xpReward: 100,
  },
  {
    id: 'the-network',
    name: 'The Network',
    description: 'Have 5+ active accounts',
    category: 'setup',
    icon: '🕸️',
    xpReward: 200,
  },
  {
    id: 'full-deploy',
    name: 'Full Deploy',
    description: 'Post on every account in a single day',
    category: 'setup',
    icon: '🚀',
    xpReward: 300,
  },
  // Growth
  {
    id: 'spark',
    name: 'Spark',
    description: 'First tweet over 1K views',
    category: 'growth',
    icon: '✨',
    xpReward: 100,
  },
  {
    id: 'wildfire',
    name: 'Wildfire',
    description: 'First tweet over 10K views',
    category: 'growth',
    icon: '🔥',
    xpReward: 200,
  },
  {
    id: 'nuclear',
    name: 'Nuclear',
    description: 'First tweet over 100K views',
    category: 'growth',
    icon: '☢️',
    xpReward: 500,
  },
  {
    id: 'army',
    name: 'Army',
    description: 'Reach 1K total followers',
    category: 'growth',
    icon: '🪖',
    xpReward: 150,
  },
  {
    id: 'legion',
    name: 'Legion',
    description: 'Reach 10K total followers',
    category: 'growth',
    icon: '⚔️',
    xpReward: 300,
  },
  {
    id: 'nation',
    name: 'Nation',
    description: 'Reach 50K total followers',
    category: 'growth',
    icon: '🏴',
    xpReward: 500,
  },
  // Revenue
  {
    id: 'cha-ching',
    name: 'Cha-Ching',
    description: 'First dollar earned',
    category: 'revenue',
    icon: '💰',
    xpReward: 200,
  },
  {
    id: 'comma-club',
    name: 'Comma Club',
    description: 'First $1K month',
    category: 'revenue',
    icon: '💎',
    xpReward: 300,
  },
  {
    id: 'five-figures',
    name: 'Five Figures',
    description: 'First $10K month',
    category: 'revenue',
    icon: '🏆',
    xpReward: 500,
  },
  {
    id: 'six-figures',
    name: 'Six Figures',
    description: 'First $100K month',
    category: 'revenue',
    icon: '👑',
    xpReward: 500,
  },
  // Consistency
  {
    id: 'no-days-off',
    name: 'No Days Off',
    description: '30 day posting streak',
    category: 'consistency',
    icon: '📅',
    xpReward: 300,
  },
  {
    id: 'marathon',
    name: 'Marathon',
    description: '90 day posting streak',
    category: 'consistency',
    icon: '🏃',
    xpReward: 400,
  },
  {
    id: 'immortal',
    name: 'Immortal',
    description: '365 day posting streak',
    category: 'consistency',
    icon: '♾️',
    xpReward: 500,
  },
  // Mastery
  {
    id: 'puppet-master',
    name: 'Puppet Master',
    description: '3+ accounts earning revenue',
    category: 'mastery',
    icon: '🎭',
    xpReward: 300,
  },
  {
    id: 'silent-killer',
    name: 'Silent Killer',
    description: 'Post on all accounts in one day',
    category: 'mastery',
    icon: '🥷',
    xpReward: 200,
  },
  {
    id: 'the-machine',
    name: 'The Machine',
    description: 'Complete all daily goals for 7 days straight',
    category: 'mastery',
    icon: '⚙️',
    xpReward: 400,
  },
  {
    id: 'legendary',
    name: 'Legendary',
    description: 'Get a tweet over 100K views',
    category: 'mastery',
    icon: '🌟',
    xpReward: 500,
  },
  {
    id: 'empire',
    name: 'Empire',
    description: 'All accounts at Level 5+',
    category: 'mastery',
    icon: '🏰',
    xpReward: 500,
  },
  {
    id: 'god-mode',
    name: 'God Mode',
    description: 'All accounts at Level 8+, $100K/month',
    category: 'mastery',
    icon: '👁️',
    xpReward: 500,
  },
];

interface AchievementState {
  achievements: Achievement[];
  unlockAchievement: (id: string) => boolean;
  isUnlocked: (id: string) => boolean;
  getByCategory: (category: AchievementCategory) => Achievement[];
}

export const useAchievementStore = create<AchievementState>()(
  persist(
    (set, get) => ({
      achievements: ALL_ACHIEVEMENTS.map((a) => ({ ...a, unlocked: false, unlockedAt: null })),

      unlockAchievement: (id) => {
        const state = get();
        const achievement = state.achievements.find((a) => a.id === id);
        if (!achievement || achievement.unlocked) return false;
        set({
          achievements: state.achievements.map((a) =>
            a.id === id ? { ...a, unlocked: true, unlockedAt: new Date().toISOString() } : a,
          ),
        });
        return true;
      },

      isUnlocked: (id) => {
        const a = get().achievements.find((a) => a.id === id);
        return a?.unlocked ?? false;
      },

      getByCategory: (category) => get().achievements.filter((a) => a.category === category),
    }),
    { name: 'te-achievements' },
  ),
);

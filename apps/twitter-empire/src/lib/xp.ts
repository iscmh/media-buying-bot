import { STREAK_MULTIPLIERS, EMPIRE_LEVEL_XP, PERFORMANCE_THRESHOLDS } from './constants';
import type { PerformanceRating, AccountHealth } from '@/types';

export function getStreakMultiplier(streakDays: number): number {
  for (const { minDays, multiplier } of STREAK_MULTIPLIERS) {
    if (streakDays >= minDays) return multiplier;
  }
  return 1;
}

export function getEmpireLevel(totalXP: number): number {
  for (let i = EMPIRE_LEVEL_XP.length - 1; i >= 0; i--) {
    if (totalXP >= EMPIRE_LEVEL_XP[i]) return i + 1;
  }
  return 1;
}

export function getEmpireLevelProgress(totalXP: number): {
  current: number;
  next: number;
  progress: number;
} {
  const level = getEmpireLevel(totalXP);
  const currentThreshold = EMPIRE_LEVEL_XP[level - 1] ?? 0;
  const nextThreshold = EMPIRE_LEVEL_XP[level] ?? EMPIRE_LEVEL_XP[EMPIRE_LEVEL_XP.length - 1] * 2;
  const progress = (totalXP - currentThreshold) / (nextThreshold - currentThreshold);
  return { current: currentThreshold, next: nextThreshold, progress: Math.min(progress, 1) };
}

export function calculateTweetXP(views: number, streakDays: number): number {
  let xp = 10;
  if (views >= 100_000) xp += 500;
  else if (views >= 25_000) xp += 100;
  else if (views >= 10_000) xp += 50;
  else if (views >= 5_000) xp += 25;
  else if (views >= 1_000) xp += 10;

  return Math.floor(xp * getStreakMultiplier(streakDays));
}

export function getPerformanceRating(views: number): PerformanceRating {
  for (const t of PERFORMANCE_THRESHOLDS) {
    if (views >= t.min) return t.rating;
  }
  return 'flop';
}

export function getPerformanceDisplay(views: number): {
  emoji: string;
  label: string;
  rating: PerformanceRating;
} {
  for (const t of PERFORMANCE_THRESHOLDS) {
    if (views >= t.min) return { emoji: t.emoji, label: t.label, rating: t.rating };
  }
  return { emoji: '💀', label: 'Flop', rating: 'flop' };
}

export function getAccountHealth(lastPostedAt: string | null): AccountHealth {
  if (!lastPostedAt) return 'dead';
  const days = Math.floor((Date.now() - new Date(lastPostedAt).getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'healthy';
  if (days <= 1) return 'warning';
  if (days < 7) return 'dying';
  return 'dead';
}

export function getAccountLevelProgress(level: number, xp: number): number {
  const xpPerLevel = 100 * level;
  return Math.min(xp / xpPerLevel, 1);
}

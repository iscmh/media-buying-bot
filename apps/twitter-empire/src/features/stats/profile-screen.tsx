import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, Users, Zap, Flame, Trophy, BarChart3 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { useEmpireStore } from '@/stores/empire-store';
import { useAchievementStore } from '@/stores/achievement-store';
import { useTweetStore } from '@/stores/tweet-store';
import { formatNumber, formatCurrency, cn } from '@/lib/utils';
import { getEmpireLevel, getEmpireLevelProgress, getStreakMultiplier } from '@/lib/xp';
import { ProgressBar } from '@/components/ui/progress-bar';
import type { AchievementCategory } from '@/types';

const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  setup: 'Setup',
  growth: 'Growth',
  revenue: 'Revenue',
  consistency: 'Consistency',
  mastery: 'Mastery',
};

export function ProfileScreen() {
  const { accounts, totalXP, currentStreak, longestStreak, revenueHistory } = useEmpireStore();
  const achievements = useAchievementStore((s) => s.achievements);
  const tweets = useTweetStore((s) => s.tweets.filter((t) => t.status === 'deployed'));
  const [tab, setTab] = useState<'stats' | 'achievements'>('stats');

  const empireLevel = getEmpireLevel(totalXP);
  const { progress, next } = getEmpireLevelProgress(totalXP);
  const streakMultiplier = getStreakMultiplier(currentStreak);
  const totalFollowers = accounts.reduce((sum, a) => sum + a.followers, 0);
  const totalRevenue = accounts.reduce((sum, a) => sum + a.revenue, 0);
  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => b.xp + b.level * 1000 - (a.xp + a.level * 1000)),
    [accounts],
  );

  const chartData =
    revenueHistory.length > 0 ? revenueHistory.slice(-6) : [{ month: 'Now', amount: totalRevenue }];

  return (
    <div className="bg-empire-bg min-h-screen px-4 pb-4 pt-4">
      {/* Empire header */}
      <div className="game-card mb-4 text-center">
        <div className="from-empire-gold font-display shadow-glow-gold mx-auto mb-2 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br to-yellow-600 text-3xl text-black">
          {empireLevel}
        </div>
        <h1 className="font-display text-2xl text-white">Empire Level {empireLevel}</h1>
        <p className="text-empire-silver mb-2 text-xs">
          {formatNumber(totalXP)} / {formatNumber(next)} XP
        </p>
        <ProgressBar
          value={progress}
          color="bg-gradient-to-r from-empire-gold to-yellow-500"
          className="mx-auto max-w-xs"
        />
      </div>

      {/* Tab switch */}
      <div className="mb-4 flex gap-1 rounded-xl bg-white/5 p-1">
        <button
          onClick={() => setTab('stats')}
          className={cn(
            'font-display flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm transition-colors',
            tab === 'stats' ? 'bg-empire-accent text-white' : 'text-empire-silver',
          )}
        >
          <BarChart3 size={14} /> Stats
        </button>
        <button
          onClick={() => setTab('achievements')}
          className={cn(
            'font-display flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm transition-colors',
            tab === 'achievements' ? 'bg-empire-accent text-white' : 'text-empire-silver',
          )}
        >
          <Trophy size={14} /> Achievements ({unlockedCount}/{achievements.length})
        </button>
      </div>

      {tab === 'stats' ? (
        <div className="space-y-4">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              icon={<TrendingUp className="text-green-400" size={18} />}
              value={formatCurrency(totalRevenue)}
              label="Total Revenue"
            />
            <StatCard
              icon={<Users className="text-blue-400" size={18} />}
              value={formatNumber(totalFollowers)}
              label="Total Followers"
            />
            <StatCard
              icon={<Zap className="text-empire-xp" size={18} />}
              value={String(tweets.length)}
              label="Tweets This Month"
            />
            <StatCard
              icon={<Flame className="text-orange-400" size={18} />}
              value={`${currentStreak}d`}
              label="Current Streak"
            />
          </div>

          {/* Streak info */}
          <div className="game-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-display text-sm text-white">Streak Multiplier</p>
                <p className="text-empire-silver text-xs">Longest: {longestStreak} days</p>
              </div>
              <div className="text-right">
                <p className="font-display text-empire-gold text-2xl">{streakMultiplier}x</p>
                <p className="text-empire-silver text-[10px]">
                  {currentStreak < 7
                    ? '7d for 1.5x'
                    : currentStreak < 14
                      ? '14d for 2x'
                      : currentStreak < 30
                        ? '30d for 3x'
                        : 'MAX!'}
                </p>
              </div>
            </div>
          </div>

          {/* Revenue chart */}
          <div className="game-card">
            <h3 className="font-display text-empire-silver mb-3 text-sm">Revenue</h3>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <XAxis
                    dataKey="month"
                    tick={{ fill: '#94a3b8', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#94a3b8', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#1a1a2e',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Bar dataKey="amount" fill="#fbbf24" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Account leaderboard */}
          <div className="game-card">
            <h3 className="font-display text-empire-silver mb-3 text-sm">Account Rankings</h3>
            <div className="space-y-2">
              {sortedAccounts.map((account, i) => (
                <div key={account.id} className="flex items-center gap-3">
                  <span
                    className="font-display w-6 text-center text-sm"
                    style={{
                      color:
                        i === 0 ? '#fbbf24' : i === 1 ? '#94a3b8' : i === 2 ? '#cd7f32' : '#6b7280',
                    }}
                  >
                    #{i + 1}
                  </span>
                  <div
                    className="h-6 w-6 rounded-full"
                    style={{ backgroundColor: account.color }}
                  />
                  <span className="flex-1 text-sm text-white">{account.handle}</span>
                  <span className="text-empire-silver text-xs">Lv.{account.level}</span>
                  <span className="text-empire-xp font-display text-xs">{account.xp} XP</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {(Object.keys(CATEGORY_LABELS) as AchievementCategory[]).map((category) => {
            const categoryAchievements = achievements.filter((a) => a.category === category);
            return (
              <div key={category}>
                <h3 className="font-display text-empire-silver mb-2 text-sm">
                  {CATEGORY_LABELS[category]}
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  {categoryAchievements.map((achievement) => (
                    <motion.div
                      key={achievement.id}
                      className={cn(
                        'game-card flex flex-col items-center p-3 text-center',
                        !achievement.unlocked && 'opacity-40 grayscale',
                      )}
                      whileHover={achievement.unlocked ? { scale: 1.05 } : undefined}
                    >
                      <span className="mb-1 text-2xl">{achievement.icon}</span>
                      <span className="font-display text-[10px] leading-tight text-white">
                        {achievement.name}
                      </span>
                      <span className="text-empire-silver mt-0.5 text-[9px] leading-tight">
                        {achievement.unlocked ? '✅ Unlocked' : achievement.description}
                      </span>
                      <span className="text-empire-xp font-display mt-0.5 text-[9px]">
                        +{achievement.xpReward} XP
                      </span>
                    </motion.div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="game-card flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5">
        {icon}
      </div>
      <div>
        <p className="font-display text-lg text-white">{value}</p>
        <p className="text-empire-silver text-[10px] uppercase tracking-wider">{label}</p>
      </div>
    </div>
  );
}

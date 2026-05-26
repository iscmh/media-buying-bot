import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { BUILDING_EMOJIS } from '@/lib/constants';
import { getAccountHealth, getAccountLevelProgress } from '@/lib/xp';
import { ProgressBar } from '@/components/ui/progress-bar';
import type { TwitterAccount } from '@/types';

interface BuildingTileProps {
  account: TwitterAccount;
  onClick: () => void;
}

export function BuildingTile({ account, onClick }: BuildingTileProps) {
  const health = getAccountHealth(account.lastPostedAt);
  const levelProgress = getAccountLevelProgress(account.level, account.xp);
  const building = BUILDING_EMOJIS[Math.min(account.level, 10)] ?? '🛖';
  const isHighLevel = account.level >= 5;

  return (
    <motion.button
      onClick={onClick}
      className={cn(
        'relative flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border p-2 transition-all',
        'bg-gradient-to-b from-white/5 to-white/[0.02]',
        isHighLevel
          ? 'border-empire-gold/30 shadow-glow-gold'
          : 'border-white/10 hover:border-white/20',
      )}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.95 }}
    >
      {/* Health indicator dot */}
      <div
        className={cn('absolute right-2 top-2 h-2 w-2 rounded-full', {
          'bg-green-400': health === 'healthy',
          'bg-yellow-400': health === 'warning',
          'animate-pulse bg-red-400': health === 'dying',
          'bg-gray-500': health === 'dead',
        })}
      />

      {/* Level badge */}
      <div className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md bg-white/10">
        <span className="font-display text-empire-gold text-[10px]">{account.level}</span>
      </div>

      {/* Building emoji */}
      <motion.span
        className={cn('text-3xl', isHighLevel && 'animate-float')}
        style={{ filter: isHighLevel ? 'drop-shadow(0 0 8px rgba(251,191,36,0.4))' : undefined }}
      >
        {building}
      </motion.span>

      {/* Handle */}
      <span className="w-full truncate text-center text-[9px] leading-tight text-white/70">
        {account.handle}
      </span>

      {/* XP bar */}
      <ProgressBar value={levelProgress} size="sm" color="bg-empire-xp" className="w-full px-1" />

      {/* Niche color accent at bottom */}
      <div
        className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full opacity-50"
        style={{ backgroundColor: account.color }}
      />
    </motion.button>
  );
}

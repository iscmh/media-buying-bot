import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface ProgressBarProps {
  value: number;
  max?: number;
  color?: string;
  className?: string;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function ProgressBar({
  value,
  max = 1,
  color = 'bg-empire-xp',
  className,
  showLabel,
  size = 'md',
}: ProgressBarProps) {
  const pct = Math.min((value / max) * 100, 100);
  const heights = { sm: 'h-1.5', md: 'h-2.5', lg: 'h-4' };

  return (
    <div className={cn('w-full', className)}>
      <div className={cn('w-full overflow-hidden rounded-full bg-white/10', heights[size])}>
        <motion.div
          className={cn('h-full rounded-full', color)}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
      {showLabel && (
        <p className="text-empire-silver mt-1 text-right text-xs">{Math.round(pct)}%</p>
      )}
    </div>
  );
}

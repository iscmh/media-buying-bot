import { useLocation, useNavigate } from 'react-router-dom';
import { Home, PlusCircle, ScrollText, Swords, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

const TABS: { path: string; icon: typeof Home; label: string; accent?: boolean }[] = [
  { path: '/', icon: Home, label: 'Village' },
  { path: '/battle-log', icon: ScrollText, label: 'Battle Log' },
  { path: '/deploy', icon: PlusCircle, label: 'Deploy', accent: true },
  { path: '/quests', icon: Swords, label: 'Quests' },
  { path: '/profile', icon: Shield, label: 'Profile' },
];

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav className="bg-empire-nav-bg/95 fixed inset-x-0 bottom-0 z-30 border-t border-white/10 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-lg items-center justify-around">
        {TABS.map((tab) => {
          const active = location.pathname === tab.path;
          const Icon = tab.icon;

          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              className={cn(
                'relative flex h-full w-16 flex-col items-center justify-center gap-0.5 transition-colors',
                active ? 'text-empire-gold' : 'text-empire-silver/60',
                tab.accent && !active && 'text-empire-accent',
              )}
            >
              {active && (
                <motion.div
                  layoutId="nav-indicator"
                  className="bg-empire-gold absolute -top-px left-2 right-2 h-0.5 rounded-full"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              <Icon size={tab.accent ? 28 : 22} className={cn(tab.accent && 'drop-shadow-lg')} />
              <span className="text-[10px] font-medium">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

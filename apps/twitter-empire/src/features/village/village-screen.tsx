import { useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, Plus, Target, Coins, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEmpireStore } from '@/stores/empire-store';
import { useNotificationStore } from '@/stores/notification-store';
import { formatNumber, formatCurrency } from '@/lib/utils';
import { getEmpireLevel, getEmpireLevelProgress } from '@/lib/xp';
import { ProgressBar } from '@/components/ui/progress-bar';
import { BuildingTile } from './building-tile';
import { AccountCardModal } from '@/features/account/account-card-modal';
import { AddAccountModal } from './add-account-modal';
import { AlertsModal } from '@/features/alerts/alerts-modal';

export function VillageScreen() {
  const { accounts, totalXP } = useEmpireStore();
  const unreadCount = useNotificationStore((s) => s.unreadCount());
  const navigate = useNavigate();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);

  const empireLevel = getEmpireLevel(totalXP);
  const { progress } = getEmpireLevelProgress(totalXP);
  const totalFollowers = accounts.reduce((sum, a) => sum + a.followers, 0);
  const totalRevenue = accounts.reduce((sum, a) => sum + a.revenue, 0);

  return (
    <div className="bg-empire-bg relative min-h-screen">
      {/* HUD */}
      <div className="bg-empire-bg/90 sticky top-0 z-20 border-b border-white/5 px-4 pb-2 pt-3 backdrop-blur-md">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="from-empire-gold font-display flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br to-yellow-600 text-sm text-black">
              {empireLevel}
            </div>
            <div className="flex-1">
              <p className="text-empire-silver text-xs">Empire Level {empireLevel}</p>
              <ProgressBar
                value={progress}
                size="sm"
                color="bg-gradient-to-r from-empire-gold to-yellow-500"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-sm">
              <Coins size={14} className="text-empire-gold" />
              <span className="font-display text-empire-gold">{formatCurrency(totalRevenue)}</span>
            </div>
            <div className="flex items-center gap-1 text-sm">
              <Users size={14} className="text-blue-400" />
              <span className="font-display text-blue-400">{formatNumber(totalFollowers)}</span>
            </div>
            <button onClick={() => setShowAlerts(true)} className="relative p-1.5">
              <Bell size={18} className="text-empire-silver" />
              {unreadCount > 0 && (
                <span className="bg-empire-accent absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold">
                  {unreadCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Village Grid */}
      <div className="px-4 pb-4 pt-6">
        <div className="relative">
          {/* Isometric-style grid background */}
          <div className="perspective-[800px] grid grid-cols-4 gap-3">
            {accounts.map((account, i) => (
              <motion.div
                key={account.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <BuildingTile account={account} onClick={() => setSelectedAccountId(account.id)} />
              </motion.div>
            ))}
            {/* Add new building button */}
            <motion.button
              onClick={() => setShowAddAccount(true)}
              className="hover:border-empire-gold/30 hover:bg-empire-gold/5 flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-white/10 transition-all active:scale-95"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.95 }}
            >
              <Plus size={24} className="text-white/30" />
              <span className="text-[10px] font-medium text-white/30">Add</span>
            </motion.button>
          </div>
        </div>
      </div>

      {/* Daily Goals FAB */}
      <motion.button
        onClick={() => navigate('/quests')}
        className="from-empire-accent shadow-glow fixed bottom-24 right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br to-red-700"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.9 }}
      >
        <Target size={22} />
      </motion.button>

      {/* Account Card Modal */}
      <AccountCardModal accountId={selectedAccountId} onClose={() => setSelectedAccountId(null)} />

      <AddAccountModal open={showAddAccount} onClose={() => setShowAddAccount(false)} />

      <AlertsModal open={showAlerts} onClose={() => setShowAlerts(false)} />
    </div>
  );
}

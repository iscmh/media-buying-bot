import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Zap, Trash2, Edit3, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEmpireStore } from '@/stores/empire-store';
import { useTweetStore } from '@/stores/tweet-store';
import { formatNumber, formatCurrency } from '@/lib/utils';
import { getAccountHealth, getAccountLevelProgress } from '@/lib/xp';
import { BUILDING_EMOJIS, HEALTH_CONFIG, LEVEL_REQUIREMENTS } from '@/lib/constants';
import { ProgressBar } from '@/components/ui/progress-bar';
import { useToastStore } from '@/components/ui/toast';

interface Props {
  accountId: string | null;
  onClose: () => void;
}

export function AccountCardModal({ accountId, onClose }: Props) {
  const account = useEmpireStore((s) => s.accounts.find((a) => a.id === accountId));
  const updateAccount = useEmpireStore((s) => s.updateAccount);
  const removeAccount = useEmpireStore((s) => s.removeAccount);
  const levelUpAccount = useEmpireStore((s) => s.levelUpAccount);
  const addXP = useEmpireStore((s) => s.addXP);
  const tweets = useTweetStore((s) =>
    s.tweets.filter((t) => t.accountId === accountId && t.status === 'deployed'),
  );
  const showToast = useToastStore((s) => s.show);
  const navigate = useNavigate();

  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [showDelete, setShowDelete] = useState(false);

  if (!account) return null;

  const health = getAccountHealth(account.lastPostedAt);
  const healthConfig = HEALTH_CONFIG[health];
  const levelProgress = getAccountLevelProgress(account.level, account.xp);
  const building = BUILDING_EMOJIS[Math.min(account.level, 10)] ?? '🛖';
  const nextLevel = LEVEL_REQUIREMENTS.find((r) => r.level === account.level + 1);

  const startEdit = (field: string, currentValue: number | string) => {
    setEditingField(field);
    setEditValue(String(currentValue));
  };

  const saveEdit = () => {
    if (!editingField) return;
    const numVal = Number(editValue);
    if (editingField === 'notes') {
      updateAccount(account.id, { notes: editValue });
    } else if (!isNaN(numVal)) {
      updateAccount(account.id, { [editingField]: numVal } as Partial<typeof account>);
    }
    setEditingField(null);
    showToast('Updated!', 'success');
  };

  const handleLevelUp = () => {
    levelUpAccount(account.id);
    addXP(account.id, 50);
    showToast(`${account.handle} leveled up to ${account.level + 1}!`, 'xp');
  };

  const handleDelete = () => {
    removeAccount(account.id);
    showToast(`${account.handle} removed`, 'error');
    onClose();
  };

  const EditableField = ({
    field,
    value,
    label,
    format,
  }: {
    field: string;
    value: number | string;
    label: string;
    format?: (v: number) => string;
  }) => (
    <div className="flex flex-col items-center gap-0.5">
      {editingField === field ? (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
            className="font-display w-20 rounded bg-white/10 px-2 py-1 text-center text-sm text-white outline-none"
          />
          <button onClick={saveEdit} className="text-green-400">
            <Check size={14} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => startEdit(field, value)}
          className="stat-value hover:text-empire-gold flex items-center gap-1 text-lg transition-colors"
        >
          {typeof value === 'number' && format ? format(value) : value}
          <Edit3 size={10} className="text-white/30" />
        </button>
      )}
      <span className="stat-label">{label}</span>
    </div>
  );

  return (
    <AnimatePresence>
      {accountId && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-3xl border-t"
            style={{
              borderColor: account.color + '40',
              background: 'linear-gradient(to bottom, #1a1a2e, #0f0b1a)',
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          >
            <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-white/20" />

            {/* Header */}
            <div className="flex items-start justify-between px-5 pb-4 pt-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-14 w-14 items-center justify-center rounded-2xl text-3xl"
                  style={{
                    background: `${account.color}20`,
                    border: `2px solid ${account.color}40`,
                  }}
                >
                  {building}
                </div>
                <div>
                  <h2 className="font-display text-xl text-white">{account.handle}</h2>
                  <p className="text-empire-silver text-sm">{account.niche}</p>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className={healthConfig.color}>{healthConfig.emoji}</span>
                    <span className={`text-xs ${healthConfig.color}`}>{healthConfig.label}</span>
                    {account.currentStreak > 0 && (
                      <span className="ml-1 text-xs text-orange-400">
                        🔥 {account.currentStreak}d streak
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button onClick={onClose} className="rounded-full p-2 hover:bg-white/10">
                <X size={20} className="text-empire-silver" />
              </button>
            </div>

            {/* Level badge + XP bar */}
            <div className="mb-4 px-5">
              <div className="game-card flex items-center gap-3">
                <div className="from-empire-gold font-display flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br to-yellow-600 text-xl text-black">
                  {account.level}
                </div>
                <div className="flex-1">
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="font-display text-empire-gold text-sm">
                      Level {account.level}
                    </span>
                    <span className="text-empire-silver text-xs">
                      {account.xp} / {100 * account.level} XP
                    </span>
                  </div>
                  <ProgressBar value={levelProgress} color="bg-empire-xp" />
                </div>
              </div>
            </div>

            {/* Stats row */}
            <div className="mb-4 px-5">
              <div className="game-card grid grid-cols-4 gap-2 text-center">
                <EditableField
                  field="followers"
                  value={account.followers}
                  label="Followers"
                  format={formatNumber}
                />
                <EditableField
                  field="revenue"
                  value={account.revenue}
                  label="Revenue/mo"
                  format={formatCurrency}
                />
                <div className="flex flex-col items-center gap-0.5">
                  <span className="stat-value text-lg">{account.tweetsPosted}</span>
                  <span className="stat-label">Tweets</span>
                </div>
                <EditableField
                  field="avgViews"
                  value={account.avgViews}
                  label="Avg Views"
                  format={formatNumber}
                />
              </div>
            </div>

            {/* Level Requirements */}
            {nextLevel && (
              <div className="mb-4 px-5">
                <div className="game-card">
                  <h3 className="font-display text-empire-gold mb-2 text-sm">
                    Level {nextLevel.level} Requirements
                  </h3>
                  <div className="space-y-1.5">
                    <RequirementItem
                      label={`${formatNumber(nextLevel.followers)} followers`}
                      met={account.followers >= nextLevel.followers}
                    />
                    {nextLevel.tweets && (
                      <RequirementItem
                        label={`${nextLevel.tweets} tweets posted`}
                        met={account.tweetsPosted >= nextLevel.tweets}
                      />
                    )}
                    {nextLevel.revenue && (
                      <RequirementItem
                        label={`${formatCurrency(nextLevel.revenue)}/mo revenue`}
                        met={account.revenue >= (nextLevel.revenue ?? 0)}
                      />
                    )}
                    {nextLevel.tweetsOver5K && (
                      <RequirementItem
                        label={`${nextLevel.tweetsOver5K} tweets over 5K views`}
                        met={
                          tweets.filter((t) => t.views >= 5000).length >=
                          (nextLevel.tweetsOver5K ?? 0)
                        }
                      />
                    )}
                    {nextLevel.tweetsOver10K && (
                      <RequirementItem
                        label={`${nextLevel.tweetsOver10K} tweets over 10K views`}
                        met={
                          tweets.filter((t) => t.views >= 10000).length >=
                          (nextLevel.tweetsOver10K ?? 0)
                        }
                      />
                    )}
                  </div>
                  <button onClick={handleLevelUp} className="game-button-gold mt-3 w-full text-xs">
                    Level Up
                  </button>
                </div>
              </div>
            )}

            {/* Notes */}
            <div className="mb-4 px-5">
              <div className="game-card">
                <h3 className="font-display text-empire-silver mb-1 text-sm">Notes</h3>
                {editingField === 'notes' ? (
                  <div>
                    <textarea
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="w-full resize-none rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-white/80 outline-none"
                      rows={3}
                    />
                    <button onClick={saveEdit} className="mt-1 text-xs text-green-400">
                      Save
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => startEdit('notes', account.notes)}
                    className="w-full text-left text-sm text-white/60 transition-colors hover:text-white/80"
                  >
                    {account.notes || 'Tap to add notes...'}
                  </button>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-3 px-5 pb-8">
              <button
                onClick={() => {
                  onClose();
                  navigate(`/deploy?account=${account.id}`);
                }}
                className="game-button flex flex-1 items-center justify-center gap-2"
              >
                <Zap size={16} /> Deploy
              </button>
              <button
                onClick={() => {
                  onClose();
                  navigate(`/battle-log?account=${account.id}`);
                }}
                className="font-display text-empire-silver flex-1 rounded-xl border border-white/10 bg-white/5 py-3 text-sm uppercase tracking-wider transition-colors hover:bg-white/10"
              >
                Battle Log
              </button>
              <button
                onClick={() => setShowDelete(!showDelete)}
                className="flex w-12 items-center justify-center rounded-xl border border-white/10 bg-white/5 transition-colors hover:border-red-500/30 hover:bg-red-500/10"
              >
                <Trash2 size={16} className="text-empire-silver" />
              </button>
            </div>

            {showDelete && (
              <div className="-mt-4 px-5 pb-6">
                <div className="flex items-center justify-between rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                  <span className="text-sm text-red-400">Remove this account?</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowDelete(false)}
                      className="px-3 py-1 text-xs text-white/50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDelete}
                      className="rounded-lg bg-red-500/20 px-3 py-1 text-xs font-bold text-red-400"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function RequirementItem({ label, met }: { label: string; met: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={met ? 'text-green-400' : 'text-white/30'}>{met ? '✅' : '⬜'}</span>
      <span className={met ? 'text-green-400 line-through' : 'text-white/60'}>{label}</span>
    </div>
  );
}

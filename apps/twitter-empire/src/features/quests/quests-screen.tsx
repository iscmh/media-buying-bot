import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Check, X } from 'lucide-react';
import { useQuestStore } from '@/stores/quest-store';
import { useEmpireStore } from '@/stores/empire-store';
import { useToastStore } from '@/components/ui/toast';
import { ProgressBar } from '@/components/ui/progress-bar';
import { cn } from '@/lib/utils';
import type { QuestPeriod } from '@/types';

const TABS: { value: QuestPeriod; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

export function QuestsScreen() {
  const [activeTab, setActiveTab] = useState<QuestPeriod>('daily');
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newXP, setNewXP] = useState('100');
  const [newTarget, setNewTarget] = useState('1');

  const { quests, addQuest, completeQuest, failQuest, removeQuest, generateDailyGoals } =
    useQuestStore();
  const accounts = useEmpireStore((s) => s.accounts);
  const addGlobalXP = useEmpireStore((s) => s.addGlobalXP);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    generateDailyGoals(accounts.map((a) => a.handle));
  }, [accounts, generateDailyGoals]);

  const filtered = quests.filter((q) => q.period === activeTab);
  const activeQuests = filtered.filter((q) => q.status === 'active');
  const completedQuests = filtered.filter((q) => q.status === 'completed');
  const failedQuests = filtered.filter((q) => q.status === 'failed');

  const dailyProgress =
    activeTab === 'daily'
      ? { done: completedQuests.length, total: completedQuests.length + activeQuests.length }
      : null;

  const handleComplete = (questId: string) => {
    const quest = quests.find((q) => q.id === questId);
    if (!quest) return;
    completeQuest(questId);
    addGlobalXP(quest.xpReward);
    showToast(`+${quest.xpReward} XP — Quest complete!`, 'xp');
  };

  const handleFail = (questId: string) => {
    const quest = quests.find((q) => q.id === questId);
    if (!quest) return;
    failQuest(questId);
    if (quest.xpPenalty > 0) {
      addGlobalXP(-quest.xpPenalty);
      showToast(`-${quest.xpPenalty} XP — Quest failed`, 'error');
    }
  };

  const handleAdd = () => {
    if (!newTitle.trim()) return;
    addQuest({
      period: activeTab,
      title: newTitle.trim(),
      description: '',
      xpReward: Number(newXP) || 100,
      target: Number(newTarget) || 1,
    });
    showToast('Quest created!', 'success');
    setNewTitle('');
    setNewXP('100');
    setNewTarget('1');
    setShowAdd(false);
  };

  return (
    <div className="bg-empire-bg min-h-screen px-4 pt-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-2xl text-white">Quests</h1>
        {activeTab !== 'daily' && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="bg-empire-accent/20 text-empire-accent hover:bg-empire-accent/30 rounded-lg p-2 transition-colors"
          >
            <Plus size={18} />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 rounded-xl bg-white/5 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              'font-display flex-1 rounded-lg py-2 text-sm transition-colors',
              activeTab === tab.value
                ? 'bg-empire-accent text-white'
                : 'text-empire-silver hover:text-white',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Daily progress bar */}
      {dailyProgress && dailyProgress.total > 0 && (
        <div className="game-card mb-4">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="font-display text-empire-gold text-sm">Daily Progress</span>
            <span className="text-empire-silver text-xs">
              {dailyProgress.done}/{dailyProgress.total}
            </span>
          </div>
          <ProgressBar
            value={dailyProgress.done}
            max={dailyProgress.total}
            color="bg-empire-gold"
          />
          {dailyProgress.done === dailyProgress.total && dailyProgress.total > 0 && (
            <p className="font-display mt-1 text-xs text-green-400">
              All daily goals complete! +50 XP
            </p>
          )}
        </div>
      )}

      {/* Add quest form */}
      <AnimatePresence>
        {showAdd && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mb-4 overflow-hidden"
          >
            <div className="game-card space-y-3">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Quest description..."
                className="focus:border-empire-gold/50 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
              />
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-empire-silver text-[10px]">XP Reward</label>
                  <input
                    value={newXP}
                    onChange={(e) => setNewXP(e.target.value)}
                    type="number"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-empire-silver text-[10px]">Target</label>
                  <input
                    value={newTarget}
                    onChange={(e) => setNewTarget(e.target.value)}
                    type="number"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
                  />
                </div>
              </div>
              <button onClick={handleAdd} className="game-button w-full text-xs">
                Create Quest
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quest list */}
      <div className="space-y-2 pb-4">
        {activeQuests.length === 0 && completedQuests.length === 0 && failedQuests.length === 0 && (
          <div className="py-12 text-center">
            <p className="mb-2 text-4xl">⚔️</p>
            <p className="text-empire-silver">
              {activeTab === 'daily'
                ? 'Daily goals will appear here'
                : `Add ${activeTab} quests to earn XP`}
            </p>
          </div>
        )}

        {activeQuests.map((quest) => (
          <QuestCard
            key={quest.id}
            quest={quest}
            onComplete={() => handleComplete(quest.id)}
            onFail={() => handleFail(quest.id)}
            onRemove={() => removeQuest(quest.id)}
          />
        ))}

        {completedQuests.length > 0 && (
          <div className="pt-2">
            <p className="text-empire-silver mb-2 text-xs uppercase tracking-wider">Completed</p>
            {completedQuests.map((quest) => (
              <QuestCard key={quest.id} quest={quest} onRemove={() => removeQuest(quest.id)} />
            ))}
          </div>
        )}

        {failedQuests.length > 0 && (
          <div className="pt-2">
            <p className="text-empire-silver mb-2 text-xs uppercase tracking-wider">Failed</p>
            {failedQuests.map((quest) => (
              <QuestCard key={quest.id} quest={quest} onRemove={() => removeQuest(quest.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QuestCard({
  quest,
  onComplete,
  onFail,
}: {
  quest: ReturnType<typeof useQuestStore.getState>['quests'][number];
  onComplete?: () => void;
  onFail?: () => void;
  onRemove?: () => void;
}) {
  const isActive = quest.status === 'active';
  const isCompleted = quest.status === 'completed';
  const isFailed = quest.status === 'failed';

  return (
    <motion.div
      layout
      className={cn(
        'game-card flex items-center gap-3',
        isCompleted && 'opacity-60',
        isFailed && 'border-red-500/20 opacity-40',
      )}
    >
      {isActive && onComplete && (
        <button
          onClick={onComplete}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-white/20 transition-colors hover:border-green-400 hover:bg-green-400/10"
        >
          <Check size={14} className="text-white/30" />
        </button>
      )}
      {isCompleted && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/20">
          <Check size={14} className="text-green-400" />
        </div>
      )}
      {isFailed && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/20">
          <X size={14} className="text-red-400" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm',
            isCompleted && 'text-white/50 line-through',
            isFailed && 'text-red-400/50 line-through',
          )}
        >
          {quest.title}
        </p>
        {quest.target > 1 && (
          <ProgressBar value={quest.progress} max={quest.target} size="sm" className="mt-1" />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            'font-display text-xs',
            isCompleted ? 'text-green-400' : isFailed ? 'text-red-400' : 'text-empire-xp',
          )}
        >
          {isFailed && quest.xpPenalty > 0 ? `-${quest.xpPenalty}` : `+${quest.xpReward}`} XP
        </span>
        {isActive && onFail && (
          <button onClick={onFail} className="rounded p-1 hover:bg-red-500/10">
            <X size={12} className="text-white/30" />
          </button>
        )}
      </div>
    </motion.div>
  );
}

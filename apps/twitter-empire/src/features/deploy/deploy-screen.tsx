import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Save, ChevronDown } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useEmpireStore } from '@/stores/empire-store';
import { useTweetStore } from '@/stores/tweet-store';
import { useToastStore } from '@/components/ui/toast';
import { TWEET_TYPE_RARITY, RARITY_COLORS } from '@/lib/constants';
import { calculateTweetXP } from '@/lib/xp';
import { cn } from '@/lib/utils';
import type { TweetType } from '@/types';

const TWEET_TYPES: { value: TweetType; label: string }[] = [
  { value: 'sauce', label: '🧪 Sauce' },
  { value: 'hot-take', label: '🔥 Hot Take' },
  { value: 'story', label: '📖 Story' },
  { value: 'flex', label: '💪 Flex' },
  { value: 'launch', label: '🚀 Launch' },
  { value: 'personal', label: '💭 Personal' },
  { value: 'engagement', label: '🤝 Engagement' },
  { value: 'callout', label: '📢 Callout' },
];

export function DeployScreen() {
  const [searchParams] = useSearchParams();
  const accounts = useEmpireStore((s) => s.accounts);
  const recordPost = useEmpireStore((s) => s.recordPost);
  const addXP = useEmpireStore((s) => s.addXP);
  const updateStreak = useEmpireStore((s) => s.updateStreak);
  const currentStreak = useEmpireStore((s) => s.currentStreak);
  const { addTweet, deployTweet, updateTweet } = useTweetStore();
  const showToast = useToastStore((s) => s.show);

  const [selectedAccountId, setSelectedAccountId] = useState(
    searchParams.get('account') || accounts[0]?.id || '',
  );
  const [text, setText] = useState('');
  const [tweetType, setTweetType] = useState<TweetType>('sauce');
  const [showAccountPicker, setShowAccountPicker] = useState(false);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const charCount = text.length;
  const rarity = TWEET_TYPE_RARITY[tweetType];

  useEffect(() => {
    const accountParam = searchParams.get('account');
    if (accountParam) setSelectedAccountId(accountParam);
  }, [searchParams]);

  const handleDeploy = () => {
    if (!text.trim() || !selectedAccountId) return;
    const id = addTweet({ accountId: selectedAccountId, text: text.trim(), type: tweetType });
    deployTweet(id);
    const xp = calculateTweetXP(0, currentStreak);
    updateTweet(id, { xpEarned: xp });
    addXP(selectedAccountId, xp);
    recordPost(selectedAccountId);
    updateStreak();
    showToast(`+${xp} XP — Tweet deployed!`, 'xp');
    setText('');
  };

  const handleSaveDraft = () => {
    if (!text.trim() || !selectedAccountId) return;
    addTweet({ accountId: selectedAccountId, text: text.trim(), type: tweetType });
    showToast('Draft saved!', 'success');
    setText('');
  };

  return (
    <div className="bg-empire-bg min-h-screen px-4 pb-4 pt-4">
      <h1 className="font-display mb-4 text-2xl text-white">Deploy</h1>

      {/* Account selector */}
      <div className="relative mb-4">
        <button
          onClick={() => setShowAccountPicker(!showAccountPicker)}
          className="game-card flex w-full items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div
              className="h-8 w-8 rounded-full"
              style={{ backgroundColor: selectedAccount?.color ?? '#666' }}
            />
            <div className="text-left">
              <p className="text-sm font-medium text-white">
                {selectedAccount?.handle ?? 'Select account'}
              </p>
              <p className="text-empire-silver text-xs">{selectedAccount?.niche}</p>
            </div>
          </div>
          <ChevronDown
            size={16}
            className={cn(
              'text-empire-silver transition-transform',
              showAccountPicker && 'rotate-180',
            )}
          />
        </button>

        <AnimatePresence>
          {showAccountPicker && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-empire-card absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-white/10 shadow-xl"
            >
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    setSelectedAccountId(a.id);
                    setShowAccountPicker(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-white/5',
                    a.id === selectedAccountId && 'bg-white/5',
                  )}
                >
                  <div className="h-6 w-6 rounded-full" style={{ backgroundColor: a.color }} />
                  <span className="text-sm text-white">{a.handle}</span>
                  <span className="text-empire-silver ml-auto text-xs">{a.niche}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Tweet type selector */}
      <div className="mb-4">
        <label className="text-empire-silver mb-2 block text-xs uppercase tracking-wider">
          Tweet Type
        </label>
        <div className="flex flex-wrap gap-2">
          {TWEET_TYPES.map((type) => {
            const r = TWEET_TYPE_RARITY[type.value];
            const colors = RARITY_COLORS[r];
            const isSelected = tweetType === type.value;
            return (
              <button
                key={type.value}
                onClick={() => setTweetType(type.value)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
                  isSelected
                    ? `${colors.bg} ${colors.border} text-white`
                    : 'border-white/10 bg-white/5 text-white/50 hover:bg-white/10',
                )}
              >
                {type.label}
              </button>
            );
          })}
        </div>
        <p className="text-empire-silver mt-1 text-[10px] capitalize">{rarity} rarity</p>
      </div>

      {/* Text area */}
      <div className="relative mb-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write your tweet..."
          rows={6}
          className="focus:border-empire-gold/50 w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm leading-relaxed text-white transition-colors placeholder:text-white/30 focus:outline-none"
        />
        <span
          className={cn(
            'absolute bottom-3 right-3 text-xs font-medium',
            charCount > 280
              ? 'text-red-400'
              : charCount > 240
                ? 'text-yellow-400'
                : 'text-white/30',
          )}
        >
          {charCount}/280
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleSaveDraft}
          disabled={!text.trim()}
          className="font-display text-empire-silver flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 py-3 text-sm uppercase tracking-wider transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Save size={16} /> Save Draft
        </button>
        <button
          onClick={handleDeploy}
          disabled={!text.trim() || charCount > 280}
          className="game-button flex flex-1 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Send size={16} /> Deploy
        </button>
      </div>
    </div>
  );
}

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Filter, Edit3, Check, Trash2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useTweetStore } from '@/stores/tweet-store';
import { useEmpireStore } from '@/stores/empire-store';
import { formatDate, formatNumber, cn } from '@/lib/utils';
import { getPerformanceDisplay, calculateTweetXP } from '@/lib/xp';
import { TWEET_TYPE_RARITY, RARITY_COLORS } from '@/lib/constants';
import type { PerformanceRating } from '@/types';
import { useToastStore } from '@/components/ui/toast';

export function BattleLogScreen() {
  const [searchParams] = useSearchParams();
  const tweets = useTweetStore((s) => s.tweets);
  const updateTweet = useTweetStore((s) => s.updateTweet);
  const removeTweet = useTweetStore((s) => s.removeTweet);
  const accounts = useEmpireStore((s) => s.accounts);
  const addXP = useEmpireStore((s) => s.addXP);
  const currentStreak = useEmpireStore((s) => s.currentStreak);
  const showToast = useToastStore((s) => s.show);

  const [filterAccount, setFilterAccount] = useState(searchParams.get('account') || 'all');
  const [filterRating, setFilterRating] = useState<PerformanceRating | 'all'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [editingTweet, setEditingTweet] = useState<string | null>(null);
  const [editViews, setEditViews] = useState('');
  const [editLikes, setEditLikes] = useState('');
  const [editReplies, setEditReplies] = useState('');
  const [editRTs, setEditRTs] = useState('');

  const filtered = useMemo(() => {
    let result = tweets.filter((t) => t.status === 'deployed');
    if (filterAccount !== 'all') result = result.filter((t) => t.accountId === filterAccount);
    if (filterRating !== 'all') {
      result = result.filter((t) => {
        const { rating } = getPerformanceDisplay(t.views);
        return rating === filterRating;
      });
    }
    return result;
  }, [tweets, filterAccount, filterRating]);

  const startEditStats = (tweetId: string) => {
    const tweet = tweets.find((t) => t.id === tweetId);
    if (!tweet) return;
    setEditingTweet(tweetId);
    setEditViews(String(tweet.views));
    setEditLikes(String(tweet.likes));
    setEditReplies(String(tweet.replies));
    setEditRTs(String(tweet.retweets));
  };

  const saveStats = (tweetId: string) => {
    const tweet = tweets.find((t) => t.id === tweetId);
    if (!tweet) return;
    const newViews = Number(editViews) || 0;
    const oldXP = tweet.xpEarned;
    const newXP = calculateTweetXP(newViews, currentStreak);
    const xpDiff = newXP - oldXP;

    updateTweet(tweetId, {
      views: newViews,
      likes: Number(editLikes) || 0,
      replies: Number(editReplies) || 0,
      retweets: Number(editRTs) || 0,
      xpEarned: newXP,
    });
    if (xpDiff > 0) {
      addXP(tweet.accountId, xpDiff);
      showToast(`+${xpDiff} XP from views!`, 'xp');
    }
    setEditingTweet(null);
  };

  return (
    <div className="bg-empire-bg min-h-screen px-4 pt-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-2xl text-white">Battle Log</h1>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            'rounded-lg p-2 transition-colors',
            showFilters
              ? 'bg-empire-accent/20 text-empire-accent'
              : 'text-empire-silver bg-white/5',
          )}
        >
          <Filter size={18} />
        </button>
      </div>

      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mb-4 overflow-hidden"
          >
            <div className="game-card space-y-3">
              <div>
                <label className="text-empire-silver text-xs uppercase tracking-wider">
                  Account
                </label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <FilterChip
                    selected={filterAccount === 'all'}
                    onClick={() => setFilterAccount('all')}
                  >
                    All
                  </FilterChip>
                  {accounts.map((a) => (
                    <FilterChip
                      key={a.id}
                      selected={filterAccount === a.id}
                      onClick={() => setFilterAccount(a.id)}
                      color={a.color}
                    >
                      {a.handle}
                    </FilterChip>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-empire-silver text-xs uppercase tracking-wider">
                  Performance
                </label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <FilterChip
                    selected={filterRating === 'all'}
                    onClick={() => setFilterRating('all')}
                  >
                    All
                  </FilterChip>
                  {(['legendary', 'viral', 'heat', 'mid', 'flop'] as const).map((r) => (
                    <FilterChip
                      key={r}
                      selected={filterRating === r}
                      onClick={() => setFilterRating(r)}
                    >
                      {
                        getPerformanceDisplay(
                          r === 'legendary'
                            ? 100000
                            : r === 'viral'
                              ? 25000
                              : r === 'heat'
                                ? 5000
                                : r === 'mid'
                                  ? 1000
                                  : 0,
                        ).emoji
                      }{' '}
                      {r}
                    </FilterChip>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="space-y-3 pb-4">
        {filtered.length === 0 && (
          <div className="py-12 text-center">
            <p className="mb-2 text-4xl">📜</p>
            <p className="text-empire-silver">No battles yet. Deploy some tweets!</p>
          </div>
        )}
        {filtered.map((tweet, i) => {
          const account = accounts.find((a) => a.id === tweet.accountId);
          const { emoji, label } = getPerformanceDisplay(tweet.views);
          const rarity = TWEET_TYPE_RARITY[tweet.type];
          const rarityColors = RARITY_COLORS[rarity];
          const isEditing = editingTweet === tweet.id;

          return (
            <motion.div
              key={tweet.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              className="game-card"
            >
              <div className="mb-2 flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: account?.color }}
                  />
                  <span className="text-sm font-medium text-white">{account?.handle}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${rarityColors.bg} ${rarityColors.text}`}
                  >
                    {tweet.type}
                  </span>
                </div>
                <span className="text-empire-silver text-xs">
                  {formatDate(tweet.deployedAt ?? tweet.createdAt)}
                </span>
              </div>

              <p className="mb-3 line-clamp-3 text-sm text-white/70">{tweet.text}</p>

              {isEditing ? (
                <div className="space-y-2 rounded-lg bg-white/5 p-3">
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: 'Views', value: editViews, setter: setEditViews },
                      { label: 'Likes', value: editLikes, setter: setEditLikes },
                      { label: 'Replies', value: editReplies, setter: setEditReplies },
                      { label: 'RTs', value: editRTs, setter: setEditRTs },
                    ].map((field) => (
                      <div key={field.label}>
                        <label className="text-empire-silver text-[10px]">{field.label}</label>
                        <input
                          value={field.value}
                          onChange={(e) => field.setter(e.target.value)}
                          className="w-full rounded bg-white/10 px-2 py-1 text-sm text-white outline-none"
                          type="number"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveStats(tweet.id)}
                      className="flex items-center gap-1 rounded-lg bg-green-400/10 px-3 py-1.5 text-xs text-green-400"
                    >
                      <Check size={12} /> Save
                    </button>
                    <button
                      onClick={() => setEditingTweet(null)}
                      className="px-3 py-1.5 text-xs text-white/40"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="text-empire-silver flex items-center gap-3 text-xs">
                    <span>👁 {formatNumber(tweet.views)}</span>
                    <span>❤️ {formatNumber(tweet.likes)}</span>
                    <span>💬 {tweet.replies}</span>
                    <span>🔁 {tweet.retweets}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {emoji} {label}
                    </span>
                    {tweet.xpEarned > 0 && (
                      <span className="text-empire-xp font-display text-[10px]">
                        +{tweet.xpEarned} XP
                      </span>
                    )}
                    <button
                      onClick={() => startEditStats(tweet.id)}
                      className="rounded p-1 hover:bg-white/10"
                    >
                      <Edit3 size={12} className="text-white/30" />
                    </button>
                    <button
                      onClick={() => removeTweet(tweet.id)}
                      className="rounded p-1 hover:bg-red-500/10"
                    >
                      <Trash2 size={12} className="text-white/30" />
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({
  selected,
  onClick,
  children,
  color,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
        selected ? 'bg-empire-accent text-white' : 'bg-white/5 text-white/50 hover:bg-white/10',
      )}
      style={selected && color ? { backgroundColor: color + '40' } : undefined}
    >
      {children}
    </button>
  );
}

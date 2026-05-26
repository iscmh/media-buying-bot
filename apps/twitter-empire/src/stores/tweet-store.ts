import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Tweet, TweetType } from '@/types';
import { generateId } from '@/lib/utils';

interface TweetState {
  tweets: Tweet[];
  addTweet: (tweet: { accountId: string; text: string; type: TweetType }) => string;
  updateTweet: (id: string, updates: Partial<Tweet>) => void;
  deployTweet: (id: string) => void;
  removeTweet: (id: string) => void;
  getTweetsByAccount: (accountId: string) => Tweet[];
  getDeployedTweets: () => Tweet[];
}

export const useTweetStore = create<TweetState>()(
  persist(
    (set, get) => ({
      tweets: [],

      addTweet: (tweet) => {
        const id = generateId();
        set((state) => ({
          tweets: [
            {
              id,
              ...tweet,
              status: 'draft',
              views: 0,
              likes: 0,
              replies: 0,
              retweets: 0,
              xpEarned: 0,
              createdAt: new Date().toISOString(),
              deployedAt: null,
            },
            ...state.tweets,
          ],
        }));
        return id;
      },

      updateTweet: (id, updates) =>
        set((state) => ({
          tweets: state.tweets.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        })),

      deployTweet: (id) =>
        set((state) => ({
          tweets: state.tweets.map((t) =>
            t.id === id
              ? { ...t, status: 'deployed' as const, deployedAt: new Date().toISOString() }
              : t,
          ),
        })),

      removeTweet: (id) =>
        set((state) => ({
          tweets: state.tweets.filter((t) => t.id !== id),
        })),

      getTweetsByAccount: (accountId) => get().tweets.filter((t) => t.accountId === accountId),
      getDeployedTweets: () => get().tweets.filter((t) => t.status === 'deployed'),
    }),
    { name: 'te-tweets' },
  ),
);

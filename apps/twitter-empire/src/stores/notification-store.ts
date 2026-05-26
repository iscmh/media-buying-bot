import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppNotification, NotificationType } from '@/types';
import { generateId } from '@/lib/utils';

interface NotificationState {
  notifications: AppNotification[];
  addNotification: (notification: {
    type: NotificationType;
    title: string;
    message: string;
    accountId?: string;
  }) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  unreadCount: () => number;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      notifications: [],

      addNotification: (notification) =>
        set((state) => ({
          notifications: [
            {
              ...notification,
              id: generateId(),
              read: false,
              createdAt: new Date().toISOString(),
            },
            ...state.notifications,
          ].slice(0, 100),
        })),

      markRead: (id) =>
        set((state) => ({
          notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        })),

      markAllRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
        })),

      clearAll: () => set({ notifications: [] }),

      unreadCount: () => get().notifications.filter((n) => !n.read).length,
    }),
    { name: 'te-notifications' },
  ),
);

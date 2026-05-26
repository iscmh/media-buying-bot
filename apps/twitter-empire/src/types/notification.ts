export type NotificationType = 'warning' | 'achievement' | 'levelup' | 'viral' | 'quest' | 'info';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  accountId?: string;
}

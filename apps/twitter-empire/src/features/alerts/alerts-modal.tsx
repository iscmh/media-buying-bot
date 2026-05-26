import { Modal } from '@/components/ui/modal';
import { useNotificationStore } from '@/stores/notification-store';
import { formatDate, cn } from '@/lib/utils';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

const TYPE_ICONS: Record<string, string> = {
  warning: '⚠️',
  achievement: '🏆',
  levelup: '📈',
  viral: '🔥',
  quest: '✅',
  info: '💡',
};

export function AlertsModal({ open, onClose }: Props) {
  const { notifications, markRead, markAllRead, clearAll } = useNotificationStore();

  return (
    <Modal open={open} onClose={onClose} title="Alerts">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-empire-silver text-xs">
          {notifications.filter((n) => !n.read).length} unread
        </span>
        <div className="flex gap-2">
          <button
            onClick={markAllRead}
            className="text-empire-silver flex items-center gap-1 text-xs transition-colors hover:text-white"
          >
            <CheckCheck size={12} /> Read all
          </button>
          <button
            onClick={clearAll}
            className="text-empire-silver flex items-center gap-1 text-xs transition-colors hover:text-red-400"
          >
            <Trash2 size={12} /> Clear
          </button>
        </div>
      </div>

      {notifications.length === 0 ? (
        <div className="py-8 text-center">
          <Bell size={32} className="mx-auto mb-2 text-white/10" />
          <p className="text-empire-silver text-sm">No alerts yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map((notification) => (
            <button
              key={notification.id}
              onClick={() => markRead(notification.id)}
              className={cn(
                'game-card flex w-full items-start gap-3 text-left transition-colors',
                !notification.read && 'border-empire-accent/30 bg-empire-accent/5',
              )}
            >
              <span className="shrink-0 text-lg">{TYPE_ICONS[notification.type] ?? '💡'}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">{notification.title}</p>
                <p className="text-empire-silver mt-0.5 text-xs">{notification.message}</p>
                <p className="mt-1 text-[10px] text-white/20">
                  {formatDate(notification.createdAt)}
                </p>
              </div>
              {!notification.read && (
                <div className="bg-empire-accent mt-1.5 h-2 w-2 shrink-0 rounded-full" />
              )}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

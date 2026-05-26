import { motion, AnimatePresence } from 'framer-motion';
import { create } from 'zustand';

interface ToastData {
  id: string;
  message: string;
  type: 'success' | 'error' | 'xp' | 'achievement';
}

interface ToastState {
  toasts: ToastData[];
  show: (message: string, type?: ToastData['type']) => void;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, type = 'success') => {
    const id = `${Date.now()}-${Math.random()}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3000);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const TYPE_STYLES = {
  success: 'bg-green-600 border-green-400',
  error: 'bg-red-600 border-red-400',
  xp: 'bg-purple-600 border-purple-400',
  achievement: 'bg-yellow-600 border-yellow-400',
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-[100] flex flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -40, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className={`font-display rounded-xl border px-5 py-3 text-sm text-white shadow-lg ${TYPE_STYLES[toast.type]}`}
          >
            {toast.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

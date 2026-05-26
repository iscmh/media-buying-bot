import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { useEmpireStore } from '@/stores/empire-store';
import { useToastStore } from '@/components/ui/toast';

interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
}

const NICHE_OPTIONS = [
  'Affiliate/Info',
  'AI/SaaS',
  'Gambling/Betting',
  'Clipping',
  'YT SEO',
  'E-commerce',
  'Crypto',
  'Personal Brand',
  'Other',
];

const COLOR_OPTIONS = [
  '#F59E0B',
  '#3B82F6',
  '#EF4444',
  '#22C55E',
  '#A855F7',
  '#EC4899',
  '#06B6D4',
  '#F97316',
];

export function AddAccountModal({ open, onClose }: AddAccountModalProps) {
  const addAccount = useEmpireStore((s) => s.addAccount);
  const showToast = useToastStore((s) => s.show);
  const [handle, setHandle] = useState('');
  const [niche, setNiche] = useState(NICHE_OPTIONS[0]);
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [notes, setNotes] = useState('');

  const handleSubmit = () => {
    if (!handle.trim()) return;
    const finalHandle = handle.startsWith('@') ? handle : `@${handle}`;
    addAccount({ handle: finalHandle, niche, color, level: 1, followers: 0, revenue: 0, notes });
    showToast(`${finalHandle} joined the empire!`, 'success');
    setHandle('');
    setNotes('');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="New Account">
      <div className="space-y-4">
        <div>
          <label className="text-empire-silver text-xs uppercase tracking-wider">Handle</label>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@username"
            className="focus:border-empire-gold/50 mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white transition-colors placeholder:text-white/30 focus:outline-none"
          />
        </div>

        <div>
          <label className="text-empire-silver text-xs uppercase tracking-wider">Niche</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {NICHE_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setNiche(n)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  niche === n
                    ? 'bg-empire-accent text-white'
                    : 'bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-empire-silver text-xs uppercase tracking-wider">Color</label>
          <div className="mt-1 flex gap-2">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-8 w-8 rounded-full transition-transform ${color === c ? 'scale-125 ring-2 ring-white/50' : ''}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="text-empire-silver text-xs uppercase tracking-wider">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Strategy, voice, goals..."
            rows={2}
            className="focus:border-empire-gold/50 mt-1 w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white transition-colors placeholder:text-white/30 focus:outline-none"
          />
        </div>

        <button onClick={handleSubmit} className="game-button w-full" disabled={!handle.trim()}>
          Build Account
        </button>
      </div>
    </Modal>
  );
}

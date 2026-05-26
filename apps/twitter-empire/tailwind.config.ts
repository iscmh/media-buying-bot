import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        empire: {
          bg: '#0f0b1a',
          surface: '#1a1a2e',
          card: '#16213e',
          accent: '#e94560',
          gold: '#fbbf24',
          silver: '#94a3b8',
          xp: '#a855f7',
          'nav-bg': '#0a0a1a',
        },
        rarity: {
          common: '#6b7280',
          rare: '#3b82f6',
          epic: '#a855f7',
          legendary: '#f59e0b',
        },
      },
      fontFamily: {
        display: ['"Lilita One"', 'cursive'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 15px rgba(233, 69, 96, 0.3)',
        'glow-gold': '0 0 20px rgba(251, 191, 36, 0.4)',
        'glow-purple': '0 0 20px rgba(168, 85, 247, 0.4)',
        'card-hover': '0 8px 32px rgba(0, 0, 0, 0.4)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        float: 'float 3s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 5px rgba(251, 191, 36, 0.3)' },
          '50%': { boxShadow: '0 0 20px rgba(251, 191, 36, 0.6)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;

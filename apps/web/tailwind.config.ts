import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * Ads Bot Tailwind config — brand canonical tokens (bg/fg/...) alongside
 * the legacy shadcn aliases so both naming styles work. Both resolve to
 * the same CSS variables defined in globals.css.
 *
 * Typography: Geist + Geist Mono are loaded via next/font in the root
 * layout and injected as CSS variables `--font-geist-sans` /
 * `--font-geist-mono`; this config wires them into Tailwind's font-sans
 * + font-mono utilities so every text element renders consistently.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        // === Brand canonical tokens — prefer these in new code. ===
        // Polish-17 (Phase 1): the `bg.surface` / `bg.surfaceHover` /
        // `bg.inset` aliases live ALONGSIDE the legacy `bg.elevated` /
        // `bg.hover` / `bg.active`. They resolve to the same colors.
        // New code should use the surface / inset names; legacy code
        // keeps working until Polish-17 Phase 3 migrates it.
        bg: {
          DEFAULT: 'var(--bg)',
          base: 'var(--bg-base)',
          elevated: 'var(--bg-elevated)',
          surface: 'var(--bg-surface)',
          surfaceHover: 'var(--bg-surface-hover)',
          inset: 'var(--bg-inset)',
          hover: 'var(--bg-hover)',
          active: 'var(--bg-active)',
        },
        fg: {
          DEFAULT: 'var(--fg)',
          muted: 'var(--fg-muted)',
          subtle: 'var(--fg-subtle)',
          inverse: 'var(--fg-inverse)',
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        // Polish-17 (Phase 1): semantic accent palette — used PURPOSEFULLY,
        // not decoratively. Status pills, dots, alert text. NOT for buttons,
        // backgrounds, or anything that competes with the primary/secondary
        // hierarchy.
        'accent-positive': 'var(--accent-positive)',
        'accent-negative': 'var(--accent-negative)',
        'accent-warning': 'var(--accent-warning)',
        'accent-info': 'var(--accent-info)',
        // Polish-25.4 Commit 25: Trader Terminal amber. Signature accent
        // for primary CTAs (Generate variants, Launch approved, Continue)
        // + active tabs + data-row hover borders. See globals.css for
        // the token rationale (Bloomberg-orange trust signal for media
        // buyers pattern-matching to trading-desk tooling).
        'accent-amber': {
          DEFAULT: 'var(--accent-amber)',
          fg: 'var(--accent-amber-fg)',
        },

        // Shadcn aliases — repainted to the brand palette so existing
        // primitives in components/ui/* keep working untouched.
        border: {
          DEFAULT: 'hsl(var(--border))',
          // Polish-17 (Phase 1): subtler divider tint for table-row separators.
          subtle: 'var(--border-subtle)',
          strong: 'var(--border-strong)',
          focus: 'var(--border-focus)',
        },
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
      },
      borderRadius: {
        // Polish-17 (Phase 1): --radius is now 2px. shadcn's cascaded
        // sm/md sizes clamp to 0 at this scale, giving cards a much
        // squarer "real tool" look.
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'slide-up': 'slide-up 200ms ease-out',
      },
    },
  },
  plugins: [animate],
};

export default config;

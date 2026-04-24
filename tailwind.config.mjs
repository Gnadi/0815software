/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      // ─── Design tokens ───────────────────────────────────────────────
      colors: {
        bg:           'var(--bg)',
        'bg-2':       'var(--bg-2)',
        'bg-3':       'var(--bg-3)',
        fg:           'var(--fg)',
        'fg-dim':     'var(--fg-dim)',
        'fg-mute':    'var(--fg-mute)',
        accent:       'var(--accent)',
        line:         'var(--line)',
        'line-strong':'var(--line-strong)',
      },
      fontFamily: {
        sans:  ["'Inter Tight'", 'system-ui', 'sans-serif'],
        mono:  ["'JetBrains Mono'", 'ui-monospace', 'monospace'],
        serif: ["'Instrument Serif'", 'Georgia', 'serif'],
      },
      borderRadius: {
        // DIN-spec editorial: intentionally sharp
        DEFAULT: '2px',
        sm: '2px',
        md: '2px',
        lg: '2px',
      },
      // ─── Spacing ──────────────────────────────────────────────────────
      // Page horizontal padding
      spacing: {
        'pad-x':    '96px',
        'pad-x-sm': '64px',
        'pad-x-xs': '24px',
        'sec-y':    '140px',
        'sec-y-sm': '96px',
      },
    },
  },
};

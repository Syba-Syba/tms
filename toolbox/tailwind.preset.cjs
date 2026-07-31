/** Maps the CSS variables in tokens.css onto Tailwind so apps never hardcode a hex value. */
const ramp = (name) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => [
      step,
      `var(--tb-${name}-${step})`,
    ]),
  );

module.exports = {
  theme: {
    extend: {
      colors: {
        brand: ramp('brand'),
        neutral: { 0: 'var(--tb-neutral-0)', ...ramp('neutral') },
        bg: 'var(--tb-bg)',
        surface: { DEFAULT: 'var(--tb-surface)', muted: 'var(--tb-surface-muted)' },
        line: { DEFAULT: 'var(--tb-border)', soft: 'var(--tb-border-soft)' },
        marker: 'var(--tb-marker)',
        ink: { DEFAULT: 'var(--tb-text)', muted: 'var(--tb-text-muted)', inverse: 'var(--tb-text-inverse)' },
        success: 'var(--tb-success)',
        warning: 'var(--tb-warning)',
        danger: 'var(--tb-danger)',
        info: 'var(--tb-info)',
      },
      fontFamily: {
        display: ['var(--tb-font-display)'],
        sans: ['var(--tb-font-body)'],
        mono: ['var(--tb-font-mono)'],
      },
      borderRadius: {
        sm: 'var(--tb-radius-sm)',
        md: 'var(--tb-radius-md)',
        lg: 'var(--tb-radius-lg)',
        full: 'var(--tb-radius-full)',
      },
      boxShadow: {
        sm: 'var(--tb-shadow-sm)',
        md: 'var(--tb-shadow-md)',
        lg: 'var(--tb-shadow-lg)',
      },
      ringColor: { DEFAULT: 'var(--tb-ring)' },
    },
  },
};

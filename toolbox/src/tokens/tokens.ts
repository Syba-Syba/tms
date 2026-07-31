export const tokens = {
  radius: {
    sm: 'var(--tb-radius-sm)',
    md: 'var(--tb-radius-md)',
    lg: 'var(--tb-radius-lg)',
    full: 'var(--tb-radius-full)',
  },
  shadow: { sm: 'var(--tb-shadow-sm)', md: 'var(--tb-shadow-md)', lg: 'var(--tb-shadow-lg)' },
  font: { display: 'var(--tb-font-display)', body: 'var(--tb-font-body)', mono: 'var(--tb-font-mono)' },
  color: {
    bg: 'var(--tb-bg)',
    surface: 'var(--tb-surface)',
    border: 'var(--tb-border)',
    text: 'var(--tb-text)',
    textMuted: 'var(--tb-text-muted)',
    brand: 'var(--tb-brand-500)',
    success: 'var(--tb-success)',
    warning: 'var(--tb-warning)',
    danger: 'var(--tb-danger)',
    info: 'var(--tb-info)',
  },
} as const;

export type Tokens = typeof tokens;

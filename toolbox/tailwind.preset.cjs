/** Maps the CSS variables in tokens.css onto Tailwind so apps never hardcode a hex value. */
/** A token colour that also takes Tailwind's opacity modifier (`border-danger/30`). */
const tint = (variable) => `color-mix(in srgb, var(${variable}) calc(<alpha-value> * 100%), transparent)`;

const ramp = (name) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => [
      step,
      name === 'brand' ? tint(`--tb-${name}-${step}`) : `var(--tb-${name}-${step})`,
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
        success: tint('--tb-success'),
        warning: tint('--tb-warning'),
        danger: tint('--tb-danger'),
        info: tint('--tb-info'),
        tint: { success: 'var(--tb-success-tint)', warning: 'var(--tb-warning-tint)', danger: 'var(--tb-danger-tint)', info: 'var(--tb-info-tint)' },
        nav: { DEFAULT: 'var(--tb-nav)', active: 'var(--tb-nav-active)', text: 'var(--tb-nav-text)', muted: 'var(--tb-nav-muted)', accent: 'var(--tb-nav-accent)' },
        action: { DEFAULT: 'var(--tb-action)', hover: 'var(--tb-action-hover)' },
      },
      // The type scale. Nine sizes, named for their job; screens never set a pixel size by hand.
      fontSize: {
        '2xs': ['11.5px', { lineHeight: '14px' }], // tab bar labels
        xs: ['12.5px', { lineHeight: '17px' }], // hints, pills, fine print
        meta: ['14px', { lineHeight: '20px' }], // secondary lines, table cells, links in rows
        body: ['15px', { lineHeight: '22px' }], // running text, form values
        lead: ['16px', { lineHeight: '23px' }], // card titles, row titles
        title: ['20px', { lineHeight: '26px', letterSpacing: '-0.01em' }], // section and drawer headings
        figure: ['26px', { lineHeight: '32px', letterSpacing: '-0.02em' }], // stat figures and prices
        display: ['28px', { lineHeight: '34px', letterSpacing: '-0.02em' }], // page titles
        hero: ['40px', { lineHeight: '44px', letterSpacing: '-0.025em' }], // the one big number
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

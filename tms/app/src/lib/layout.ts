/**
 * Every signed-in page starts under the logo, so the content does not jump sideways when you
 * move between tabs. Pages of reading or forms keep a comfortable line length by capping each
 * top-level block, still aligned left with the header.
 */
const BASE = 'mx-auto w-full max-w-6xl px-4 py-6 sm:px-5';

export const PAGE = {
  wide: BASE,
  medium: `${BASE} [&>*]:max-w-4xl`,
  reading: `${BASE} [&>*]:max-w-3xl`,
  narrow: `${BASE} [&>*]:max-w-2xl`,
} as const;

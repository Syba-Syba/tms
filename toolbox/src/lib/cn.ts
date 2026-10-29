import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/*
 * The type scale's names (text-body, text-meta and the rest) are font sizes. tailwind-merge
 * only knows Tailwind's own size names, so without this it read `text-body` as a colour and
 * dropped the button's `text-ink-inverse`: white labels on primary buttons came out black.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs', 'meta', 'body', 'lead', 'title', 'figure', 'display', 'hero'] }],
    },
  },
});

/** Later Tailwind classes win, so consumers can override any component style through className. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

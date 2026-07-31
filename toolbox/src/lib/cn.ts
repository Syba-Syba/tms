import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Later Tailwind classes win, so consumers can override any component style through className. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

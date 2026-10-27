import type { SVGProps } from 'react';

/** Navigation icons. Stroke icons on a 24 grid, sized by font-size and coloured by currentColor. */
const Svg = ({ children, ...props }: SVGProps<SVGSVGElement>) => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...props}
  >
    {children}
  </svg>
);

export const HomeIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></Svg>
);
export const WalletIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18" /><path d="M16 15h2" /><path d="M6 6V5a2 2 0 0 1 2-2h9" /></Svg>
);
export const WrenchIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" /></Svg>
);
export const BuildingIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" /><path d="M10 21v-3h4v3" /></Svg>
);
export const InboxIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M4 13 6 5h12l2 8" /><path d="M4 13v6h16v-6h-5l-1 2h-4l-1-2z" /></Svg>
);
export const ChartIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></Svg>
);
export const FileIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 16h6" /></Svg>
);
export const SettingsIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /></Svg>
);
export const MoreIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></Svg>
);
export const LogOutIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M15 4h4v16h-4" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></Svg>
);

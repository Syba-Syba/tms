/** A doorway, drawn once, beside the name. `onDark` is for the green sidebar. */
export function Wordmark({ small = false, onDark = false }: { small?: boolean; onDark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`${small ? 'h-[13px] w-[10px] border-2' : 'h-[20px] w-[16px] border-[2.5px]'} rounded-t-full border-b-0 ${onDark ? 'border-nav-accent' : 'border-brand-500'}`} aria-hidden />
      <b className={`font-display font-extrabold tracking-[-0.02em] ${onDark ? 'text-white' : 'text-ink'} ${small ? 'text-meta' : 'text-title'}`}>Threshold</b>
    </span>
  );
}

/** A landlord's initials inside the same doorway: their mark on their own listings page. */
export function DoorwayMonogram({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
  return (
    <span aria-hidden
      className="flex h-16 w-14 shrink-0 items-end justify-center rounded-t-full border-[2.5px] border-b-0 border-brand-500 bg-surface pb-2 font-display text-title font-bold text-ink">
      {initials || 'T'}
    </span>
  );
}

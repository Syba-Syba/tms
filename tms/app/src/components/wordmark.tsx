/** A doorway, drawn once, and the name set in the statement serif. */
export function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`${small ? 'h-[13px] w-[10px] border-[1.25px]' : 'h-[18px] w-[14px] border-[1.5px]'} rounded-t-full border-b-0 border-ink`} aria-hidden />
      <b className={`font-display font-semibold tracking-[-0.01em] text-ink ${small ? 'text-meta' : 'text-title'}`}>Threshold</b>
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
      className="flex h-16 w-14 shrink-0 items-end justify-center rounded-t-full border-[1.5px] border-b-0 border-ink bg-surface pb-2 font-display text-title font-semibold text-ink">
      {initials || 'T'}
    </span>
  );
}

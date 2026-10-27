import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { cn } from '../lib/cn';

/** Renders references like a stamped plate: mono, spaced, riveted corners. Click copies. */
export function TagField({ label, value, className }: { label: string; value: string; className?: string }) {
  const { copied, failed, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      title="Copy"
      className={cn(
        'group relative inline-flex flex-col items-start rounded-sm border border-line bg-surface-muted px-3.5 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]',
        className,
      )}
    >
      <span className="absolute left-1 top-1 h-1 w-1 rounded-full bg-neutral-400/60" />
      <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-neutral-400/60" />
      <span className="absolute bottom-1 left-1 h-1 w-1 rounded-full bg-neutral-400/60" />
      <span className="absolute bottom-1 right-1 h-1 w-1 rounded-full bg-neutral-400/60" />
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-muted">
        {copied ? 'Copied' : failed ? 'Select to copy' : label}
      </span>
      {/* select-all so a failed copy still leaves the value one long-press from the clipboard. */}
      <span className="select-all font-mono text-sm font-medium tracking-[0.14em] text-ink">{value}</span>
    </button>
  );
}

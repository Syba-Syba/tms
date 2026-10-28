import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { cn } from '../lib/cn';

/** A reference the reader may need to type into a bank app: label above, value in mono. Click copies. */
export function TagField({ label, value, className }: { label: string; value: string; className?: string }) {
  const { copied, failed, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      title="Copy"
      className={cn(
        'inline-flex flex-col items-start rounded-sm border border-line bg-surface px-3 py-2 text-left hover:border-neutral-400',
        className,
      )}
    >
      <span className="text-[12px] text-ink-muted">{copied ? 'Copied' : failed ? 'Select to copy' : label}</span>
      {/* select-all so a failed copy still leaves the value one long-press from the clipboard. */}
      <span className="select-all font-mono text-[15px] font-medium text-ink">{value}</span>
    </button>
  );
}

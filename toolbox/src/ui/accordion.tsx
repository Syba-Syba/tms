/** Native details/summary, styled. Free keyboard support, free semantics, nothing to break. */
export function Accordion({
  items,
}: {
  items: { title: string; content: React.ReactNode; defaultOpen?: boolean }[];
}) {
  return (
    <div className="divide-y divide-[var(--tb-border)] rounded-lg border border-line bg-surface">
      {items.map((item) => (
        <details key={item.title} open={item.defaultOpen} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-body font-medium text-ink [&::-webkit-details-marker]:hidden">
            {item.title}
            <span className="text-ink-muted transition-transform group-open:rotate-90">›</span>
          </summary>
          <div className="px-4 pb-4 text-body text-ink-muted">{item.content}</div>
        </details>
      ))}
    </div>
  );
}

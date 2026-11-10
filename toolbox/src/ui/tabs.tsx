import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '../lib/cn';

export interface TabItem {
  value: string;
  label: string;
  content: React.ReactNode;
}

export function Tabs({
  items,
  defaultValue,
  className,
}: {
  items: TabItem[];
  defaultValue?: string;
  className?: string;
}) {
  return (
    <RadixTabs.Root defaultValue={defaultValue ?? items[0]?.value} className={className}>
      <RadixTabs.List className="flex gap-6 overflow-x-auto border-b border-line">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className={cn(
              '-mb-px whitespace-nowrap border-b-[3px] border-transparent pb-3 pt-1.5 text-body font-medium text-ink-muted transition-colors hover:text-ink',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tb-ring)]',
              'data-[state=active]:border-brand-500 data-[state=active]:font-bold data-[state=active]:text-ink',
            )}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="pt-5 focus-visible:outline-none">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

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
      <RadixTabs.List className="flex gap-1 border-b border-line">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className={cn(
              'px-4 py-2 text-sm text-ink-muted transition-colors hover:text-ink',
              'data-[state=active]:border-b-2 data-[state=active]:border-brand-500 data-[state=active]:text-ink',
            )}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="pt-4">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

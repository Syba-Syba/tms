import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../lib/cn';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  keywords?: string;
  run: () => void;
}

/** Ctrl+K / Cmd+K opens it. Plain substring match on label and keywords, no fuzzy magic to explain. */
export function CommandPalette({ commands, placeholder = 'Search actions...' }: { commands: Command[]; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
        setQuery('');
        setActive(0);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.keywords ?? ''}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  const runActive = () => {
    const command = matches[active];
    if (!command) return;
    setOpen(false);
    command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-24 z-40 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-lg focus:outline-none"
          aria-label="Command palette"
        >
          <input
            autoFocus
            value={query}
            placeholder={placeholder}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') setActive((i) => Math.min(i + 1, matches.length - 1));
              if (event.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
              if (event.key === 'Enter') runActive();
            }}
            className="w-full border-b border-line bg-transparent px-4 py-3 text-body text-ink outline-none placeholder:text-ink-muted"
          />
          <ul ref={listRef} className="max-h-72 overflow-auto py-1">
            {matches.length === 0 ? (
              <li className="px-4 py-6 text-center text-body text-ink-muted">
                Nothing matches "{query}".
              </li>
            ) : (
              matches.map((command, index) => (
                <li key={command.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={runActive}
                    className={cn(
                      'flex w-full items-center justify-between px-4 py-2.5 text-left text-body',
                      index === active ? 'bg-brand-50 text-brand-700' : 'text-ink',
                    )}
                  >
                    <span>
                      {command.group ? (
                        <span className="mr-2 font-mono text-2xs uppercase tracking-wider text-ink-muted">
                          {command.group}
                        </span>
                      ) : null}
                      {command.label}
                    </span>
                    {command.hint ? <Kbd>{command.hint}</Kbd> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="flex gap-3 border-t border-line px-4 py-2 text-2xs text-ink-muted">
            <span><Kbd>↑↓</Kbd> move</span>
            <span><Kbd>↵</Kbd> run</span>
            <span><Kbd>esc</Kbd> close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-sm border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-muted shadow-[inset_0_-1px_0_var(--tb-border)]">
      {children}
    </kbd>
  );
}

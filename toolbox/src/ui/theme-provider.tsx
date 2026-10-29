import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
export type ThemeChoice = Theme | 'system';

const ThemeContext = createContext<{
  theme: Theme;
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  /** Kept for older callers: picks light or dark outright. */
  setTheme: (theme: Theme) => void;
} | null>(null);

const systemTheme = (): Theme =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const readChoice = (key: string): ThemeChoice => {
  try {
    const saved = localStorage.getItem(key);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
};

/**
 * Follows the phone or computer's light or dark setting, live, unless the person picks one in
 * the app. Only an explicit pick is stored. The old version stored "light" before it had read
 * the system setting, then read its own default back, so dark mode never came on.
 */
export function ThemeProvider({
  children,
  storageKey = 'tb-theme',
}: {
  children: React.ReactNode;
  storageKey?: string;
}) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice(storageKey));
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = choice === 'system' ? system : choice;

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const update = () => setSystem(query.matches ? 'dark' : 'light');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setChoice = (next: ThemeChoice) => {
    setChoiceState(next);
    try {
      if (next === 'system') localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, next);
    } catch {
      // Private browsing: the choice lasts for this visit.
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, choice, setChoice, setTheme: setChoice }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider.');
  return context;
}

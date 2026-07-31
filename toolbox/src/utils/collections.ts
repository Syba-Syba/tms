export const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

export function groupBy<T, K extends string | number>(items: T[], key: (item: T) => K) {
  return items.reduce<Record<K, T[]>>(
    (acc, item) => {
      const group = key(item);
      (acc[group] ||= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>,
  );
}

export const uniqueBy = <T>(items: T[], key: (item: T) => unknown) => {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};

export const sortBy = <T>(items: T[], key: (item: T) => string | number, dir: 'asc' | 'desc' = 'asc') =>
  [...items].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) return 0;
    return (left < right ? -1 : 1) * (dir === 'asc' ? 1 : -1);
  });

export const sum = (items: number[]) => items.reduce((total, value) => total + value, 0);

export const safeJsonParse = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

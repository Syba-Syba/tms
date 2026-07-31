import { useEffect, useRef } from 'react';

/** Pass null to pause without unmounting. */
export function useInterval(callback: () => void, delay: number | null) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    const timer = setInterval(() => saved.current(), delay);
    return () => clearInterval(timer);
  }, [delay]);
}

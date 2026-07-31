import { useEffect, useState, type RefObject } from 'react';

export function useIntersection<T extends Element>(
  ref: RefObject<T>,
  options?: IntersectionObserverInit,
) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), options);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, options]);
  return visible;
}

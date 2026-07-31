import { useEffect, useState } from 'react';
import { signedUrl } from '../api/client';

/** Renders a stored photo by exchanging its key for a short-lived link on mount. */
export function SignedImage({ storageKey, alt, className }: {
  storageKey: string;
  alt: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    signedUrl(storageKey)
      .then((url) => { if (!cancelled) setSrc(url); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [storageKey]);

  if (failed) return null;
  if (!src) return <div className={`animate-pulse bg-surface-muted ${className ?? ''}`} />;
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}

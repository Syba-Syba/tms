import { useEffect, useState } from 'react';

/** navigator.onLine lies about captive portals, so an optional ping URL confirms real reachability. */
export function useOnlineStatus(pingUrl?: string, intervalMs = 30000) {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    if (!pingUrl) return;
    const check = async () => {
      try {
        await fetch(pingUrl, { method: 'HEAD', cache: 'no-store' });
        setOnline(true);
      } catch {
        setOnline(false);
      }
    };
    const timer = setInterval(check, intervalMs);
    return () => clearInterval(timer);
  }, [pingUrl, intervalMs]);

  return online;
}

import { useEffect, useState } from 'react';

// Native has no NetInfo dependency, so there the product pull's state alone decides; only the web listens.
const web = () => typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  && typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean';

/** The browser's network state: `navigator.onLine`, then its `online`/`offline` events. Always true on native. */
export function useNetworkOnline(): boolean {
  const [online, setOnline] = useState(() => web() ? navigator.onLine : true);
  useEffect(() => {
    if (!web()) return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

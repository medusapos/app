import { useEffect, useRef } from 'react';
import { useScanHub } from '@tallyui/pos';

// The directly connected scanners' codes (HID-POS, Web Serial) from the app's ScanHubProvider, while `active`. No
// timing heuristics: each controller already frames one code per scan. Outside a provider the hub is inert.
export function useDeviceScans(active: boolean, onScan: (code: string) => void): void {
  const onScanRef = useRef(onScan); onScanRef.current = onScan;
  const hub = useScanHub();
  useEffect(() => {
    if (!active) return;
    const subscription = hub.events$.subscribe((event) => onScanRef.current(event.code));
    return () => subscription.unsubscribe();
  }, [active, hub]);
}

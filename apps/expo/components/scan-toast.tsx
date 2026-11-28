// v2's scan toasts: Sale's "Added to cart" and "Barcode not found" (02f.3), and Products' "Barcode scanned" (12.13).
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Circle, Path } from 'react-native-svg';
import { createSvgIcon, Toast, ToastDescription, ToastTitle } from '@tallyui/components';
import type { VariantSummary } from '@tallyui/core';
import { PRODUCTS_SCAN_MATCHES } from '../lib/products-area';
import { WarningIcon } from './offline-toast';

// How long a scan toast stays; a new scan replaces it and restarts the wait.
export const SCAN_TOAST_MS = 3_000;

export type ScanToastState = { kind: 'added'; description: string } | { kind: 'not-found'; code: string }
  | { kind: 'scanned'; code: string; count: number };

/**
 * The added toast's second line: the product name, then " · " and the variant's label when it has one — its option
 * values (v2's "XS, Gray"), else its title when the product has more than one variant (a Medusa product with one
 * variant has no label worth showing).
 */
export function scanAddedDescription(name: string, variant: VariantSummary, variantCount: number): string {
  const options = Object.values(variant.options ?? {});
  const label = options.length ? options.join(', ') : variantCount > 1 ? variant.title?.trim() : undefined;
  return label ? `${name} · ${label}` : name;
}

/** The scan toast's state: `show` replaces it and restarts the SCAN_TOAST_MS wait; `clear` hides it at once. */
export function useScanToast(): { toast: ScanToastState | null; show: (next: ScanToastState) => void; clear: () => void } {
  const [toast, setToast] = useState<ScanToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; setToast(null); }, []);
  const show = useCallback((next: ScanToastState) => {
    clearTimeout(timer.current);
    setToast(next);
    timer.current = setTimeout(() => { timer.current = undefined; setToast(null); }, SCAN_TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { toast, show, clear };
}

const CheckCircleIcon = createSvgIcon('CheckCircleIcon', () => <>
  <Circle cx="12" cy="12" r="10" />
  <Path d="m9 12 2 2 4-4" />
</>);

export function ScanToast({ toast }: { toast: ScanToastState }) {
  const success = toast.kind === 'added' || (toast.kind === 'scanned' && toast.count > 0);
  // An opaque surface with a tone layer on it, as the offline toast: it floats over the till, which must not show through.
  return <Toast testID="scan-toast" {...(success ? { accessibilityLiveRegion: 'polite' as const } : { accessibilityRole: 'alert' as const })}
    className={`max-w-md gap-3 bg-background p-3 ${success ? 'border-success' : 'border-warning'}`}>
    <View pointerEvents="none" className={`absolute inset-0 ${success ? 'bg-success/15' : 'bg-warning/15'}`} />
    {success ? <View className="text-success"><CheckCircleIcon size={24} /></View>
      : <View className="text-warning"><WarningIcon size={24} /></View>}
    <View className="flex-1">
      <ToastTitle className="text-foreground">{toast.kind === 'scanned' ? `Barcode scanned: ${toast.code}` : success ? 'Added to cart' : 'Barcode not found'}</ToastTitle>
      <ToastDescription className="text-foreground">{toast.kind === 'scanned' ? PRODUCTS_SCAN_MATCHES(toast.count) : toast.kind === 'added' ? toast.description : `${toast.code} — not in this store`}</ToastDescription>
    </View>
  </Toast>;
}

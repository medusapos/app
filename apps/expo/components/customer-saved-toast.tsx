// v2's "{name} saved" message after Add Customer on the Customers screen (DEMO-PARITY row 11).
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Circle, Path } from 'react-native-svg';
import { createSvgIcon, Toast, ToastTitle } from '@tallyui/components';

// How long the message stays; a new save replaces it and restarts the wait (as the app's other passing toasts).
export const CUSTOMER_SAVED_TOAST_MS = 3_000;

/** v2's `common.saved`. */
export const customerSavedText = (name: string): string => `${name} saved`;

/** The name the message shows, else null: `show` (re)starts the wait, `clear` hides it at once. */
export function useCustomerSavedToast(): { name: string | null; show: (name: string) => void; clear: () => void } {
  const [name, setName] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setName(null);
  }, []);
  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setName(next);
    timer.current = setTimeout(() => { timer.current = null; setName(null); }, CUSTOMER_SAVED_TOAST_MS);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { name, show, clear };
}

const CheckCircleIcon = createSvgIcon('CheckCircleIcon', () => <>
  <Circle cx={12} cy={12} r={10} />
  <Path d="m9 12 2 2 4-4" />
</>);

export function CustomerSavedToast({ name }: { name: string }) {
  // An opaque surface with a green layer on it: the toast floats over the list, which must not show through.
  return <Toast testID="customer-saved-toast" accessibilityLiveRegion="polite"
    className="max-w-md gap-3 border-success bg-background p-3">
    <View pointerEvents="none" className="absolute inset-0 bg-success/15" />
    <View className="text-success"><CheckCircleIcon size={24} /></View>
    <View className="flex-1">
      <ToastTitle className="text-foreground">{customerSavedText(name)}</ToastTitle>
    </View>
  </Toast>;
}

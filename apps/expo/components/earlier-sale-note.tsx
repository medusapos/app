import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { storageHealth$ } from '../lib/storage-health';

// Sign out's lock message while only an earlier, abandoned save is in flight.
export const EARLIER_SALE_SAVING = 'An earlier sale is still being saved.';

// The note's wording (#86 review): shared by the sale screen and every store-settings screen so
// they can't drift. Off the sale screen, `saving`/`receipt` are always false. `stalled` appends
// the Reload hint: safe only for an earlier save, which exists only after Continue (isStored true).
export function earlierSaleNoteText(savesInFlight: number, saving: boolean, deferred: boolean, receipt: boolean, stalled: boolean): string | null {
  if (savesInFlight > 0 && !saving) {
    const base = !deferred ? EARLIER_SALE_SAVING
      : receipt ? `${EARLIER_SALE_SAVING} You'll be signed out once it's saved and you start a new sale.`
        : `${EARLIER_SALE_SAVING} You'll be signed out once it's saved.`;
    return stalled ? `${base} That sale is already stored; reload if this doesn't clear.` : base;
  }
  if (deferred && saving) return 'Signed out after this sale is saved';
  if (deferred && receipt) return "You'll be signed out when you start a new sale.";
  return null;
}

export function EarlierSaleNote({ saving = false, receipt = false }: { saving?: boolean; receipt?: boolean }) {
  const { signOutDeferred } = useSession();
  const { savesInFlight } = useOutboxContext();
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const subscription = storageHealth$.subscribe((status) => setStalled(status === 'stalled'));
    return () => subscription.unsubscribe();
  }, []);
  const text = earlierSaleNoteText(savesInFlight, saving, signOutDeferred, receipt, stalled);
  return text ? <View dataSet={{ print: 'hide' }} className="px-4 py-1">
    <Text className="text-sm text-muted-foreground">{text}</Text></View> : null;
}

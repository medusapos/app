import { useEffect, useState } from 'react';
import type { ProductTraits } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type Order, type PosOrder } from '@tallyui/pos';
import type { CatalogueEntry } from './catalogue';
import { addEntryToCart, CartError } from './cart';
import { taxContextFor, type StoreSettings } from './store-settings';

export type SaleStage = { kind: 'cart' } | { kind: 'tender'; method: 'cash' | 'external' }
  | { kind: 'receipt'; order: Order; posOrder: PosOrder };

export function useSale(settings: StoreSettings, opts: {
  registerId: string; cashierRef: string; onSaleCompleted?: (posOrder: PosOrder) => void;
}) {
  const [builder, setBuilder] = useState(() => createOrderBuilder({
    currency: settings.currency, taxContext: taxContextFor(settings),
  }));
  const [order, setOrder] = useState(() => builder.getSnapshot());
  const [stage, setStage] = useState<SaleStage>({ kind: 'cart' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const subscription = builder.order$.subscribe(setOrder);
    return () => subscription.unsubscribe();
  }, [builder]);

  function setTender(tender: { method: 'cash' | 'external'; amountMinor: number; reference?: string } | null) {
    const previous = builder.getSnapshot().payments[0];
    if (previous) builder.removePayment(previous.id);
    if (tender) builder.addPayment(tender);
    setError(null);
  }

  return {
    order, stage, error,
    add(entry: CatalogueEntry<any>, traits: ProductTraits<any>) {
      try {
        addEntryToCart(builder, entry, traits, settings.currency);
        setError(null);
      } catch (error) {
        if (!(error instanceof CartError)) throw error;
        setError(error.message);
      }
    },
    setQuantity(lineId: string, quantity: number) { builder.updateQuantity(lineId, quantity); },
    remove(lineId: string) { builder.removeItem(lineId); },
    startTender(method: 'cash' | 'external') {
      const current = builder.getSnapshot();
      if (!current.lineItems.length) return;
      setTender(method === 'external' ? { method, amountMinor: current.totalMinor } : null);
      setStage({ kind: 'tender', method });
    },
    setTender,
    cancelTender() { setTender(null); setStage({ kind: 'cart' }); },
    complete() {
      const current = builder.getSnapshot();
      let posOrder: PosOrder;
      try {
        posOrder = finalizeOrder(current, { registerId: opts.registerId, cashierRef: opts.cashierRef });
      } catch (error) {
        setError((error as Error).message);
        return;
      }
      setError(null);
      setStage({ kind: 'receipt', order: current, posOrder });
      opts.onSaleCompleted?.(posOrder);
    },
    newSale() {
      const next = createOrderBuilder({ currency: settings.currency, taxContext: taxContextFor(settings) });
      setBuilder(next);
      setOrder(next.getSnapshot());
      setStage({ kind: 'cart' });
      setError(null);
    },
  };
}

import { useEffect, useRef, useState } from 'react';
import type { ProductTraits, StoreSettings } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, useTax, type Order, type PosOrder } from '@tallyui/pos';
import type { CatalogueEntry } from './catalogue';
import { addEntryToCart, CartError } from './cart';

export type SaleStage = { kind: 'cart' } | { kind: 'tender'; method: 'cash' | 'external' }
  | { kind: 'receipt'; order: Order; posOrder: PosOrder };

/** Call under a `TaxProvider`: its tax context and the settings' currency price every sale. */
export function useSale(settings: Pick<StoreSettings, 'currency'>, opts: {
  registerId: string; cashierRef: string; onSaleCompleted?: (posOrder: PosOrder) => Promise<void> | void;
}) {
  const taxContext = useTax();
  const madeWith = useRef({ taxContext, currency: settings.currency });
  const [builder, setBuilder] = useState(() => createOrderBuilder({ currency: settings.currency, taxContext }));
  const [order, setOrder] = useState(() => builder.getSnapshot());
  const [stage, setStage] = useState<SaleStage>({ kind: 'cart' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const subscription = builder.order$.subscribe(setOrder);
    return () => subscription.unsubscribe();
  }, [builder]);
  // New tax settings or currency wait until the sale is idle (an empty cart), then start a new sale on them:
  // a sale in progress (lines, tender or receipt) finishes on the settings it started with (a money rule).
  const idle = stage.kind === 'cart' && !order.lineItems.length;
  useEffect(() => {
    if (idle && (madeWith.current.taxContext !== taxContext || madeWith.current.currency !== settings.currency)) result.newSale();
  });

  function setTender(tender: { method: 'cash' | 'external'; amountMinor: number; reference?: string } | null) {
    const previous = builder.getSnapshot().payments[0];
    if (previous) builder.removePayment(previous.id);
    if (tender) builder.addPayment(tender);
    setError(null);
  }

  const result = {
    order, stage, error, idle,
    add(entry: CatalogueEntry<any>, traits: ProductTraits<any>) {
      try {
        addEntryToCart(builder, entry, traits, madeWith.current.currency);
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
    async complete() {
      const current = builder.getSnapshot();
      let posOrder: PosOrder;
      try {
        posOrder = finalizeOrder(current, { registerId: opts.registerId, cashierRef: opts.cashierRef });
      } catch (error) {
        setError((error as Error).message);
        return;
      }
      try {
        await opts.onSaleCompleted?.(posOrder);
      } catch (error) {
        setError(`The sale could not be saved: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      setError(null);
      setStage({ kind: 'receipt', order: current, posOrder });
    },
    newSale() {
      madeWith.current = { taxContext, currency: settings.currency };
      const next = createOrderBuilder({ currency: settings.currency, taxContext });
      setBuilder(next);
      setOrder(next.getSnapshot());
      setStage({ kind: 'cart' });
      setError(null);
    },
  };
  return result;
}

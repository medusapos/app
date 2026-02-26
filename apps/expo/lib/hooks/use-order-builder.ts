import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createOrderBuilder, useTax } from '@tallyui/pos';
import type { OrderBuilder, Order } from '@tallyui/pos';

const OrderBuilderContext = createContext<OrderBuilder | null>(null);

export function OrderBuilderProvider({ children }: { children: ReactNode }) {
  const taxContext = useTax();
  const [builder] = useState(() =>
    createOrderBuilder({ currency: 'usd', taxContext })
  );

  return (
    <OrderBuilderContext.Provider value={builder}>
      {children}
    </OrderBuilderContext.Provider>
  );
}

export function useOrderBuilder(): OrderBuilder {
  const builder = useContext(OrderBuilderContext);
  if (!builder) throw new Error('useOrderBuilder must be used within OrderBuilderProvider');
  return builder;
}

export function useOrder(): Order {
  const builder = useOrderBuilder();
  const [order, setOrder] = useState<Order>(() => builder.getSnapshot());

  useEffect(() => {
    const sub = builder.order$.subscribe(setOrder);
    return () => sub.unsubscribe();
  }, [builder]);

  return order;
}

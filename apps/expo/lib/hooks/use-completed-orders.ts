import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { Order } from '@tallyui/pos';

interface CompletedOrdersContextValue {
  orders: Order[];
  saveCompletedOrder: (order: Order) => void;
}

const CompletedOrdersContext = createContext<CompletedOrdersContextValue>({
  orders: [],
  saveCompletedOrder: () => {},
});

export function CompletedOrdersProvider({ children }: { children: ReactNode }) {
  const [orders, setOrders] = useState<Order[]>([]);

  const saveCompletedOrder = useCallback((order: Order) => {
    setOrders((prev) => [order, ...prev]);
  }, []);

  return (
    <CompletedOrdersContext.Provider value={{ orders, saveCompletedOrder }}>
      {children}
    </CompletedOrdersContext.Provider>
  );
}

export function useCompletedOrders() {
  return useContext(CompletedOrdersContext);
}

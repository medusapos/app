import { useState, useEffect } from 'react';
import { createRepository } from '@tallyui/pos';
import { useDatabaseContext } from './use-database';

export function useProducts(searchTerm?: string) {
  const db = useDatabaseContext();
  const [products, setProducts] = useState<any[]>([]);

  useEffect(() => {
    const repo = createRepository(db.products);
    const sub = searchTerm
      ? repo.search$(searchTerm, ['title', 'handle'] as any).subscribe(setProducts)
      : repo.findAll$().subscribe(setProducts);
    return () => sub.unsubscribe();
  }, [db, searchTerm]);

  return products;
}

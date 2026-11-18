import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { CategoryNav, ProductTable, SearchInput, Text, type ProductTableColumn } from '@tallyui/components';
import { listCategories } from '@tallyui/pos';
import { FrameMenuButton } from '../components/app-frame';
import { useCatalogueSnapshot } from '../lib/catalogue-snapshot';
import {
  filterProductAreaRows, filterProductAreaRowsByCategory, productAreaRows, PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_NO_MATCH,
  PRODUCTS_NOT_LOADED, STOCK_STATUS_DOTS, STOCK_STATUS_LABELS, type ProductAreaRow,
} from '../lib/products-area';
import { useSession } from '../lib/session-context';

const COLUMNS: ProductTableColumn<ProductAreaRow>[] = [
  { id: 'name', header: 'Product', flex: 3, sortValue: (row) => row.name, render: (row) => <Text>{row.name}</Text> },
  { id: 'sku', header: 'SKU', flex: 1.5, sortValue: (row) => row.sku, render: (row) => <Text>{row.sku}</Text> },
  { id: 'stock', header: 'Stock', align: 'right', flex: 1, render: (row) => <Text className="tabular-nums">{row.stock}</Text> },
  { id: 'stockStatus', header: 'Stock status', flex: 1.5, sortValue: (row) => STOCK_STATUS_LABELS[row.stockStatus], render: (row) =>
    <View className="flex-row items-center gap-1.5" testID={`product-stock-status-${row.id}`}>
      <View className={`h-2 w-2 rounded-full ${STOCK_STATUS_DOTS[row.stockStatus]}`} />
      <Text className={row.stockStatus === 'unknown' ? 'text-muted-foreground' : undefined}>{STOCK_STATUS_LABELS[row.stockStatus]}</Text>
    </View> },
  { id: 'category', header: 'Category', flex: 1.5, sortValue: (row) => row.categories,
    render: (row) => <Text numberOfLines={1}>{row.categories}</Text> },
  { id: 'price', header: 'Price', align: 'right', flex: 1, render: (row) => <Text className="tabular-nums">{row.price}</Text> },
];

// v2's Products area, read-only: the catalogue the Sale screen already holds; editing happens in Medusa Admin.
export default function ProductsAreaScreen() {
  const { session } = useSession();
  const snapshot = useCatalogueSnapshot();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const loaded = snapshot && session && snapshot.baseUrl === session.baseUrl ? snapshot : null;
  const rows = useMemo(() => loaded ? productAreaRows(loaded.products, loaded.traits, loaded.currency) : [], [loaded]);
  const categories = useMemo(() => loaded ? listCategories(loaded.products, loaded.traits) : [], [loaded]);
  // A chosen category no longer in the catalogue counts as All, as the Sale's chips do.
  const activeId = categoryId !== null && categories.some((category) => category.id === categoryId) ? categoryId : null;
  const items = useMemo(() => filterProductAreaRows(filterProductAreaRowsByCategory(rows, activeId), search), [rows, activeId, search]);
  if (!session) return <Redirect href="/login" />;
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ title: 'Products', headerLeft: () => <FrameMenuButton /> }} />
    <View className="flex-row items-center gap-2 px-4 pt-4 pb-2">
      <SearchInput className="flex-1" value={search} onChangeText={setSearch} placeholder="Search Products"
        accessibilityLabel="Search Products" testID="products-search" />
    </View>
    {loaded && categories.length ? <View><CategoryNav className="px-1" testID="products-categories"
      categories={[{ id: '', name: 'All products' }, ...categories]} selectedId={activeId ?? ''}
      onSelect={(id) => setCategoryId(id === '' ? null : id)} /></View> : null}
    <View className="px-4 pb-2">
      <Text className="text-sm text-muted-foreground" testID="products-admin-note">{PRODUCTS_ADMIN_NOTE}</Text>
    </View>
    {loaded ? <ProductTable testID="products-table" items={items} columns={COLUMNS as ProductTableColumn[]}
      defaultSort={{ field: 'name', dir: 'asc' }} emptyState={
        <Text className="text-center text-muted-foreground">{search.trim() ? PRODUCTS_NO_MATCH(search) : PRODUCTS_EMPTY}</Text>
      } /> : <View className="flex-1 items-center justify-center px-4">
      <Text className="text-center text-muted-foreground" testID="products-not-loaded">{PRODUCTS_NOT_LOADED}</Text>
    </View>}
  </View>;
}

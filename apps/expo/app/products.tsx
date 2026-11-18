import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import {
  Button, Card, CategoryNav, Loader, ProductList, ProductTable, SearchInput, Text, type ProductTableColumn,
} from '@tallyui/components';
import { listCategories, sortProducts } from '@tallyui/pos';
import { AreaAccountButton, FrameMenuButton, useFrameMenu } from '../components/app-frame';
import { ProductsAreaColumnsButton } from '../components/products-area-columns-settings';
import { StripHeightContext } from '../components/store-refused';
import { StoreSettingsGate, type TillCatalogueLeafProps } from '../components/till-catalogue-gate';
import { catalogueStatus, publishCatalogue, sellableCatalogue, useCatalogueSnapshot, withdrawCatalogue } from '../lib/catalogue-snapshot';
import {
  filterProductAreaRows, filterProductAreaRowsByCategory, filterProductAreaRowsInStock, loadProductsAreaCategory, productAreaRows,
  productAreaStockLine,
  PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_IN_STOCK_LABEL, PRODUCTS_LOADING, PRODUCTS_LOAD_FAILED, PRODUCTS_NO_MATCH,
  PRODUCTS_NONE_IN_STOCK, PRODUCTS_SHOWING, saveProductsAreaCategory, STOCK_STATUS_DOTS, STOCK_STATUS_LABELS, type ProductAreaRow,
} from '../lib/products-area';
import { useProductsAreaColumns, type ProductsAreaColumn } from '../lib/products-area-columns';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { useReplicatedProducts } from '../lib/use-replicated-products';

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

// ADR 0009: phone mode below 600 px.
const PHONE_BREAKPOINT = 600;
// The table's default order, so both layouts list rows alike.
const NAME_SORT = { field: 'name', dir: 'asc' } as const;

// v2's phone row: name over SKU, price over the stock line. Rows open nothing, as the table's do.
function PhoneRow({ row }: { row: ProductAreaRow }) {
  return <View className="flex-row gap-3 px-4 py-3" testID={`product-list-row-${row.id}`}>
    <View className="min-w-0 flex-1">
      <Text>{row.name}</Text>
      {row.sku ? <Text className="text-sm text-muted-foreground">{row.sku}</Text> : null}
    </View>
    <View className="items-end">
      <Text className="tabular-nums">{row.price}</Text>
      <View className="flex-row items-center gap-1.5" testID={`product-stock-status-${row.id}`}>
        <View className={`h-2 w-2 rounded-full ${STOCK_STATUS_DOTS[row.stockStatus]}`} />
        <Text className={`text-sm${row.stockStatus === 'unknown' ? ' text-muted-foreground' : ''}`}>{productAreaStockLine(row)}</Text>
      </View>
    </View>
  </View>;
}

// The area's own catalogue read, while no Sale holds one: the Sale's replication over the same cache, read-only.
// It publishes what it reads and renders nothing.
function ProductsCatalogue({ session, connector, syncContext, onUnauthorized, pricing, retry }: TillCatalogueLeafProps & { retry: () => void }) {
  const { products, state, error, stockOverlay } = useReplicatedProducts(connector, syncContext, onUnauthorized);
  const catalogue = useMemo(() => sellableCatalogue(products, connector, stockOverlay), [products, connector, stockOverlay]);
  const status = catalogueStatus(products.length, state);
  useEffect(() => {
    publishCatalogue({ owner: 'products', baseUrl: session.baseUrl, products: catalogue, traits: connector.traits.product,
      currency: pricing.currency, status, error: error ?? undefined, retry });
  }, [session.baseUrl, catalogue, connector, pricing.currency, status, error, retry]);
  useEffect(() => () => withdrawCatalogue('products'), []);
  return null;
}

// v2's Products area, read-only: the Sale's catalogue when the Sale holds one, else its own read of the same cache;
// editing happens in Medusa Admin.
export default function ProductsAreaScreen() {
  const { session, signOut, reportUnauthorized, reportNoPosAccess, mergeCapabilities } = useSession();
  const snapshot = useCatalogueSnapshot();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(() =>
    session ? loadProductsAreaCategory(defaultStorage(), session.baseUrl) : null);
  const [inStockOnly, setInStockOnly] = useState(false);
  const columns = useProductsAreaColumns(defaultStorage(), session?.baseUrl ?? '');
  // The Product column always shows; the rest follow the settings sheet, in table order.
  const tableColumns = useMemo(() => COLUMNS.filter(({ id }) =>
    id === 'name' || columns.settings[id as ProductsAreaColumn]), [columns.settings]);
  // Retry remounts the read (a fresh useReplicatedProducts); the gate and its store settings stay.
  const [read, setRead] = useState(0);
  const retry = useCallback(() => setRead((count) => count + 1), []);
  const Leaf = useMemo(() => (props: TillCatalogueLeafProps) => <ProductsCatalogue key={read} {...props} retry={retry} />, [read, retry]);
  const loaded = snapshot && session && snapshot.baseUrl === session.baseUrl ? snapshot : null;
  const ready = loaded?.status === 'ready' ? loaded : null;
  const rows = useMemo(() => ready ? productAreaRows(ready.products, ready.traits, ready.currency) : [], [ready]);
  const categories = useMemo(() => ready ? listCategories(ready.products, ready.traits) : [], [ready]);
  // A chosen category no longer in the catalogue counts as All, as the Sale's chips do.
  const activeId = categoryId !== null && categories.some((category) => category.id === categoryId) ? categoryId : null;
  const items = useMemo(() => filterProductAreaRows(
    filterProductAreaRowsInStock(filterProductAreaRowsByCategory(rows, activeId), inStockOnly), search),
  [rows, activeId, inStockOnly, search]);
  const phone = useWindowDimensions().width < PHONE_BREAKPOINT;
  const phoneItems = useMemo(() => phone ? sortProducts(items, NAME_SORT, (row) => row.name) : [], [phone, items]);
  // v2's Products has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  if (!session) return <Redirect href="/login" />;
  // One cache per store and pricing context: the area reads only while the Sale holds no catalogue for this store.
  const saleHolds = loaded?.owner === 'sale';
  const emptyState = <Text className="text-center text-muted-foreground">{search.trim() ? PRODUCTS_NO_MATCH(search)
    : inStockOnly ? PRODUCTS_NONE_IN_STOCK : PRODUCTS_EMPTY}</Text>;
  return <View className="flex-1 bg-background" role="main" aria-label="Products">
    <Stack.Screen options={{ title: 'Products', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
    <View className="flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: 16 + topInset }}>
      <SearchInput className="flex-1" value={search} onChangeText={setSearch} placeholder="Search Products"
        accessibilityLabel="Search Products" testID="products-search" />
      {!phone && <ProductsAreaColumnsButton {...columns} />}
      {!openMenu && <AreaAccountButton />}
    </View>
    {/* In stock first, as in v2's chip row; the category is kept per store, In stock is not. */}
    {ready ? <View className="flex-row items-center pl-4">
      <View className="py-2">
        <Pressable testID="products-in-stock" role="button" aria-pressed={inStockOnly} accessibilityLabel={PRODUCTS_IN_STOCK_LABEL}
          onPress={() => setInStockOnly((on) => !on)} className={`rounded-md px-3 py-1.5 ${inStockOnly ? 'bg-primary' : 'bg-muted'}`}>
          <Text className={`text-sm font-medium ${inStockOnly ? 'text-primary-foreground' : 'text-foreground'}`}>
            {PRODUCTS_IN_STOCK_LABEL}
          </Text>
        </Pressable>
      </View>
      {categories.length ? <CategoryNav className="flex-1" testID="products-categories"
        categories={[{ id: '', name: 'All products' }, ...categories]} selectedId={activeId ?? ''}
        onSelect={(id) => {
          setCategoryId(id === '' ? null : id);
          saveProductsAreaCategory(defaultStorage(), session.baseUrl, id === '' ? null : id);
        }} /> : null}
    </View> : null}
    <View className="px-4 pb-2">
      <Text className="text-sm text-muted-foreground" testID="products-admin-note">{PRODUCTS_ADMIN_NOTE}</Text>
    </View>
    {saleHolds ? null : <StoreSettingsGate key={session.baseUrl} session={session} signOut={signOut} onUnauthorized={reportUnauthorized}
      onNoPosAccess={reportNoPosAccess} onCapabilities={mergeCapabilities} Leaf={Leaf} />}
    {ready && phone ? <ProductList testID="products-list" items={phoneItems} emptyState={emptyState}
      renderItem={(row: ProductAreaRow) => <PhoneRow row={row} />} /> : null}
    {/* v2's table sits in a bordered box, inset as the search row; its phone rows run full width. */}
    {ready && !phone ? <Card testID="products-table-card" className="mx-4 flex-1 overflow-hidden">
      <ProductTable testID="products-table" items={items} columns={tableColumns as ProductTableColumn[]}
        defaultSort={{ field: 'name', dir: 'asc' }} emptyState={emptyState} />
    </Card> : null}
    {/* v2's "Showing n of m": rows after the search and chips, of the whole sellable catalogue. */}
    {ready ? <View className="items-end px-4 py-2" testID="products-footer">
      <Text className="text-sm text-muted-foreground tabular-nums">{PRODUCTS_SHOWING(items.length, rows.length)}</Text>
    </View> : null}
    {loaded?.status === 'loading' ? <View className="flex-1 items-center justify-center gap-3 px-4" testID="products-loading">
      <Loader />
      <Text className="text-center text-muted-foreground">{PRODUCTS_LOADING}</Text>
    </View> : null}
    {loaded?.status === 'error' ? <View className="flex-1 items-center justify-center gap-4 px-4">
      <Text className="text-center text-destructive" testID="products-error">{loaded.error ?? PRODUCTS_LOAD_FAILED}</Text>
      {loaded.retry ? <Button variant="outline" testID="products-retry" onPress={loaded.retry}><Text>Retry</Text></Button> : null}
    </View> : null}
  </View>;
}

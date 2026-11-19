import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Redirect, Stack, usePathname } from 'expo-router';
import {
  Button, Card, CategoryNav, ChevronDownIcon, Loader, ProductList, ProductTable, SearchInput, Text, type ProductTableColumn,
} from '@tallyui/components';
import { listCategories, type ProductSort } from '@tallyui/pos';
import { Image } from '@tallyui/primitives';
import { AreaAccountButton, FrameMenuButton, useFrameMenu } from '../components/app-frame';
import { CatalogueSyncButton } from '../components/catalogue-sync-button';
import { ProductsAreaColumnsButton } from '../components/products-area-columns-settings';
import { ProductsTagsChip } from '../components/products-tags-chip';
import { StripHeightContext } from '../components/store-refused';
import { StoreSettingsGate, type TillCatalogueLeafProps } from '../components/till-catalogue-gate';
import { catalogueStatus, publishCatalogue, sellableCatalogue, useCatalogueSnapshot, withdrawCatalogue } from '../lib/catalogue-snapshot';
import {
  filterProductAreaRows, filterProductAreaRowsByCategory, filterProductAreaRowsByTag, filterProductAreaRowsInStock,
  filterProductAreaRowsOnSale, listProductTags, loadProductsAreaCategory, loadProductsAreaTag, productAreaItems, productAreaPlaceItems, productAreaProducts,
  productAreaRows, productAreaStockLine, productTypeIds, PRODUCTS_ADMIN_NOTE, PRODUCTS_EMPTY, PRODUCTS_IN_STOCK_LABEL, PRODUCTS_LOADING, PRODUCTS_LOAD_FAILED, PRODUCTS_NO_MATCH,
  PRODUCTS_NONE_IN_STOCK, PRODUCTS_NONE_ON_SALE, PRODUCTS_NONE_ON_SALE_IN_STOCK, PRODUCTS_NONE_TAGGED, PRODUCTS_ON_SALE_LABEL,
  PRODUCTS_SHOWING, PRODUCTS_VARIATIONS, saveProductsAreaCategory, saveProductsAreaTag, STOCK_STATUS_DOTS, STOCK_STATUS_LABELS,
  type ProductAreaItem, type ProductAreaRow,
} from '../lib/products-area';
import { DEFAULT_PRODUCTS_AREA_COLUMNS, useProductsAreaColumns, type ProductsAreaColumn } from '../lib/products-area-columns';
import { useProductSettings } from '../lib/product-settings';
import { useProductTypes } from '../lib/product-types';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { playScanBeep } from '../lib/scan-beep';
import { useScannerSettings } from '../lib/scanner-settings';
import { useWedgeScan, useWedgeScanField } from '../lib/use-wedge-scan';

// The row's product thumbnail, or a plain tile of the same size when the product has none.
function ProductThumb({ row, size }: { row: Pick<ProductAreaRow, 'id' | 'name' | 'imageUrl'>; size: number }) {
  return row.imageUrl
    ? <Image.Root source={{ uri: row.imageUrl }} alt={row.name} contentFit="cover" className="rounded border border-border"
      style={{ width: size, height: size }} testID={`product-image-${row.id}`} />
    : <View className="rounded border border-border bg-muted" style={{ width: size, height: size }}
      testID={`product-image-placeholder-${row.id}`} />;
}

type ProductItem = Extract<ProductAreaItem, { kind: 'product' }>;
type VariantItem = Extract<ProductAreaItem, { kind: 'variant' }>;
// Opens or closes a product row's variation sub-rows; the screen provides it, the columns render outside the screen.
const ToggleVariations = createContext<(productId: string) => void>(() => {});
// v2's Open in place: the toggle opens the product in place instead, so it has no open state of its own.
const OpensInPlace = createContext(false);

// The Product sub-switches (SKU, Barcode, Attributes); the screen provides its settings, as ToggleVariations.
const ProductLines = createContext<Record<'productSku' | 'productBarcode' | 'productAttributes', boolean>>(DEFAULT_PRODUCTS_AREA_COLUMNS);

// A variant row's Product cell: its label, then a muted line per sub-switch that is on and has a value.
function VariantProductCell({ row }: { row: VariantItem }) {
  const on = useContext(ProductLines);
  const lines = [['sku', on.productSku, row.sku], ['barcode', on.productBarcode, row.barcode],
    ['attributes', on.productAttributes, row.attributes]] as const;
  return <View className={row.sub ? 'pl-6' : undefined}>
    <Text>{row.label}</Text>
    {lines.map(([line, shown, value]) => shown && value
      ? <Text key={line} className="text-sm text-muted-foreground" testID={`product-line-${line}-${row.id}`}>{value}</Text> : null)}
  </View>;
}

// v2's "15 variations ›": a plain text button under the product name; the chevron points right while closed, down while open.
// Open in place: no open state, the chevron always points right.
function VariationsToggle({ item }: { item: ProductItem }) {
  const toggle = useContext(ToggleVariations);
  const inPlace = useContext(OpensInPlace);
  const open = item.open && !inPlace;
  const text = PRODUCTS_VARIATIONS(item.shown, item.variants.length);
  return <Pressable role="button" aria-expanded={inPlace ? undefined : open} testID={`product-variations-${item.id}`}
    accessibilityLabel={`${text}, ${item.name}`} onPress={() => toggle(item.id)} className="flex-row items-center gap-1 self-start py-1">
    <Text className="text-sm">{text}</Text>
    <ChevronDownIcon size={14} style={open ? undefined : { transform: [{ rotate: '-90deg' }] }} />
  </Pressable>;
}

const COLUMNS: ProductTableColumn<ProductAreaItem>[] = [
  // v2's image column: no head label, not sortable.
  { id: 'image', header: 'Image', hideHeader: true, flex: 0.75, render: (row) => <ProductThumb row={row} size={40} /> },
  // The row's Medusa id (the variant's); long, so one line.
  { id: 'id', header: 'ID', flex: 2, sortValue: (row) => row.id, render: (row) => <Text numberOfLines={1}>{row.id}</Text> },
  // A product row: its name, its option lines and the variations toggle; a sub-row: the variant's title, indented.
  { id: 'name', header: 'Product', flex: 3, sortValue: (row) => row.kind === 'product' ? row.name : row.label, render: (row) =>
    row.kind === 'product' ? <View>
      <Text className="font-semibold">{row.name}</Text>
      {row.options.map((line) => <Text key={line} className="text-sm text-muted-foreground">{line}</Text>)}
      <VariationsToggle item={row} />
    </View> : <VariantProductCell row={row} /> },
  // The product's Medusa product type, on its product row and every variant row.
  { id: 'type', header: 'Type', flex: 1.5, sortValue: (row) => row.type,
    render: (row) => <Text numberOfLines={1} testID={`product-type-${row.id}`}>{row.type}</Text> },
  { id: 'sku', header: 'SKU', flex: 1.5, sortValue: (row) => row.sku, render: (row) => <Text>{row.sku}</Text> },
  { id: 'barcode', header: 'Barcode', flex: 1.5, sortValue: (row) => row.barcode, render: (row) => <Text>{row.barcode}</Text> },
  { id: 'stock', header: 'Stock', align: 'right', flex: 1, render: (row) => <Text className="tabular-nums">{row.stock}</Text> },
  { id: 'stockStatus', header: 'Stock status', flex: 1.5, sortValue: (row) => STOCK_STATUS_LABELS[row.stockStatus], render: (row) =>
    <View className="flex-row items-center gap-1.5" testID={`product-stock-status-${row.id}`}>
      <View className={`h-2 w-2 rounded-full ${STOCK_STATUS_DOTS[row.stockStatus]}`} />
      <Text className={row.stockStatus === 'unknown' ? 'text-muted-foreground' : undefined}>{STOCK_STATUS_LABELS[row.stockStatus]}</Text>
    </View> },
  { id: 'category', header: 'Category', flex: 1.5, sortValue: (row) => row.categories,
    render: (row) => <Text numberOfLines={1}>{row.categories}</Text> },
  { id: 'price', header: 'Price', align: 'right', flex: 1, render: (row) => <Text className="tabular-nums">{row.price}</Text> },
  // v2's Regular and Sale price: the regular price is greyed beside a sale price, as v2's demo.
  { id: 'regularPrice', header: 'Regular price', align: 'right', flex: 1, render: (row) =>
    <Text className={`tabular-nums${row.onSale ? ' text-muted-foreground' : ''}`}
      testID={`product-regular-price-${row.id}`}>{row.regularPrice}</Text> },
  { id: 'salePrice', header: 'Sale price', align: 'right', flex: 1, render: (row) =>
    <Text className="tabular-nums" testID={`product-sale-price-${row.id}`}>{row.salePrice}</Text> },
];

// ADR 0009: phone mode below 600 px.
const PHONE_BREAKPOINT = 600;
// The table's default order, so both layouts list rows alike.
const NAME_SORT = { field: 'name', dir: 'asc' } as const;

// The phone row's right side: the price over the stock line.
function PhonePriceStock({ row }: { row: Pick<ProductAreaRow, 'id' | 'price' | 'stock' | 'stockStatus'> }) {
  return <View className="items-end">
    <Text className="tabular-nums">{row.price}</Text>
    <View className="flex-row items-center gap-1.5" testID={`product-stock-status-${row.id}`}>
      <View className={`h-2 w-2 rounded-full ${STOCK_STATUS_DOTS[row.stockStatus]}`} />
      <Text className={`text-sm${row.stockStatus === 'unknown' ? ' text-muted-foreground' : ''}`}>{productAreaStockLine(row)}</Text>
    </View>
  </View>;
}

// v2's phone row: the thumbnail while Image is on, name over SKU, price over the stock line. Rows open nothing, as the table's do;
// a variation sub-row is indented under its product row and shows the variant's title.
function PhoneRow({ row, image }: { row: VariantItem; image: boolean }) {
  return <View className={`flex-row gap-3 px-4 py-3${row.sub ? ' pl-8' : ''}`} testID={`product-list-row-${row.id}`}>
    {image ? <ProductThumb row={row} size={40} /> : null}
    <View className="min-w-0 flex-1">
      <Text>{row.label}</Text>
      {row.sku ? <Text className="text-sm text-muted-foreground">{row.sku}</Text> : null}
    </View>
    <PhonePriceStock row={row} />
  </View>;
}

// v2's phone product row: the name with the variations toggle under it, the price range over the stock line.
function PhoneProductRow({ item, image }: { item: ProductItem; image: boolean }) {
  return <View className="flex-row gap-3 px-4 py-3" testID={`product-list-row-${item.id}`}>
    {image ? <ProductThumb row={item} size={40} /> : null}
    <View className="min-w-0 flex-1">
      <Text>{item.name}</Text>
      <VariationsToggle item={item} />
    </View>
    <PhonePriceStock row={item} />
  </View>;
}

// A column's sort value for an item, as the table reads it.
const valueOf = (item: ProductAreaItem, field: string) => COLUMNS.find((column) => column.id === field)?.sortValue?.(item);

// The area's own catalogue read, while no Sale holds one: the Sale's replication over the same cache, read-only.
// It publishes what it reads and renders nothing.
function ProductsCatalogue({ session, connector, syncContext, onUnauthorized, pricing, retry }: TillCatalogueLeafProps & { retry: () => void }) {
  const { products, state, error, stockOverlay, syncNow, clearAndRefresh } = useReplicatedProducts(connector, syncContext, onUnauthorized);
  const catalogue = useMemo(() => sellableCatalogue(products, connector, stockOverlay), [products, connector, stockOverlay]);
  const status = catalogueStatus(products.length, state);
  const syncing = state === 'syncing' || state === 'connecting';
  useEffect(() => {
    publishCatalogue({ owner: 'products', baseUrl: session.baseUrl, products: catalogue, traits: connector.traits.product,
      currency: pricing.currency, status, error: error ?? undefined, retry, sync: syncNow, clearAndRefresh, syncing });
  }, [session.baseUrl, catalogue, connector, pricing.currency, status, error, retry, syncNow, clearAndRefresh, syncing]);
  useEffect(() => () => withdrawCatalogue('products'), []);
  return null;
}

// v2's Products area, read-only: the Sale's catalogue when the Sale holds one, else its own read of the same cache;
// editing happens in Medusa Admin.
export default function ProductsAreaScreen() {
  const { session, signOut, reportUnauthorized, reportNoPosAccess, mergeCapabilities } = useSession();
  const snapshot = useCatalogueSnapshot();
  const [search, setSearch] = useState('');
  // v2: "On the Products and Orders screens, a scan goes into that screen's search box": a scan typed into the box,
  // or with nothing editable focused, becomes the search text without its prefix and suffix. It never touches a cart.
  const { settings: scannerSettings } = useScannerSettings(defaultStorage(), session?.baseUrl ?? '');
  const onScan = (code: string) => {
    if (scannerSettings.playSound) playScanBeep();
    setSearch(code);
  };
  const onSearchKeyPress = useWedgeScanField(scannerSettings, onScan);
  useWedgeScan(usePathname() === '/products', scannerSettings, onScan);
  const [categoryId, setCategoryId] = useState<string | null>(() =>
    session ? loadProductsAreaCategory(defaultStorage(), session.baseUrl) : null);
  const [tagId, setTagId] = useState<string | null>(() => session ? loadProductsAreaTag(defaultStorage(), session.baseUrl) : null);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [onSaleOnly, setOnSaleOnly] = useState(false);
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
  // The product types are read from Medusa only while the Type column shows; the hook reads again only when the ids change.
  const typeIds = useMemo(() => ready ? productTypeIds(ready.products) : [], [ready]);
  const types = useProductTypes(session, typeIds, columns.settings.type);
  const rows = useMemo(() => ready ? productAreaRows(ready.products, ready.traits, ready.currency, types) : [], [ready, types]);
  const products = useMemo(() => ready ? productAreaProducts(ready.products, ready.traits, ready.currency, types) : [], [ready, types]);
  const categories = useMemo(() => ready ? listCategories(ready.products, ready.traits) : [], [ready]);
  // A chosen category no longer in the catalogue counts as All, as the Sale's chips do.
  const activeId = categoryId !== null && categories.some((category) => category.id === categoryId) ? categoryId : null;
  const tags = useMemo(() => ready ? listProductTags(ready.products) : [], [ready]);
  // A chosen tag no longer in the catalogue counts as none, as the category does.
  const activeTag = tags.find((tag) => tag.id === tagId) ?? null;
  const activeTagId = activeTag?.id ?? null;
  const items = useMemo(() => filterProductAreaRows(filterProductAreaRowsOnSale(filterProductAreaRowsInStock(
    filterProductAreaRowsByTag(filterProductAreaRowsByCategory(rows, activeId), activeTagId), inStockOnly), onSaleOnly), search),
  [rows, activeId, activeTagId, inStockOnly, onSaleOnly, search]);
  // v2's Variations choice is the Sale's own setting: 'list' opens a product in place, 'popover' is Expanded rows here.
  const { settings: productSettings, save: saveProductSettings } = useProductSettings(defaultStorage(), session?.baseUrl ?? '');
  const inPlace = productSettings.variations === 'list';
  // The product open in place, for this visit only; one gone from the catalogue shows the list again.
  const [placeId, setPlaceId] = useState<string | null>(null);
  const place = useMemo(() => inPlace && placeId ? products.find((product) => product.id === placeId) ?? null : null,
    [inPlace, placeId, products]);
  // A product row opens on an explicit choice (Expanded rows only), else while the search has text (a typed or scanned SKU
  // shows its sub-row); otherwise it starts closed, as v2's. Kept for this visit only.
  const [openChoices, setOpenChoices] = useState<Record<string, boolean>>({});
  const searching = search.trim() !== '';
  const isOpen = useCallback((id: string) => (inPlace ? undefined : openChoices[id]) ?? searching, [inPlace, openChoices, searching]);
  const toggleVariations = useCallback((id: string) => inPlace ? setPlaceId(id)
    : setOpenChoices((choices) => ({ ...choices, [id]: !isOpen(id) })), [inPlace, isOpen]);
  const [sort, setSort] = useState<ProductSort | null>(NAME_SORT);
  const phone = useWindowDimensions().width < PHONE_BREAKPOINT;
  const phoneItems = useMemo(() => !phone ? [] : place ? productAreaPlaceItems(items, place, NAME_SORT, valueOf)
    : productAreaItems(items, products, NAME_SORT, isOpen, valueOf), [phone, place, items, products, isOpen]);
  const tableItems = useMemo(() => phone ? [] : place ? productAreaPlaceItems(items, place, sort, valueOf)
    : productAreaItems(items, products, sort, isOpen, valueOf), [phone, place, items, products, sort, isOpen]);
  // v2's Products has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  if (!session) return <Redirect href="/login" />;
  // One cache per store and pricing context: the area reads only while the Sale holds no catalogue for this store.
  const saleHolds = loaded?.owner === 'sale';
  // Clear and Refresh empties the search and the In stock and On sale chips too, as the Sale's does; the kept category and tag stay.
  const clearAndRefresh = () => {
    ready?.clearAndRefresh?.();
    setSearch('');
    setInStockOnly(false);
    setOnSaleOnly(false);
  };
  const emptyState = <Text className="text-center text-muted-foreground">{search.trim() ? PRODUCTS_NO_MATCH(search)
    : activeTag ? PRODUCTS_NONE_TAGGED(activeTag.value) : onSaleOnly ? (inStockOnly ? PRODUCTS_NONE_ON_SALE_IN_STOCK : PRODUCTS_NONE_ON_SALE)
      : inStockOnly ? PRODUCTS_NONE_IN_STOCK : PRODUCTS_EMPTY}</Text>;
  return <ToggleVariations.Provider value={toggleVariations}><OpensInPlace.Provider value={inPlace}><ProductLines.Provider value={columns.settings}>
  <View className="flex-1 bg-background" role="main" aria-label="Products">
    <Stack.Screen options={{ title: 'Products', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
    <View className="flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: 16 + topInset }}>
      <SearchInput className="flex-1" value={search} onChangeText={setSearch} onKeyPress={onSearchKeyPress} placeholder="Search Products"
        accessibilityLabel="Search Products" testID="products-search" />
      {!phone && <ProductsAreaColumnsButton {...columns} variations={productSettings.variations} onVariationsChange={(variations) => {
        setPlaceId(null);
        saveProductSettings({ ...productSettings, variations });
      }} />}
      {!openMenu && <AreaAccountButton />}
    </View>
    {/* In stock and On sale lead, as in v2's chip row, Tags last; the category and tag are kept per store, neither chip is. */}
    {ready ? <View className="flex-row items-center pl-4">
      <View className="flex-row gap-2 py-2">
        <Pressable testID="products-in-stock" role="button" aria-pressed={inStockOnly} accessibilityLabel={PRODUCTS_IN_STOCK_LABEL}
          onPress={() => setInStockOnly((on) => !on)} className={`rounded-md px-3 py-1.5 ${inStockOnly ? 'bg-primary' : 'bg-muted'}`}>
          <Text className={`text-sm font-medium ${inStockOnly ? 'text-primary-foreground' : 'text-foreground'}`}>
            {PRODUCTS_IN_STOCK_LABEL}
          </Text>
        </Pressable>
        <Pressable testID="products-on-sale" role="button" aria-pressed={onSaleOnly} accessibilityLabel={PRODUCTS_ON_SALE_LABEL}
          onPress={() => setOnSaleOnly((on) => !on)} className={`rounded-md px-3 py-1.5 ${onSaleOnly ? 'bg-primary' : 'bg-muted'}`}>
          <Text className={`text-sm font-medium ${onSaleOnly ? 'text-primary-foreground' : 'text-foreground'}`}>
            {PRODUCTS_ON_SALE_LABEL}
          </Text>
        </Pressable>
      </View>
      {/* A style, not a class: react-native-web's ScrollView base style grows, and its atomic class beats Tailwind's grow-0. */}
      {categories.length ? <CategoryNav className="min-w-0" style={{ flexGrow: 0 }} testID="products-categories"
        categories={[{ id: '', name: 'All products' }, ...categories]} selectedId={activeId ?? ''}
        onSelect={(id) => {
          setCategoryId(id === '' ? null : id);
          saveProductsAreaCategory(defaultStorage(), session.baseUrl, id === '' ? null : id);
        }} /> : null}
      {tags.length ? <View className="shrink-0 py-2 pr-4 pl-2">
        <ProductsTagsChip tags={tags} selectedId={activeTagId} onSelect={(id) => {
          setTagId(id);
          saveProductsAreaTag(defaultStorage(), session.baseUrl, id);
        }} />
      </View> : null}
    </View> : null}
    <View className="px-4 pb-2">
      <Text className="text-sm text-muted-foreground" testID="products-admin-note">{PRODUCTS_ADMIN_NOTE}</Text>
    </View>
    {/* v2's Open in place: a Products back link, then the product's name; the search, chips and sort stay as they were. */}
    {ready && place ? <View className="flex-row items-center gap-1 px-4 pb-2" testID="products-place">
      <Pressable role="button" testID="products-place-back" onPress={() => setPlaceId(null)} className="py-1">
        <Text className="text-primary">Products</Text>
      </Pressable>
      <ChevronDownIcon size={14} style={{ transform: [{ rotate: '-90deg' }] }} />
      <Text className="font-semibold" testID="products-place-name">{place.name}</Text>
    </View> : null}
    {saleHolds ? null : <StoreSettingsGate key={session.baseUrl} session={session} signOut={signOut} onUnauthorized={reportUnauthorized}
      onNoPosAccess={reportNoPosAccess} onCapabilities={mergeCapabilities} Leaf={Leaf} />}
    {ready && phone ? <ProductList testID="products-list" items={phoneItems} emptyState={emptyState}
      renderItem={(item: ProductAreaItem) => item.kind === 'product' ? <PhoneProductRow item={item} image={columns.settings.image} />
        : <PhoneRow row={item} image={columns.settings.image} />} /> : null}
    {/* v2's table sits in a bordered box, inset as the search row; its phone rows run full width. */}
    {ready && !phone ? <Card testID="products-table-card" className="mx-4 flex-1 overflow-hidden">
      <ProductTable testID="products-table" items={tableItems} columns={tableColumns as ProductTableColumn[]}
        sort={sort} onSortChange={setSort} sortItems={false} emptyState={emptyState} />
    </Card> : null}
    {/* v2's "Showing n of m": rows after the search and chips, of the whole sellable catalogue; its sync arrow after it.
      n and m count variants (a product row and its sub-rows count as the sub-rows' variants), as v2 counts rows.
      In place: the product's variants left, of all its variants. */}
    {ready ? <View className="flex-row items-center justify-end gap-1 px-4 py-2" testID="products-footer">
      <Text className="text-sm text-muted-foreground tabular-nums">{place ? PRODUCTS_SHOWING((phone ? phoneItems : tableItems).length, place.variants.length)
        : PRODUCTS_SHOWING(items.length, rows.length)}</Text>
      {ready.sync && ready.clearAndRefresh
        ? <CatalogueSyncButton onSync={ready.sync} onClearAndRefresh={clearAndRefresh} syncing={!!ready.syncing} /> : null}
    </View> : null}
    {loaded?.status === 'loading' ? <View className="flex-1 items-center justify-center gap-3 px-4" testID="products-loading">
      <Loader />
      <Text className="text-center text-muted-foreground">{PRODUCTS_LOADING}</Text>
    </View> : null}
    {loaded?.status === 'error' ? <View className="flex-1 items-center justify-center gap-4 px-4">
      <Text className="text-center text-destructive" testID="products-error">{loaded.error ?? PRODUCTS_LOAD_FAILED}</Text>
      {loaded.retry ? <Button variant="outline" testID="products-retry" onPress={loaded.retry}><Text>Retry</Text></Button> : null}
    </View> : null}
  </View></ProductLines.Provider></OpensInPlace.Provider></ToggleVariations.Provider>;
}

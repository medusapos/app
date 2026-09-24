import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getCalendars } from 'expo-localization';
import type { ProductTraits } from '@tallyui/core';
import { ProductCard, ProductGrid, SearchInput } from '@tallyui/components';
import { searchProducts } from '@tallyui/pos';
import { catalogueEntries, findEntryByCode, variantPriceLabel, type CatalogueEntry } from '../lib/catalogue';

// Keep product names readable and touch targets at least 160 px wide where two columns fit.
const MIN_TILE_WIDTH = 160;
const STOCK_LABEL = {
  in_stock: 'In Stock', out_of_stock: 'Out of Stock', backorder: 'On Backorder', unknown: 'Unknown',
};

// locale/hour12 are injected (rather than read from the device inside this function) so the
// formatting is testable without the device; callers default them to the device's own settings.
export function formatStockSyncTime(time: Date, locale?: string, hour12?: boolean): string {
  return time.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12 });
}

export function Catalogue<Doc>({ products, traits, currency, onSelect, statusText, lastSyncedAt, lastStockCheckAt }: {
  products: Doc[];
  traits: ProductTraits<Doc>;
  currency: string;
  onSelect: (entry: CatalogueEntry<Doc>) => void;
  statusText?: string;
  lastSyncedAt: Date | null;
  /** The last completed stock reconcile pass this session, which beats the catalogue sync. */
  lastStockCheckAt?: Date | null;
}) {
  const stockAsOf = lastStockCheckAt ?? lastSyncedAt;
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<CatalogueEntry<Doc>[]>([]);
  const [width, setWidth] = useState(0);
  // Web has no 12/24-hour API and reports none; keep the locale default in that case.
  const clockPreference = getCalendars()[0]?.uses24hourClock;
  const hour12 = clockPreference == null ? undefined : !clockPreference;
  // ProductGrid has 4 px padding on each side of the content and each cell.
  const columns = Math.max(2, Math.min(6, Math.floor((width - 8) / (MIN_TILE_WIDTH + 8))));
  const entries = useMemo(() => catalogueEntries(products, traits), [products, traits]);
  const results = useMemo(() => searchProducts(products, query, traits), [products, query, traits]);

  function select(entry: CatalogueEntry<Doc>) {
    onSelect(entry);
    setChoices([]);
  }

  return (
    <View className="flex-1" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View className="gap-2 border-b border-border bg-card px-4 pb-3 pt-3">
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search or scan barcode / SKU" autoFocus
          onSubmitEditing={() => {
            const entry = findEntryByCode(entries, query);
            if (entry) { select(entry); setQuery(''); }
          }} />
        {statusText ? <Text className="text-xs text-muted-foreground">
          {statusText}{query.trim() ? ` · ${results.length.toLocaleString()} matching` : ''}
        </Text> : null}
        {choices.length > 0 ? (
          <View accessibilityLabel="Choose variant" className="gap-2">
            {choices.map((entry) => (
              <Pressable key={entry.variant.id} accessibilityRole="button" onPress={() => select(entry)}
                className="gap-1 rounded-md border border-border p-3">
                <Text className="font-semibold text-foreground">{entry.variant.title}</Text>
                <Text className="text-muted-foreground">{entry.variant.sku}</Text>
                <Text className="text-foreground">{variantPriceLabel(entry.variant, currency)}</Text>
                <Text className="text-muted-foreground">{STOCK_LABEL[entry.variant.stock.status]} · {stockAsOf ? `as of ${formatStockSyncTime(stockAsOf, undefined, hour12)}` : 'not yet synced'}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setChoices([])} className="rounded-md border border-border bg-card px-4 py-3">
              <Text className="text-center text-foreground">Cancel</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <ProductGrid items={results} numColumns={columns}
        renderItem={(product: Doc) => (
          <ProductCard doc={product} onPress={() => {
            const variants = entries.filter((entry) => entry.product === product);
            if (variants.length === 1) select(variants[0]);
            else setChoices(variants);
          }} />
        )}
        emptyState={<Text className="mt-10 text-center text-sm text-muted-foreground">
          {query.trim() ? `No products match "${query.trim()}".` : 'No products yet.'}
        </Text>} />
    </View>
  );
}

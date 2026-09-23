import { useMemo, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import type { ProductTraits } from '@tallyui/core';
import { ProductCard, ProductGrid, SearchInput } from '@tallyui/components';
import { searchProducts } from '@tallyui/pos';
import { catalogueEntries, findEntryByCode, variantPriceLabel, type CatalogueEntry } from '../lib/catalogue';

const STOCK_LABEL = {
  in_stock: 'In Stock', out_of_stock: 'Out of Stock', backorder: 'On Backorder', unknown: 'Unknown',
};

export function Catalogue<Doc>({ products, traits, currency, onSelect, statusText }: {
  products: Doc[];
  traits: ProductTraits<Doc>;
  currency: string;
  onSelect: (entry: CatalogueEntry<Doc>) => void;
  statusText?: string;
}) {
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<CatalogueEntry<Doc>[]>([]);
  const { width } = useWindowDimensions();
  const entries = useMemo(() => catalogueEntries(products, traits), [products, traits]);
  const results = useMemo(() => searchProducts(products, query, traits), [products, query, traits]);

  function select(entry: CatalogueEntry<Doc>) {
    onSelect(entry);
    setChoices([]);
  }

  return (
    <View className="flex-1">
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
                <Text className="text-muted-foreground">{STOCK_LABEL[entry.variant.stock.status]}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setChoices([])}>
              <Text className="text-foreground">Cancel</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <ProductGrid items={results} numColumns={width < 600 ? 2 : width < 1024 ? 4 : 6}
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

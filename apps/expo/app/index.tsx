import { useState, useRef, useMemo } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useProductTraits } from '@tallyui/core';
import {
  ProductGrid,
  ProductCard,
  SearchInput,
  FilterChipGroup,
  CartPanel,
  CartLine,
  CartTotal,
} from '@tallyui/components';
import type { CartLineItem, ChipItem } from '@tallyui/components';
import { useCurrencyFormatter } from '@tallyui/pos';
import { useProducts } from '../lib/hooks/use-products';
import { useOrderBuilder, useOrder } from '../lib/hooks/use-order-builder';

export default function POSScreen() {
  const router = useRouter();
  const traits = useProductTraits();
  const builder = useOrderBuilder();
  const order = useOrder();
  const formatMoney = useCurrencyFormatter();
  const docMap = useRef<Map<string, any>>(new Map());

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const allProducts = useProducts(search || undefined);

  // Filter by category
  const products = activeCategory
    ? allProducts.filter((doc) =>
        traits.getCategoryNames(doc).includes(activeCategory)
      )
    : allProducts;

  // Build category chips from all products
  const categoryChips: ChipItem[] = useMemo(() => {
    const cats = new Set<string>();
    allProducts.forEach((doc) => {
      traits.getCategoryNames(doc).forEach((c) => cats.add(c));
    });
    return [
      { id: 'all', label: 'All', active: !activeCategory },
      ...Array.from(cats).map((c) => ({
        id: c,
        label: c,
        active: activeCategory === c,
      })),
    ];
  }, [allProducts, activeCategory, traits]);

  // Map order line items to CartLineItems
  const cartItems: CartLineItem[] = order.lineItems
    .map((item) => {
      const doc = docMap.current.get(item.productId);
      return doc ? { doc, quantity: item.quantity } : null;
    })
    .filter(Boolean) as CartLineItem[];

  function handleAddProduct(doc: any) {
    const id = traits.getId(doc);
    docMap.current.set(id, doc);
    builder.addProduct(doc, traits);
  }

  function handleChipPress(chip: ChipItem) {
    setActiveCategory(chip.id === 'all' ? null : chip.id);
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: '#f8f9fa' }}>
      {/* Left: Product Grid */}
      <View style={{ flex: 1, borderRightWidth: 1, borderRightColor: '#e5e7eb' }}>
        <ProductGrid
          items={products}
          numColumns={3}
          searchSlot={
            <SearchInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search products..."
            />
          }
          filterSlot={
            <FilterChipGroup chips={categoryChips} onChipPress={handleChipPress} />
          }
          renderItem={(doc) => (
            <ProductCard doc={doc} onPress={() => handleAddProduct(doc)} />
          )}
          emptyState={
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={{ color: '#6b7280' }}>No products found</Text>
            </View>
          }
        />
      </View>

      {/* Right: Cart */}
      <View style={{ width: 360 }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 16,
            borderBottomWidth: 1,
            borderBottomColor: '#e5e7eb',
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: 'bold' }}>Cart</Text>
          <Pressable onPress={() => router.push('/orders')}>
            <Text style={{ color: '#6366f1', fontWeight: '600' }}>Orders</Text>
          </Pressable>
        </View>
        <CartPanel
          items={cartItems}
          renderItem={(item) => <CartLine item={item} />}
          footer={
            <View style={{ padding: 16 }}>
              <CartTotal items={cartItems} taxRate={0.1} />
              <Pressable
                onPress={() => router.push('/checkout')}
                disabled={order.lineItems.length === 0}
                style={{
                  marginTop: 12,
                  backgroundColor:
                    order.lineItems.length === 0 ? '#d1d5db' : '#6366f1',
                  paddingVertical: 14,
                  borderRadius: 8,
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{ color: '#fff', fontWeight: 'bold', fontSize: 16 }}
                >
                  Checkout — {formatMoney(order.total)}
                </Text>
              </Pressable>
            </View>
          }
          emptyState={
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 40,
              }}
            >
              <Text style={{ color: '#6b7280' }}>Tap a product to add it</Text>
            </View>
          }
        />
      </View>
    </View>
  );
}

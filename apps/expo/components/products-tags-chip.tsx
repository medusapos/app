import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Popover, PopoverContent, PopoverTrigger, SearchInput, Text, XIcon } from '@tallyui/components';
import {
  PRODUCTS_COLLECTIONS_LABEL, PRODUCTS_COLLECTIONS_NONE, PRODUCTS_COLLECTIONS_SEARCH, PRODUCTS_TAGS_LABEL, PRODUCTS_TAGS_NONE,
  PRODUCTS_TAGS_SEARCH, type ProductTag,
} from '../lib/products-area';

// The chip's words and testID stems (`<id>`, `<id>-menu`, `<id>-search`, `<id>-remove`, `<item>-<entry id>`).
const TAGS_COPY = { id: 'products-tags', item: 'products-tag', label: PRODUCTS_TAGS_LABEL, chosen: 'Tag',
  remove: 'Remove tag', search: PRODUCTS_TAGS_SEARCH, none: PRODUCTS_TAGS_NONE };
// The Collections chip: the same chip over the catalogue's Medusa product collections.
export const PRODUCTS_COLLECTIONS_COPY: typeof TAGS_COPY = { id: 'products-collections', item: 'products-collection',
  label: PRODUCTS_COLLECTIONS_LABEL, chosen: 'Collection', remove: 'Remove collection', search: PRODUCTS_COLLECTIONS_SEARCH,
  none: PRODUCTS_COLLECTIONS_NONE };

// v2's Tags pill: a list of the catalogue's tags with a search box; one tag at a time, its value on the chip with a cross.
export function ProductsTagsChip({ tags, selectedId, onSelect, copy = TAGS_COPY }: {
  tags: ProductTag[]; selectedId: string | null; onSelect: (id: string | null) => void; copy?: typeof TAGS_COPY;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = tags.find((tag) => tag.id === selectedId) ?? null;
  // The search starts empty each time the list opens.
  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch('');
  };
  const query = search.trim().toLowerCase();
  const shown = query ? tags.filter((tag) => tag.value.toLowerCase().includes(query)) : tags;
  return <View className={`flex-row items-center gap-1.5 rounded-md px-3 py-1.5 ${selected ? 'bg-primary' : 'bg-muted'}`}>
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <Pressable testID={copy.id} role="button"
          accessibilityLabel={selected ? `${copy.chosen}: ${selected.value}` : copy.label}>
          <Text className={`text-sm font-medium ${selected ? 'text-primary-foreground' : 'text-foreground'}`}>
            {selected?.value ?? copy.label}
          </Text>
        </Pressable>
      </PopoverTrigger>
      <PopoverContent testID={`${copy.id}-menu`} align="start" className="gap-2 p-2" style={{ width: 240 }}>
        <SearchInput value={search} onChangeText={setSearch} placeholder={copy.search}
          accessibilityLabel={copy.search} testID={`${copy.id}-search`} />
        <ScrollView style={{ maxHeight: 280 }} keyboardShouldPersistTaps="handled">
          {shown.length ? shown.map((tag) => <Pressable key={tag.id} testID={`${copy.item}-${tag.id}`} role="radio"
            aria-checked={tag.id === selected?.id} className={`rounded-md px-2 py-2 ${tag.id === selected?.id ? 'bg-accent' : ''}`}
            onPress={() => {
              onSelect(tag.id);
              openChange(false);
            }}>
            <Text className="text-sm text-popover-foreground">{tag.value}</Text>
          </Pressable>) : <Text className="px-2 py-2 text-sm text-muted-foreground">{copy.none}</Text>}
        </ScrollView>
      </PopoverContent>
    </Popover>
    {selected ? <Pressable testID={`${copy.id}-remove`} role="button" accessibilityLabel={copy.remove} hitSlop={8}
      className="text-primary-foreground" onPress={() => onSelect(null)}>
      <XIcon size={14} />
    </Pressable> : null}
  </View>;
}

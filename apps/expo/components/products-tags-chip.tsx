import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Popover, PopoverContent, PopoverTrigger, SearchInput, Text, XIcon } from '@tallyui/components';
import { PRODUCTS_TAGS_LABEL, PRODUCTS_TAGS_NONE, PRODUCTS_TAGS_SEARCH, type ProductTag } from '../lib/products-area';

// v2's Tags pill: a list of the catalogue's tags with a search box; one tag at a time, its value on the chip with a cross.
export function ProductsTagsChip({ tags, selectedId, onSelect }: {
  tags: ProductTag[]; selectedId: string | null; onSelect: (id: string | null) => void;
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
        <Pressable testID="products-tags" role="button"
          accessibilityLabel={selected ? `Tag: ${selected.value}` : PRODUCTS_TAGS_LABEL}>
          <Text className={`text-sm font-medium ${selected ? 'text-primary-foreground' : 'text-foreground'}`}>
            {selected?.value ?? PRODUCTS_TAGS_LABEL}
          </Text>
        </Pressable>
      </PopoverTrigger>
      <PopoverContent testID="products-tags-menu" align="start" className="gap-2 p-2" style={{ width: 240 }}>
        <SearchInput value={search} onChangeText={setSearch} placeholder={PRODUCTS_TAGS_SEARCH}
          accessibilityLabel={PRODUCTS_TAGS_SEARCH} testID="products-tags-search" />
        <ScrollView style={{ maxHeight: 280 }} keyboardShouldPersistTaps="handled">
          {shown.length ? shown.map((tag) => <Pressable key={tag.id} testID={`products-tag-${tag.id}`} role="radio"
            aria-checked={tag.id === selected?.id} className={`rounded-md px-2 py-2 ${tag.id === selected?.id ? 'bg-accent' : ''}`}
            onPress={() => {
              onSelect(tag.id);
              openChange(false);
            }}>
            <Text className="text-sm text-popover-foreground">{tag.value}</Text>
          </Pressable>) : <Text className="px-2 py-2 text-sm text-muted-foreground">{PRODUCTS_TAGS_NONE}</Text>}
        </ScrollView>
      </PopoverContent>
    </Popover>
    {selected ? <Pressable testID="products-tags-remove" role="button" accessibilityLabel="Remove tag" hitSlop={8}
      className="text-primary-foreground" onPress={() => onSelect(null)}>
      <XIcon size={14} />
    </Pressable> : null}
  </View>;
}

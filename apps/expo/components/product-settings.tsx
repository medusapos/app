import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Circle, Line } from 'react-native-svg';
import { Button, createSvgIcon, Dialog, DialogContent, DialogTitle, IconButton, Label, Switch, Text } from '@tallyui/components';
import { DEFAULT_CATALOGUE_VIEW_STATE, PRODUCT_SORT_FIELDS, type CatalogueViewState } from '@tallyui/pos';
import type { useProductSettings } from '../lib/product-settings';
import { DEFAULT_CATALOGUE_SORT } from '../lib/catalogue-view';

const SlidersIcon = createSvgIcon('SlidersIcon', () => <>
  <Line x1={3} y1={6} x2={21} y2={6} /><Circle cx={8} cy={6} r={2} />
  <Line x1={3} y1={12} x2={21} y2={12} /><Circle cx={16} cy={12} r={2} />
  <Line x1={3} y1={18} x2={21} y2={18} /><Circle cx={8} cy={18} r={2} />
</>);

export function ProductSettingsButton({ viewState, onViewStateChange, showOutOfStock, onShowOutOfStockChange,
  settings, save, reset, phone }: ReturnType<typeof useProductSettings> & {
  viewState: CatalogueViewState; onViewStateChange: (state: CatalogueViewState) => void;
  showOutOfStock: boolean; onShowOutOfStockChange: (show: boolean) => void; phone: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <IconButton testID="product-settings-button" accessibilityLabel="Product settings" onPress={() => setOpen(true)}><SlidersIcon /></IconButton>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent side="right" testID="product-settings-sheet" className="flex-col gap-4">
        <DialogTitle>Product settings</DialogTitle>
        <ScrollView className="flex-1" contentContainerClassName="gap-4">
          {!phone && <>
            <Text>View Mode</Text>
            <View className="flex-row gap-2">
              {(['grid', 'table'] as const).map((view) => {
                const selected = viewState.view === view;
                return <Pressable key={view} testID={`product-settings-view-${view}`} accessibilityRole="button"
                  accessibilityState={{ selected }} aria-selected={selected} onPress={() => onViewStateChange({ ...viewState, view })}
                  className={`min-h-11 flex-1 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
                  <Text>{view === 'grid' ? 'Grid' : 'Table'}</Text>
                </Pressable>;
              })}
            </View>
          </>}
          <Text>Tile Size</Text>
          <View className="flex-row flex-wrap gap-2">
            {(['auto', 2, 3, 4, 5, 6, 7, 8] as const).map((gridColumns) => {
              const selected = viewState.gridColumns === gridColumns;
              return <Pressable key={gridColumns} testID={`product-settings-columns-${gridColumns}`} accessibilityRole="button"
                accessibilityState={{ selected }} aria-selected={selected} onPress={() => onViewStateChange({ ...viewState, gridColumns })}
                className={`min-h-11 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
                <Text>{gridColumns === 'auto' ? 'Auto' : gridColumns}</Text>
              </Pressable>;
            })}
          </View>
          <View className="flex-row items-center justify-between gap-2">
            <Label nativeID="product-settings-out-of-stock-label">Show out-of-stock products</Label>
            <Switch testID="product-settings-out-of-stock" aria-labelledby="product-settings-out-of-stock-label"
              checked={showOutOfStock} onCheckedChange={onShowOutOfStockChange} />
          </View>
          <Text>Sort By</Text>
          <View className="flex-row flex-wrap gap-2">
            {PRODUCT_SORT_FIELDS.map((field) => {
              const selected = viewState.sort?.field === field;
              return <Pressable key={field} testID={`product-settings-sort-${field}`} accessibilityRole="button"
                accessibilityState={{ selected }} aria-selected={selected}
                onPress={() => onViewStateChange({ ...viewState, sort: { field, dir: viewState.sort?.dir ?? 'asc' } })}
                className={`min-h-11 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
                <Text>{{ name: 'Name', sku: 'SKU', barcode: 'Barcode', price: 'Price', stock: 'Stock', category: 'Category' }[field]}</Text>
              </Pressable>;
            })}
          </View>
          <Text>Sort Direction</Text>
          <View className="flex-row gap-2">
            {(['asc', 'desc'] as const).map((dir) => {
              const selected = viewState.sort?.dir === dir;
              return <Pressable key={dir} testID={`product-settings-sort-${dir}`} accessibilityRole="button"
                accessibilityState={{ selected }} aria-selected={selected}
                onPress={() => onViewStateChange({ ...viewState, sort: { field: viewState.sort?.field ?? 'name', dir } })}
                className={`min-h-11 flex-1 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
                <Text>{dir === 'asc' ? 'Ascending' : 'Descending'}</Text>
              </Pressable>;
            })}
          </View>
          <Text>Variations</Text>
          <View className="flex-row gap-2">
            {(['list', 'popover'] as const).map((variations) => {
              const selected = settings.variations === variations;
              return <Pressable key={variations} testID={`product-settings-variations-${variations}`} accessibilityRole="button"
                accessibilityState={{ selected }} aria-selected={selected} onPress={() => save({ variations })}
                className={`min-h-11 flex-1 items-center justify-center rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
                <Text>{variations === 'list' ? 'Open in place' : 'Popover'}</Text>
              </Pressable>;
            })}
          </View>
        </ScrollView>
        <View className="mt-auto flex-row gap-2">
          <Button variant="outline" testID="product-settings-restore" onPress={() => {
            onViewStateChange({ ...DEFAULT_CATALOGUE_VIEW_STATE, sort: DEFAULT_CATALOGUE_SORT, categoryId: viewState.categoryId, ...(phone ? { view: 'grid' } : {}) });
            onShowOutOfStockChange(true); reset();
          }}><Text>Restore Default Settings</Text></Button>
          <Button testID="product-settings-close" onPress={() => setOpen(false)}><Text>Close</Text></Button>
        </View>
      </DialogContent>
    </Dialog>
  </>;
}

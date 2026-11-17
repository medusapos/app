import { useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { AppText as Text } from './app-text';
import { Circle, Line, Path, Rect } from 'react-native-svg';
import { createSvgIcon } from '@tallyui/components';
import type { ThemeChoice } from '../lib/theme-choice';

// v2's order and names (Settings > Theme), as the Tally Woo app shows them.
export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'System', light: 'Light', dark: 'Dark', ocean: 'Ocean', sunset: 'Sunset', monochrome: 'Monochrome',
  paper: 'Paper till', warm: 'Warm shop', bold: 'Bold money', market: 'Market stall',
};

// v2's tile grid: tiles at least 128px wide with an 8px gap (the grid's gap-2), two to five columns.
const themeColumns = (width: number) => Math.max(2, Math.min(5, Math.floor((width + 8) / (128 + 8))));

// v2's one-line description under each tile's name.
export const THEME_DESCRIPTIONS: Record<ThemeChoice, string> = {
  system: 'Follow your device settings', light: 'Clean and bright', dark: 'Easy on the eyes', ocean: 'Cool blues and teals',
  sunset: 'Warm oranges and purples', monochrome: 'High contrast grayscale', paper: 'Cream paper and ink',
  warm: 'Warm neutrals and terracotta', bold: 'Black, white and lime', market: 'Coral, ink and pastel tiles',
};

// v2's tile icons, drawn here as outline glyphs on a 24-unit grid in the current text colour.
const paths = (name: string, ds: string[]) => createSvgIcon(name, () => <>{ds.map((d) => <Path key={d} d={d} />)}</>);
const THEME_ICONS: Record<ThemeChoice, ReturnType<typeof createSvgIcon>> = {
  system: createSvgIcon('MonitorIcon', () => <>
    <Rect x={2} y={3} width={20} height={14} rx={2} /><Line x1={8} y1={21} x2={16} y2={21} /><Line x1={12} y1={17} x2={12} y2={21} />
  </>),
  light: createSvgIcon('SunIcon', () => <>
    <Circle cx={12} cy={12} r={4} />
    <Path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </>),
  dark: paths('MoonIcon', ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z']),
  ocean: paths('WavesIcon', [6, 12, 18].map((y) => `M2 ${y}c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2c1.3 0 1.9.5 2.5 1`)),
  sunset: paths('SunsetIcon', ['M12 10V2', 'M16 6l-4 4-4-4', 'M4.93 10.93l1.41 1.41', 'M19.07 10.93l-1.41 1.41',
    'M2 18h2', 'M20 18h2', 'M16 18a4 4 0 0 0-8 0', 'M22 22H2']),
  monochrome: createSvgIcon('ContrastIcon', () => <>
    <Circle cx={12} cy={12} r={10} /><Path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor" />
  </>),
  paper: paths('ReceiptIcon', ['M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z', 'M8 8h8', 'M8 12h8', 'M8 16h5']),
  warm: paths('StoreIcon', ['M3 3h18l1 5H2Z', 'M4 8v13h16V8', 'M10 21v-6h4v6']),
  bold: createSvgIcon('BanknoteIcon', () => <>
    <Rect x={2} y={6} width={20} height={12} rx={2} /><Circle cx={12} cy={12} r={2} /><Path d="M6 12h.01M18 12h.01" />
  </>),
  market: paths('ShoppingBasketIcon', ['M2 11h20', 'M5 11l4-7', 'M19 11l-4-7', 'M9 11l1 9', 'M15 11l-1 9', 'M4.5 15.5h15',
    'M3.5 11l1.6 7.4a2 2 0 0 0 2 1.6h9.8a2 2 0 0 0 2-1.6l1.7-7.4']),
};

export function ThemeTiles({ choice, onChoose, choices }: {
  choice: ThemeChoice; onChoose: (choice: ThemeChoice) => void; choices: readonly ThemeChoice[];
}) {
  const windowSize = useWindowDimensions();
  // The grid's own width once laid out; the window width until then.
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  const columns = themeColumns(gridWidth ?? windowSize.width);
  const rows: ThemeChoice[][] = [];
  for (let start = 0; start < choices.length; start += columns) rows.push(choices.slice(start, start + columns));
  return <View testID="settings-theme-choice" className="w-full gap-2"
    onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}>
    {rows.map((row) => <View key={row[0]} className="flex-row gap-2">
      {row.map((name) => {
        const selected = name === choice, Icon = THEME_ICONS[name];
        return <Pressable key={name} testID={`theme-tile-${name}`} accessibilityRole="button"
          accessibilityLabel={THEME_LABELS[name]} accessibilityState={{ selected }} aria-selected={selected} onPress={() => onChoose(name)}
          className={`min-h-16 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
          <View testID={`theme-icon-${name}`} className="text-foreground"><Icon size={16} /></View>
          <Text numberOfLines={2} className="text-center text-sm font-medium text-foreground">{THEME_LABELS[name]}</Text>
          <Text testID={`theme-description-${name}`} numberOfLines={2} className="text-center text-xs text-muted-foreground">{THEME_DESCRIPTIONS[name]}</Text>
        </Pressable>;
      })}
      {Array.from({ length: columns - row.length }, (_, pad) => <View key={`pad-${pad}`} className="min-w-0 flex-1" />)}
    </View>)}
  </View>;
}

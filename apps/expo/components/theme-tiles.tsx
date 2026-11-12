import { useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import type { ThemeChoice } from '../lib/theme-choice';

// v2's order and names (Settings > Theme), as the Tally Woo app shows them.
export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'System', light: 'Light', dark: 'Dark', ocean: 'Ocean', sunset: 'Sunset', monochrome: 'Monochrome',
  paper: 'Paper till', warm: 'Warm shop', bold: 'Bold money', market: 'Market stall',
};

// v2's tile grid: tiles at least 128px wide with an 8px gap (the grid's gap-2), two to five columns.
const themeColumns = (width: number) => Math.max(2, Math.min(5, Math.floor((width + 8) / (128 + 8))));

// Each theme's background, card, primary and foreground, for the swatch only: light and dark from
// @tallyui/theme tokens.css, the rest the sRGB of themes.css's oklch (React Native takes no oklch).
// Literal colours rather than Uniwind's ScopedTheme, which the unit tests cannot load; keep in step with themes.css.
const SWATCHES: Record<Exclude<ThemeChoice, 'system'>, readonly string[]> = {
  light: ['#f8f9fa', '#ffffff', '#5b5ef0', '#111827'],
  dark: ['#0d1117', '#161b22', '#818cf8', '#c9d1d9'],
  ocean: ['#04161f', '#0c2028', '#00c0c2', '#e0eeef'],
  sunset: ['#1d1120', '#281a2d', '#fd7933', '#faebe3'],
  monochrome: ['#0b0b0b', '#181818', '#e4e4e4', '#eeeeee'],
  paper: ['#f3ede2', '#fbf7ef', '#211b14', '#211b14'],
  warm: ['#f6f3ee', '#fffdfa', '#8a4b34', '#2a2420'],
  bold: ['#fafafa', '#ffffff', '#0a0a0a', '#0a0a0a'],
  market: ['#fffcf5', '#ffffff', '#ff5c38', '#1d1a2e'],
};

// System shows light's and dark's background and primary, side by side.
const swatchColours = (name: ThemeChoice) => name === 'system'
  ? [SWATCHES.light[0], SWATCHES.light[2], SWATCHES.dark[0], SWATCHES.dark[2]] : SWATCHES[name];

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
        const selected = name === choice;
        return <Pressable key={name} testID={`theme-tile-${name}`} accessibilityRole="button"
          accessibilityLabel={THEME_LABELS[name]} accessibilityState={{ selected }} aria-selected={selected} onPress={() => onChoose(name)}
          className={`min-h-16 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border-2 px-2 py-2 ${selected ? 'border-primary bg-muted' : 'border-border bg-card'}`}>
          <View testID={`theme-swatch-${name}`} className="flex-row overflow-hidden rounded-sm border border-border">
            {swatchColours(name).map((colour, index) => <View key={index} className="h-5 w-4" style={{ backgroundColor: colour }} />)}
          </View>
          <Text numberOfLines={2} className="text-center text-sm font-medium text-foreground">{THEME_LABELS[name]}</Text>
        </Pressable>;
      })}
      {Array.from({ length: columns - row.length }, (_, pad) => <View key={`pad-${pad}`} className="min-w-0 flex-1" />)}
    </View>)}
  </View>;
}

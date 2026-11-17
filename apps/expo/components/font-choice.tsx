import { useEffect, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { FontProvider, RadioGroup, RadioGroupItem, Text } from '@tallyui/components';
import { fontFamilyStyle, TYPE_SETS } from '@tallyui/theme';
import { defaultStorage } from '../lib/session';
import { FONT_CHOICES, FONT_LABELS, isFontChoice, loadFontFaces, useFontChoice } from '../lib/font-choice';

export function AppFontProvider({ children }: { children: ReactNode }) {
  const { choice } = useFontChoice(defaultStorage());
  return <FontProvider font={choice} loadFonts={loadFontFaces}>{children}</FontProvider>;
}

export function FontPicker() {
  const { choice, save } = useFontChoice(defaultStorage());
  useEffect(() => {
    const families = [...new Set(FONT_CHOICES.map((id) => TYPE_SETS[id].body).filter((family) => family !== undefined))];
    void loadFontFaces(families).catch(() => { /* A failed preview just shows the fallback face. */ });
  }, []);
  return <View testID="settings-font" className="gap-2 border-t border-border p-4">
    <Text className="text-base font-semibold text-foreground">Font</Text>
    <Text className="text-sm text-muted-foreground">The typeface this till's text uses. Saved on this till only.</Text>
    <Text className="text-sm text-muted-foreground">Current font: {FONT_LABELS[choice]}</Text>
    <RadioGroup value={choice} aria-label="Font" className="gap-0"
      onValueChange={(value) => { if (isFontChoice(value) && value !== choice) save(value); }}>
      {FONT_CHOICES.map((id) => <View key={id} className="min-h-11 flex-row items-center gap-3 py-2">
        <RadioGroupItem value={id} testID={`font-choice-${id}`} aria-label={FONT_LABELS[id]} />
        <Text className="flex-1 text-sm text-foreground" onPress={() => { if (id !== choice) save(id); }}>{FONT_LABELS[id]}</Text>
        <Text testID={`font-preview-${id}`} className={`text-lg text-foreground${id === 'system' ? ' font-sans' : ''}`}
          style={fontFamilyStyle(TYPE_SETS[id].body, Platform.OS === 'web')}>Aa</Text>
      </View>)}
    </RadioGroup>
  </View>;
}

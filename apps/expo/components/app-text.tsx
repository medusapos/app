import { forwardRef, type ComponentProps, type ComponentRef } from 'react';
import { Platform, Text, type TextStyle } from 'react-native';
import { useFontType } from '@tallyui/components';
import { fontFamilyStyle } from '@tallyui/theme';

// Mirrors TallyUI Text's internal withFont rule (not exported), so the app's own react-native Text takes the
// chosen Theme Font the same way: no family for font-mono/sans/serif, the num face for tabular-nums, else body.
export const AppText = forwardRef<ComponentRef<typeof Text>, ComponentProps<typeof Text>>(function AppText({ className, style, ...props }, ref) {
  const { type } = useFontType();
  const family = /(^|\s)font-(mono|sans|serif)(\s|$)/.test(className ?? '') ? undefined
    : /(^|\s)tabular-nums(\s|$)/.test(className ?? '') ? type.num ?? type.body : type.body;
  return <Text ref={ref} {...props} className={className}
    style={family ? [fontFamilyStyle(family, Platform.OS === 'web'), style] : style} />;
});

// The Stack header title in the chosen body face, beside its 600 weight.
export function useHeaderTitleStyle(): Pick<TextStyle, 'fontFamily' | 'fontWeight'> {
  const { type } = useFontType();
  return { fontWeight: '600', ...(type.body ? fontFamilyStyle(type.body, Platform.OS === 'web') : undefined) };
}

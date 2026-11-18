import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useFontType } from '@tallyui/components';
import { fontFamilyStyle, type ThemeType } from '@tallyui/theme';

const NOT_FAMILY = ':not(.font-mono):not(.font-sans):not(.font-serif)';

/** The set's faces for input and textarea, by AppText's rule; the :not chain outranks react-native-web's atomic class. */
export function inputFontCss(type: ThemeType): string {
  if (!type.body) return '';
  const body = fontFamilyStyle(type.body, true)!.fontFamily;
  const num = fontFamilyStyle(type.num ?? type.body, true)!.fontFamily;
  const tags = ['input', 'textarea'];
  return [
    `${tags.map((tag) => `${tag}${NOT_FAMILY}:not(.tabular-nums)`).join(', ')} { font-family: ${body}; }`,
    `${tags.map((tag) => `${tag}.tabular-nums${NOT_FAMILY}`).join(', ')} { font-family: ${num}; }`,
  ].join('\n');
}

// TallyUI and react-native inputs carry no font family, so the chosen face is applied to them once here on the web.
export function InputFontStyle(): null {
  const { type } = useFontType();
  const css = inputFontCss(type);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !css) return;
    const element = document.createElement('style');
    element.setAttribute('data-medusapos-input-font', '');
    element.textContent = css;
    document.head.appendChild(element);
    return () => { element.remove(); };
  }, [css]);
  return null;
}

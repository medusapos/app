import { Platform } from 'react-native';

// React Native Web supports dataSet; the native ViewProps omit it.
declare module 'react-native' {
  interface ViewProps { dataSet?: Record<string, string>; }
}

export function injectPrintStyle() {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || document.getElementById('pos-print-style')) return;
  const style = document.createElement('style');
  style.id = 'pos-print-style';
  style.textContent = '@media print { [data-print="hide"] { display: none !important } }';
  document.head.appendChild(style);
}

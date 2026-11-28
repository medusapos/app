import { Platform } from 'react-native';
import { nativeBarcodeDetector } from '@tallyui/pos';

/** iOS, Android, or web with a camera API and a BarcodeDetector; read fresh each call, never throws. */
export function cameraScanSupported(): boolean {
  try {
    if (Platform.OS === 'ios' || Platform.OS === 'android') return true;
    return Platform.OS === 'web' && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'
      && nativeBarcodeDetector() !== undefined;
  } catch { return false; }
}

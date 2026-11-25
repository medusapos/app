import { Platform } from 'react-native';
import { nativeBarcodeDetector } from '@tallyui/pos';

/** Web with a camera API and a BarcodeDetector; read fresh each call, never throws (as DirectScannerConnection hides). */
export function cameraScanSupported(): boolean {
  try {
    return Platform.OS === 'web' && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'
      && nativeBarcodeDetector() !== undefined;
  } catch { return false; }
}

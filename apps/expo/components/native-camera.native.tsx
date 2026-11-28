import { useEffect, useRef, type ComponentType } from 'react';
import { Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { ViewfinderProps } from '@tallyui/components';
import { CAMERA_BARCODE_TYPES } from '@tallyui/pos';

export const NativeViewfinder: ComponentType<ViewfinderProps> = (props) => {
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => { latest.current.onStatus('initializing'); }, []);

  return <CameraView testID="scanner-viewfinder" style={{ flex: 1 }} facing="back"
    barcodeScannerSettings={{ barcodeTypes: [...CAMERA_BARCODE_TYPES] }}
    onBarcodeScanned={(result) => latest.current.onDetected(result.data, result.type)}
    onCameraReady={() => latest.current.onStatus('scanning')}
    onMountError={() => latest.current.onStatus('camera-unavailable')} />;
};

export function useNativeCameraPermission(): { granted: boolean; request: () => void } {
  const [permission, requestPermission] = useCameraPermissions();
  return {
    granted: permission?.granted === true,
    request: () => {
      if (permission?.canAskAgain === false) void Linking.openSettings().catch(() => {});
      else void requestPermission().catch(() => {});
    },
  };
}

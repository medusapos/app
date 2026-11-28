// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Linking, View } from 'react-native';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { CameraScannerPanel } from '@tallyui/components';
import { CAMERA_BARCODE_TYPES } from '@tallyui/pos';
import { NativeViewfinder, useNativeCameraPermission } from '../components/native-camera.native';
import * as web from '../components/native-camera';

type CameraProps = {
  testID: string;
  facing: string;
  barcodeScannerSettings: { barcodeTypes: string[] };
  onBarcodeScanned: (result: { data: string; type: string }) => void;
  onCameraReady: () => void;
  onMountError: (event: { message: string }) => void;
};
const { recordCamera, permissions } = vi.hoisted(() => ({
  recordCamera: vi.fn<(props: CameraProps) => void>(),
  permissions: vi.fn<() => [{ granted: boolean; canAskAgain: boolean } | null, () => Promise<void>]>(),
}));
vi.mock('expo-camera', () => ({
  CameraView: (props: CameraProps) => {
    recordCamera(props);
    return <View testID={props.testID} />;
  },
  useCameraPermissions: permissions,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('NC-1: the back camera forwards configured barcode types to the latest detection callback', () => {
  const onDetected = vi.fn();
  const onStatus = vi.fn();
  const { rerender } = render(<NativeViewfinder onDetected={vi.fn()} onStatus={onStatus} />);
  const [camera] = recordCamera.mock.lastCall!;
  expect(camera.facing).toBe('back');
  expect(camera.barcodeScannerSettings.barcodeTypes).toEqual(CAMERA_BARCODE_TYPES);
  rerender(<NativeViewfinder onDetected={onDetected} onStatus={onStatus} />);
  camera.onBarcodeScanned({ data: '4006381333931', type: 'ean13' });
  expect(onDetected).toHaveBeenCalledWith('4006381333931', 'ean13');
});

it('NC-2: reports initialization, readiness and mount errors', () => {
  const onStatus = vi.fn();
  render(<NativeViewfinder onDetected={vi.fn()} onStatus={onStatus} />);
  const [camera] = recordCamera.mock.lastCall!;
  camera.onCameraReady();
  camera.onMountError({ message: 'x' });
  expect(onStatus.mock.calls).toEqual([['initializing'], ['scanning'], ['camera-unavailable']]);
});

it('NC-3: reports permission and requests it or opens device settings', () => {
  const request = vi.fn().mockResolvedValue(undefined);
  const openSettings = vi.fn().mockResolvedValue(undefined);
  const original = Linking.openSettings;
  Linking.openSettings = openSettings;
  onTestFinished(() => {
    if (original) Linking.openSettings = original;
    else Reflect.deleteProperty(Linking, 'openSettings');
  });

  permissions.mockReturnValue([null, request]);
  const { result, rerender } = renderHook(useNativeCameraPermission);
  expect(result.current.granted).toBe(false);
  permissions.mockReturnValue([{ granted: true, canAskAgain: true }, request]);
  rerender();
  expect(result.current.granted).toBe(true);

  permissions.mockReturnValue([{ granted: false, canAskAgain: true }, request]);
  rerender();
  result.current.request();
  expect(request).toHaveBeenCalledTimes(1);
  expect(openSettings).not.toHaveBeenCalled();

  request.mockClear();
  permissions.mockReturnValue([{ granted: false, canAskAgain: false }, request]);
  rerender();
  result.current.request();
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});

it('NC-4: the panel gates the native viewfinder and forwards its decodes once granted', () => {
  const request = vi.fn();
  const onDetected = vi.fn();
  const props = { viewfinder: NativeViewfinder, onDetected, onClose: vi.fn() };
  const { rerender } = render(<CameraScannerPanel {...props} permission={{ granted: false, request }} />);
  expect(screen.getByTestId('camera-permission-request')).toBeTruthy();
  expect(screen.queryByTestId('scanner-viewfinder')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Allow camera' }));
  expect(request).toHaveBeenCalledTimes(1);
  rerender(<CameraScannerPanel {...props} permission={{ granted: true, request }} />);
  expect(screen.getByTestId('scanner-viewfinder')).toBeTruthy();
  recordCamera.mock.lastCall![0].onBarcodeScanned({ data: '4006381333931', type: 'ean13' });
  expect(onDetected).toHaveBeenCalledWith('4006381333931', 'ean13');
});

it('NC-5: web supplies neither a viewfinder nor a permission gate', () => {
  expect(web.NativeViewfinder).toBeUndefined();
  expect(web.useNativeCameraPermission()).toBeUndefined();
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { STANDARD_SPP_SERVICE_CLASS_ID, type HidDeviceLike, type HidInputReportEventLike, type HidLike, type SerialLike, type SerialPortLike } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceScannerProvider, DirectScannerConnection } from '../components/device-scanner';
import { loadScannerProfiles } from '../lib/scanner-profiles';
import { DEFAULT_SCANNER_SETTINGS, saveScannerSettings } from '../lib/scanner-settings';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { useDeviceScans } from '../lib/use-device-scans';

const baseUrl = 'https://store.test';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, {
    baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

// One HID-POS scanner: the chooser offers it, and `fire` sends a report laid out [length][ASCII bytes...].
function fakeHid() {
  let listener: ((event: HidInputReportEventLike) => void) | null = null;
  const device: HidDeviceLike = {
    productName: 'Test HID Scanner', vendorId: 0x05e0, productId: 0x1200,
    open: vi.fn(async () => {}), close: vi.fn(async () => {}),
    addEventListener: vi.fn((_type, l) => { listener = l; }), removeEventListener: vi.fn(() => { listener = null; }),
  };
  const hid: HidLike = { requestDevice: vi.fn(async () => [device]), getDevices: vi.fn(async () => []) };
  const fire = (code: string) => act(() => {
    const ascii = Array.from(code, (char) => char.charCodeAt(0));
    listener?.({ data: new DataView(Uint8Array.of(code.length, ...ascii).buffer), reportId: 0 });
  });
  return { hid, device, fire };
}

function fakeSerial(line: string) {
  const port: SerialPortLike = {
    open: vi.fn(async () => {}), close: vi.fn(async () => {}),
    readable: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(line)); } }),
    getInfo: () => ({ bluetoothServiceClassId: STANDARD_SPP_SERVICE_CLASS_ID }),
  };
  const serial: SerialLike = { requestPort: vi.fn(async () => port), getPorts: vi.fn(async () => []) };
  return { serial, port };
}

function Probe({ onScan }: { onScan: (code: string) => void }) {
  useDeviceScans(true, onScan);
  return null;
}

async function mount(devices: { hid?: HidLike; serial?: SerialLike }, onScan = vi.fn()) {
  await act(async () => {
    render(<SessionProvider><DeviceScannerProvider {...devices}>
      <DirectScannerConnection /><Probe onScan={onScan} />
    </DeviceScannerProvider></SessionProvider>);
  });
  return onScan;
}

// Lets the controller's open-then-save chain finish.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function press(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
  await settle();
}

describe('Direct scanner connection', () => {
  it('shows nothing where neither WebHID nor Web Serial exists', async () => {
    await mount({});
    expect(screen.queryByTestId('settings-scanner-direct')).toBeNull();
  });

  it('connects over USB, saves the profile, delivers its scans, and removes it', async () => {
    const { hid, device, fire } = fakeHid();
    const onScan = await mount({ hid });
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect over USB' })).toBeNull();
    await press('Connect a scanner directly (advanced)');
    expect(screen.queryByRole('button', { name: 'Connect over Bluetooth serial' })).toBeNull();
    await press('Connect over USB');
    expect(hid.requestDevice).toHaveBeenCalledWith({ filters: [{ usagePage: 140 }] });
    expect(screen.getByText('Test HID Scanner')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.queryByText('None')).toBeNull();
    const profiles = loadScannerProfiles(localStorage);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ connectionType: 'hid-pos', deviceName: 'Test HID Scanner' });

    fire('4006381333931');
    expect(onScan).toHaveBeenCalledWith('4006381333931');

    await press('Remove Test HID Scanner');
    expect(device.close).toHaveBeenCalled();
    expect(loadScannerProfiles(localStorage)).toEqual([]);
    expect(screen.queryByText('Test HID Scanner')).toBeNull();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it("drops a HID-POS code shorter than the till's minimum characters", async () => {
    saveScannerSettings(localStorage, baseUrl, { ...DEFAULT_SCANNER_SETTINGS, minChars: 6 });
    const { hid, fire } = fakeHid();
    const onScan = await mount({ hid });
    await press('Connect a scanner directly (advanced)');
    await press('Connect over USB');
    fire('ABCDE');
    expect(onScan).not.toHaveBeenCalled();
    fire('ABCDEF');
    expect(onScan).toHaveBeenCalledWith('ABCDEF');
  });

  it("connects over Bluetooth serial and strips the till's prefix from each line", async () => {
    saveScannerSettings(localStorage, baseUrl, { ...DEFAULT_SCANNER_SETTINGS, prefix: '#' });
    const { serial, port } = fakeSerial('#ABC123\r');
    const onScan = await mount({ serial });
    await press('Connect a scanner directly (advanced)');
    await press('Connect over Bluetooth serial');
    expect(port.open).toHaveBeenCalledWith({ baudRate: 9600 });
    expect(onScan).toHaveBeenCalledWith('ABC123');
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});

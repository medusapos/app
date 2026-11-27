// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryDisplaySignalling } from '@tallyui/core/server';
import { buildReceiptData, createOrderBuilder, createTillDevice, createTillDisplayService, createTillPairing } from '@tallyui/pos';
import { Platform } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DisplayRoute from '../app/display';
import { storeConfig } from '../lib/config';
import { DISPLAY_STORE_KEY, displayConfigFor, displayKeyStore } from '../lib/customer-display';

let memory: ReturnType<typeof createMemoryDisplaySignalling>;
let params: { store?: string | string[] };
vi.mock('@tallyui/connector-medusa', async (original) => ({ ...await original<typeof import('@tallyui/connector-medusa')>(),
  get medusaDisplaySignalling() { return memory.signalling; } }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => params }));
const platform = Platform.OS;
const shop = 'https://shop.test';
const tokenKey = `medusapos.display.${shop}`;
let pairing: ReturnType<typeof createTillPairing>;
let service: ReturnType<typeof createTillDisplayService>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear(); vi.stubGlobal('localStorage', sessionStorage);
  memory = createMemoryDisplaySignalling();
  params = {};
  for (const method of Object.keys(memory.signalling) as (keyof typeof memory.signalling)[]) vi.spyOn(memory.signalling, method);
  const prototype: Storage = Object.getPrototypeOf(localStorage);
  for (const method of ['getItem', 'setItem', 'removeItem'] as const) vi.spyOn(prototype, method);
});
afterEach(() => {
  cleanup(); pairing?.close(); service?.close();
  Platform.OS = platform; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const address = () => screen.getByTestId<HTMLInputElement>('display-store-url');
async function connect(url: string) {
  fireEvent.change(address(), { target: { value: url } });
  await act(async () => { fireEvent.click(screen.getByTestId('display-store-connect')); });
}
function noSignals() {
  for (const method of Object.values(memory.signalling)) expect(method).not.toHaveBeenCalled();
}
function storageKeys() {
  return (['getItem', 'setItem', 'removeItem'] as const).flatMap((method) => vi.mocked(localStorage[method]).mock.calls.map(([key]) => key));
}

it('DR-1: native shows the web-only message without accessing storage or signalling', () => {
  Platform.OS = 'ios';
  render(<DisplayRoute />);
  expect(screen.getByTestId('display-web-only').textContent).toBe('The customer display runs in a web browser. Open this page in a browser on the display device.');
  expect(storageKeys()).toEqual([]);
  noSignals();
});

it.each([{ store: shop }, { store: [shop, 'https://other.test'] }])('DR-2: a store link only prefills the address (%j)', async ({ store }) => {
  params = { store };
  await act(async () => { render(<DisplayRoute />); });
  expect(address().value).toBe(shop);
  expect(screen.queryByTestId('display-code')).toBeNull();
  expect(localStorage.setItem).not.toHaveBeenCalled();
  expect(localStorage.getItem).not.toHaveBeenCalledWith(tokenKey);
  noSignals();
});

it('DR-3: without a store link the configured address is prefilled', () => {
  render(<DisplayRoute />);
  expect(address().value).toBe(storeConfig.defaultBaseUrl);
});

it('DR-4: public HTTP and invalid URLs are refused; LAN and normalized HTTPS are saved', async () => {
  render(<DisplayRoute />);
  await connect('http://shop.example.com');
  expect(screen.getByTestId('display-store-error').textContent).toBe('Use https://. Plain http:// is only allowed for localhost and private network addresses.');
  expect(localStorage.setItem).not.toHaveBeenCalled();
  await connect('ftp://x');
  expect(screen.getByTestId('display-store-error').textContent).toBe('Enter a valid backend URL starting with https://.');
  expect(localStorage.setItem).not.toHaveBeenCalled();
  await connect('http://192.168.1.20:9000');
  expect(localStorage.getItem(DISPLAY_STORE_KEY)).toBe('http://192.168.1.20:9000');
  await act(async () => { fireEvent.click(screen.getByTestId('display-change-store')); });
  await connect(`${shop}/`);
  expect(localStorage.getItem(DISPLAY_STORE_KEY)).toBe(shop);
  expect(screen.getByTestId('display-code')).toBeTruthy();
});

async function claim(code: string) {
  fireEvent.change(screen.getByTestId('display-code'), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('display-pair'));
    await Promise.resolve();
    await Promise.allSettled(vi.mocked(memory.signalling.claim).mock.results.map(({ value }) => value));
  });
}

async function pair() {
  const mounted = render(<DisplayRoute />);
  await connect(shop);
  expect(screen.getByTestId('display-store-host').textContent).toBe('Store: shop.test');
  const { signalling } = memory;
  const ctx = await memory.harness.till({ cashierId: 'staff', canPair: true });
  const context = () => ctx;
  const device = createTillDevice({ signalling, deviceId: 'till', keys: displayKeyStore(null, shop) });
  service = createTillDisplayService({ signalling, device, context, advertisement: { iceServers: [], snapshot: true },
    configFor: (display) => displayConfigFor(display, null, 'en') });
  pairing = createTillPairing({ signalling, device, context, service });
  await pairing.start();
  if (pairing.phase.phase !== 'code') throw Error('Till did not mint a code');
  await claim(pairing.phase.code);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(vi.mocked(signalling.pending).mock.results.map(({ value }) => value));
    await Promise.all(vi.mocked(signalling.collect).mock.results.map(({ value }) => value));
  });
  const pending = pairing.phase.claims[0];
  expect(screen.getByTestId('display-check-code').textContent).toBe(pending.checkCode);
  await pairing.confirm(pending.claimId);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(vi.mocked(signalling.collect).mock.results.map(({ value }) => value));
  });
  expect(screen.getByTestId('display-paired')).toBeTruthy();
  return mounted;
}

it('DR-5: confirms the same check code and stores only the display’s own credentials', async () => {
  await pair();
  expect(screen.queryByTestId('display-store-host')).toBeNull();
  expect(localStorage.getItem(tokenKey)).toBeTruthy();
  expect(storageKeys().filter((key) => key !== DISPLAY_STORE_KEY && !key.startsWith('medusapos.display.'))).toEqual([]);
});

it('DR-6: a reload uses the saved token and ignores a different store link', async () => {
  (await pair()).unmount();
  params = { store: 'https://other.test' };
  vi.mocked(localStorage.setItem).mockClear();
  await act(async () => { render(<DisplayRoute />); });
  expect(screen.getByTestId('display-paired')).toBeTruthy();
  expect(localStorage.getItem(DISPLAY_STORE_KEY)).toBe(shop);
  expect(localStorage.setItem).not.toHaveBeenCalled();
  expect(memory.signalling.displayReceiveSignals).toHaveBeenLastCalledWith({ baseUrl: shop }, localStorage.getItem(tokenKey));
});

it('DR-7: forgetting on the till removes the token, not the store', async () => {
  await pair();
  const collected = await vi.mocked(memory.signalling.collect).mock.results.at(-1)?.value;
  if (collected?.status !== 'paired') throw Error('Display did not collect its token');
  await pairing.forget(collected.displayId);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.allSettled(vi.mocked(memory.signalling.displayReceiveSignals).mock.results.map(({ value }) => value));
  });
  expect(screen.getByTestId('pairing-error').textContent).toContain('removed from its till');
  expect(localStorage.getItem(tokenKey)).toBeNull();
  expect(localStorage.getItem(DISPLAY_STORE_KEY)).toBe(shop);
  expect(screen.getByTestId('display-store-host').textContent).toBe('Store: shop.test');
});

it('DR-8: Change store clears the token and store, keeping only the field prefill', async () => {
  render(<DisplayRoute />);
  await connect(shop);
  localStorage.setItem(tokenKey, 'old-token');
  await act(async () => { fireEvent.click(screen.getByTestId('display-change-store')); });
  expect(localStorage.getItem(tokenKey)).toBeNull();
  expect(localStorage.getItem(DISPLAY_STORE_KEY)).toBeNull();
  expect(address().value).toBe(shop);
});

it('DR-9: a wrong code shows the refusal and stores no token', async () => {
  render(<DisplayRoute />);
  await connect(shop);
  await claim('123456');
  expect(screen.getByTestId('pairing-error').textContent).toBe("That code didn't work. Check it on the till and try again.");
  expect(localStorage.getItem(tokenKey)).toBeNull();
});

it('DR-10: the snapshot shows the cart without a fallback notice', async () => {
  class NeverConnects {
    createDataChannel() { return { readyState: 'connecting', close() {} }; }
    createOffer() { return new Promise<never>(() => {}); }
    createAnswer = this.createOffer;
    setRemoteDescription = this.createOffer;
    setLocalDescription = this.createOffer;
    addIceCandidate = this.createOffer;
    close() {}
  }
  vi.stubGlobal('RTCPeerConnection', NeverConnects);
  await pair();
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', name: 'Shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  await service.refresh();
  service.showCart(buildReceiptData(builder.getSnapshot(), { storeName: 'Main shop' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all(vi.mocked(memory.signalling.readSnapshot).mock.results.map(({ value }) => value));
  });
  expect(screen.getByText('Shirt')).toBeTruthy();
  expect(screen.queryByText(/snapshot|fallback/i)).toBeNull();
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeConfig } from './config';
import { DEMO_CAPTURE_URL, trackDemoEvent, withDemoSaleEvent } from './demo-analytics';

const originalAnalytics = storeConfig.analytics;
const fetchMock = vi.fn<typeof fetch>();
const body = (index = 0) => JSON.parse(fetchMock.mock.calls[index][1]?.body as string);
beforeEach(() => {
  storeConfig.analytics = true;
  fetchMock.mockReset().mockResolvedValue(new Response());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  storeConfig.analytics = originalAnalytics;
  vi.unstubAllGlobals();
});

describe('demo analytics', () => {
  it('sends only the anonymous capture payload without credentials', () => {
    trackDemoEvent('demo_opened');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(DEMO_CAPTURE_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: expect.any(String), credentials: 'omit', keepalive: true,
    });
    expect(body()).toEqual({
      api_key: 'phc_BhTJzZ7fXMqcD4MiaUJQsQqPkEpu94yoSAthXFBWemvd', event: 'demo_opened',
      distinct_id: expect.any(String),
      properties: { site: 'demo.medusapos.com', $process_person_profile: false },
    });
    expect(body().distinct_id.length).toBeGreaterThan(0);
  });

  it('reuses the in-memory visit id', () => {
    trackDemoEvent('demo_opened');
    trackDemoEvent('demo_signed_in');
    expect(body(1).distinct_id).toBe(body().distinct_id);
  });

  it('sends no events when analytics is off at call time', () => {
    storeConfig.analytics = false;
    trackDemoEvent('demo_opened');
    trackDemoEvent('demo_signed_in');
    trackDemoEvent('demo_sale_completed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['rejecting', 'throwing', 'missing'])('silently tolerates %s fetch', async (kind) => {
    const error = new Error('offline');
    if (kind === 'rejecting') fetchMock.mockRejectedValue(error);
    if (kind === 'throwing') fetchMock.mockImplementation(() => { throw error; });
    if (kind === 'missing') vi.stubGlobal('fetch', undefined);
    expect(() => trackDemoEvent('demo_opened')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('writes no cookie or storage keys', () => {
    const localStorageMock = {
      getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
    };
    const sessionStorageMock = {
      getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
    };
    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('sessionStorage', sessionStorageMock);
    trackDemoEvent('demo_opened');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const storageSpy of [...Object.values(localStorageMock), ...Object.values(sessionStorageMock)]) {
      expect(storageSpy).not.toHaveBeenCalled();
    }
    expect(document.cookie).toBe('');
  });

  it('sends a sale event only after recording resolves', async () => {
    let resolveRecord!: () => void;
    const record = vi.fn(() => new Promise<void>((resolve) => { resolveRecord = resolve; }));
    const order = { id: 'sale-1' };
    const completed = withDemoSaleEvent(record)(order);
    expect(record).toHaveBeenCalledExactlyOnceWith(order);
    expect(fetchMock).not.toHaveBeenCalled();
    resolveRecord();
    await completed;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body().event).toBe('demo_sale_completed');
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it('propagates the same recording error without sending', async () => {
    const error = new Error('save failed');
    const record = vi.fn().mockRejectedValue(error);
    await expect(withDemoSaleEvent(record)({ id: 'sale-1' })).rejects.toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

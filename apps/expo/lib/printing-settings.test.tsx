// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRINTING_SETTINGS, loadPrintingSettings, savePrintingSettings, useAutoPrintReceipt, usePrintingSettings,
} from './printing-settings';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

const KEY = 'medusapos.printing.https://a.test';

describe('printing-settings storage', () => {
  it.each([
    ['empty storage', {}],
    ['invalid JSON', { [KEY]: 'not json' }],
    ['a non-boolean autoPrintReceipt', { [KEY]: JSON.stringify({ autoPrintReceipt: 'yes' }) }],
  ])('falls back to the defaults on %s', (_name, initial) => {
    expect(loadPrintingSettings(fakeStorage(initial), 'https://a.test')).toEqual({ autoPrintReceipt: false });
  });

  it('round-trips a save, keyed per baseUrl', () => {
    const storage = fakeStorage();
    savePrintingSettings(storage, 'https://a.test', { autoPrintReceipt: true });
    expect(loadPrintingSettings(storage, 'https://a.test')).toEqual({ autoPrintReceipt: true });
    expect(loadPrintingSettings(storage, 'https://b.test')).toEqual(DEFAULT_PRINTING_SETTINGS);
  });
});

describe('usePrintingSettings', () => {
  afterEach(() => { cleanup(); });

  it('updates a second mounted reader on a save', () => {
    const storage = fakeStorage();
    let save!: ReturnType<typeof usePrintingSettings>['save'];
    function Reader({ label }: { label: string }) {
      const printing = usePrintingSettings(storage, 'https://a.test');
      if (label === 'first') save = printing.save;
      return <span aria-label={label}>{String(printing.settings.autoPrintReceipt)}</span>;
    }
    render(<><Reader label="first" /><Reader label="second" /></>);
    expect(screen.getByLabelText('second').textContent).toBe('false');
    act(() => save({ autoPrintReceipt: true }));
    expect(screen.getByLabelText('second').textContent).toBe('true');
  });
});

describe('useAutoPrintReceipt', () => {
  let next = 0;
  // The record is module-level, so every test uses ids no other test has seen.
  const newId = () => `order_auto_print_${++next}`;
  const print = vi.fn();
  function Probe({ saleId, enabled }: { saleId: string | undefined; enabled: boolean }) {
    useAutoPrintReceipt(saleId, enabled, print);
    return null;
  }

  beforeEach(() => { vi.useFakeTimers(); print.mockClear(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('prints once after the settle delay, never again for the same sale', () => {
    const id = newId();
    const view = render(<Probe saleId={id} enabled />);
    act(() => vi.advanceTimersByTime(49));
    expect(print).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(print).toHaveBeenCalledTimes(1);

    view.rerender(<Probe saleId={id} enabled />);
    view.unmount();
    render(<Probe saleId={id} enabled />);
    act(() => vi.advanceTimersByTime(100));
    expect(print).toHaveBeenCalledTimes(1);

    cleanup();
    render(<Probe saleId={newId()} enabled />);
    act(() => vi.advanceTimersByTime(50));
    expect(print).toHaveBeenCalledTimes(2);
  });

  it('prints once under StrictMode', () => {
    render(<StrictMode><Probe saleId={newId()} enabled /></StrictMode>);
    act(() => vi.advanceTimersByTime(50));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('never prints a sale first seen with the switch off, even after it is turned on', () => {
    const id = newId();
    const view = render(<Probe saleId={id} enabled={false} />);
    act(() => vi.advanceTimersByTime(100));
    view.rerender(<Probe saleId={id} enabled />);
    act(() => vi.advanceTimersByTime(100));
    expect(print).not.toHaveBeenCalled();
  });

  it('never prints without a sale', () => {
    render(<Probe saleId={undefined} enabled />);
    act(() => vi.advanceTimersByTime(100));
    expect(print).not.toHaveBeenCalled();
  });
});

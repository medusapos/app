// @vitest-environment jsdom
import { useEffect, type ReactNode } from 'react';
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { flushSync } from 'react-dom';
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { createRoot } from 'react-dom/client';
import { Platform, Pressable, Text, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import type { LiveTabHandle, LiveTabOptions, LiveTabState } from '@tallyui/database';
import { LiveTabGate } from '../components/live-tab-gate';
import { closeDatabases, isBusy, markBusy, reportStorageStartFailure, storageNeedsReload } from '../lib/live-tab';
import { webStorageAvailable } from '../lib/web-storage';

// A hand-rolled mock subject (vi.mock factories cannot close over top-level variables, only
// vi.hoisted ones), reset in beforeEach rather than the real sticky one: this file's tests share
// one module instance, and a real reportStorageStartFailure() would leak `true` into every test
// after it.
const { storageStartFailedSubject, reportStorageStartFailureMock } = vi.hoisted(() => {
  let value = false;
  const listeners = new Set<(next: boolean) => void>();
  const subject = {
    next: (next: boolean) => { value = next; listeners.forEach((listener) => listener(next)); },
    subscribe: (listener: (next: boolean) => void) => {
      listeners.add(listener);
      listener(value);
      return { unsubscribe: () => listeners.delete(listener) };
    },
  };
  return { storageStartFailedSubject: subject, reportStorageStartFailureMock: vi.fn(() => subject.next(true)) };
});

vi.mock('../lib/live-tab', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual, closeDatabases: vi.fn(), storageNeedsReload: vi.fn(() => false),
    storageStartFailed$: storageStartFailedSubject,
    reportStorageStartFailure: reportStorageStartFailureMock,
  };
});

// jsdom has no OPFS: every test runs as a supporting browser unless it says otherwise.
vi.mock('../lib/web-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/web-storage')>()),
  webStorageAvailable: vi.fn(() => true),
}));

// react-dom/client has no bundled types reachable here (no @types/react-dom in
// this Expo/React Native app); a minimal local shape covers what this file uses.
type Root = { render: (element: ReactNode) => void; unmount: () => void };

// The real `@tallyui/components` barrel fails to import under vitest with:
// SyntaxError: Unexpected token 'typeof'
// This fake mirrors LiveTabScreen's own rendering rules closely enough to exercise
// LiveTabGate's usage of it (state, callbacks, string props).
type FakeLiveTabScreenProps = {
  state: LiveTabState;
  onUseHere: () => void;
  onReload: () => void;
  parkedTitle?: string;
  parkedBody?: string;
  useHereLabel?: string;
  blockedBody?: string;
  reloadLabel?: string;
};
vi.mock('@tallyui/components', () => ({
  LiveTabScreen(props: FakeLiveTabScreenProps) {
    if (props.state !== 'parked' && props.state !== 'blocked') return null;
    const body = props.state === 'parked' ? props.parkedBody : props.blockedBody;
    const label = props.state === 'parked' ? props.useHereLabel : props.reloadLabel;
    const onPress = props.state === 'parked' ? props.onUseHere : props.onReload;
    return (
      <View>
        <Text>{props.parkedTitle}</Text>
        <Text>{body}</Text>
        <Pressable accessibilityRole="button" onPress={onPress}><Text>{label}</Text></Pressable>
      </View>
    );
  },
}));

type FakeInstance = {
  scope: string;
  options: LiveTabOptions;
  subject: BehaviorSubject<LiveTabState>;
  takeOver: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function fakeStartLiveTab(): { startLiveTab: (options: LiveTabOptions) => LiveTabHandle; instances: FakeInstance[] } {
  const instances: FakeInstance[] = [];
  const startLiveTab = (options: LiveTabOptions): LiveTabHandle => {
    const subject = new BehaviorSubject<LiveTabState>('acquiring');
    const stop = vi.fn(() => subject.complete());
    const takeOver = vi.fn(async () => { subject.next('live'); return 'live' as const; });
    instances.push({ scope: options.scope, options, subject, takeOver, stop });
    return { state$: subject.asObservable(), takeOver, stop };
  };
  return { startLiveTab, instances };
}

function Marker({ onMount, text }: { onMount: () => void; text: string }) {
  useEffect(() => { onMount(); }, []);
  return <Text>{text}</Text>;
}

const closeDatabasesMock = vi.mocked(closeDatabases);
const storageNeedsReloadMock = vi.mocked(storageNeedsReload);

beforeEach(() => {
  closeDatabasesMock.mockReset();
  closeDatabasesMock.mockResolvedValue(undefined);
  storageNeedsReloadMock.mockReset();
  storageNeedsReloadMock.mockReturnValue(false);
  storageStartFailedSubject.next(false);
  vi.mocked(webStorageAvailable).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  markBusy('payment', false);
  markBusy('outbox', false);
});

describe('LiveTabGate', () => {
  it('renders children and starts nothing when signed out', () => {
    const { startLiveTab } = fakeStartLiveTab();
    const startSpy = vi.fn(startLiveTab);
    render(<LiveTabGate startLiveTab={startSpy}><Text>children-rendered</Text></LiveTabGate>);
    expect(screen.getByText('children-rendered')).toBeTruthy();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('renders children and starts nothing on native', () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    try {
      const { startLiveTab } = fakeStartLiveTab();
      const startSpy = vi.fn(startLiveTab);
      render(<LiveTabGate scope="store-native" startLiveTab={startSpy}><Text>children-rendered</Text></LiveTabGate>);
      expect(screen.getByText('children-rendered')).toBeTruthy();
      expect(startSpy).not.toHaveBeenCalled();
    } finally { Platform.OS = original; }
  });

  it('shows loading while acquiring, children while live, and the parked/blocked screens', () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    render(<LiveTabGate scope="store-states" startLiveTab={startLiveTab}><Text>children-rendered</Text></LiveTabGate>);
    const instance = instances[0];

    expect(screen.getByText('Opening MedusaPOS…')).toBeTruthy();
    expect(screen.queryByText('children-rendered')).toBeNull();

    act(() => instance.subject.next('live'));
    expect(screen.getByText('children-rendered')).toBeTruthy();

    act(() => instance.subject.next('parked'));
    expect(screen.getByText('MedusaPOS is open in another tab')).toBeTruthy();
    expect(screen.getByText('This tab stopped so the other one can take sales. Use MedusaPOS here instead?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use here' }));
    expect(instance.takeOver).toHaveBeenCalledOnce();

    act(() => instance.subject.next('blocked'));
    expect(screen.getByText('MedusaPOS is open in another tab. Close that tab to use it here, or reload this one.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('shows Reload instead of Use here on the parked screen when storageNeedsReload() is true', () => {
    storageNeedsReloadMock.mockReturnValue(true);
    // jsdom's `location.reload` is non-writable and non-configurable on its own object, so the
    // whole `window.location` property (which is configurable) is swapped out instead.
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
    try {
      const { startLiveTab, instances } = fakeStartLiveTab();
      render(<LiveTabGate scope="store-needs-reload" startLiveTab={startLiveTab}><Text>children-rendered</Text></LiveTabGate>);
      const instance = instances[0];

      act(() => instance.subject.next('live'));
      act(() => instance.subject.next('parked'));

      expect(screen.getByText('Reload this tab to use MedusaPOS here.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Use here' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(instance.takeOver).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledOnce();
    } finally { Object.defineProperty(window, 'location', { configurable: true, value: originalLocation }); }
  });

  it('shows the unsupported-browser screen, no children and starts nothing on web without SQLite-wasm support', () => {
    vi.mocked(webStorageAvailable).mockReturnValue(false);
    const { startLiveTab } = fakeStartLiveTab();
    const startSpy = vi.fn(startLiveTab);
    render(<LiveTabGate scope="store-unsupported" startLiveTab={startSpy}><Text>children-rendered</Text></LiveTabGate>);
    expect(screen.getByText('This browser can\'t store sales safely (no OPFS worker storage). Use a current Chrome, Edge, Safari or Firefox over HTTPS.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByText('children-rendered')).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('shows Reload instead of the POS when live while storageNeedsReload() is true', () => {
    storageNeedsReloadMock.mockReturnValue(true);
    const { startLiveTab, instances } = fakeStartLiveTab();
    render(<LiveTabGate scope="store-live-needs-reload" startLiveTab={startLiveTab}><Text>children-rendered</Text></LiveTabGate>);
    act(() => instances[0].subject.next('live'));
    expect(screen.getByText('MedusaPOS needs a reload')).toBeTruthy();
    expect(screen.getByText('Reload this tab to use MedusaPOS here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByText('children-rendered')).toBeNull();
  });

  it('shows the blocked screen and no children after reportStorageStartFailure(), whatever the coordinator state', () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    render(<LiveTabGate scope="store-start-failure" startLiveTab={startLiveTab}><Text>children-rendered</Text></LiveTabGate>);
    const instance = instances[0];
    act(() => instance.subject.next('live'));
    expect(screen.getByText('children-rendered')).toBeTruthy();

    act(() => { reportStorageStartFailure(); });
    expect(screen.queryByText('children-rendered')).toBeNull();
    expect(screen.getByText('MedusaPOS is open in another tab. Close that tab to use it here, or reload this one.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('passes isBusy to the coordinator, following markBusy', () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    render(<LiveTabGate scope="store-busy" startLiveTab={startLiveTab}><Text>children-rendered</Text></LiveTabGate>);
    const instance = instances[0];
    expect(instance.options.isBusy).toBe(isBusy);
    expect(instance.options.isBusy!()).toBe(false);
    markBusy('payment', true);
    expect(instance.options.isBusy!()).toBe(true);
    markBusy('outbox', true);
    markBusy('payment', false);
    expect(instance.options.isBusy!()).toBe(true);
    markBusy('outbox', false);
    expect(instance.options.isBusy!()).toBe(false);
  });

  it('onPark unmounts children before awaiting the database closes, and resolves only after they settle', async () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const mounts = vi.fn();
    render(<LiveTabGate scope="store-onpark" startLiveTab={startLiveTab}>
      <Marker onMount={mounts} text="children-rendered" />
    </LiveTabGate>);
    const instance = instances[0];
    act(() => instance.subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(1));

    let resolveClose!: () => void;
    closeDatabasesMock.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveClose = resolve; }));

    let parkSettled = false;
    let onParkPromise!: Promise<void>;
    act(() => {
      onParkPromise = Promise.resolve(instance.options.onPark());
      void onParkPromise.then(() => { parkSettled = true; });
    });

    await waitFor(() => expect(screen.queryByText('children-rendered')).toBeNull());
    await waitFor(() => expect(closeDatabasesMock).toHaveBeenCalledOnce());
    expect(parkSettled).toBe(false);

    await act(async () => { resolveClose(); await onParkPromise; });
    expect(parkSettled).toBe(true);
  });

  it('settles onPark without hanging when a hand-over arrives before `live` commits', async () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const mounts = vi.fn();
    render(<LiveTabGate scope="store-race" startLiveTab={startLiveTab}>
      <Marker onMount={mounts} text="children-rendered" />
    </LiveTabGate>);
    const instance = instances[0];

    // The reviewer's repro: `live` and `onPark` land in the same batch, so
    // `showChildren` goes true then false without ever committing `true` —
    // nothing to wait a commit for.
    let onParkPromise!: Promise<void>;
    act(() => {
      instance.subject.next('live');
      onParkPromise = Promise.resolve(instance.options.onPark());
    });

    await act(async () => { await onParkPromise; });
    expect(closeDatabasesMock).toHaveBeenCalledOnce();
    expect(mounts).not.toHaveBeenCalled();
    expect(screen.queryByText('children-rendered')).toBeNull();
  });

  it('remounts children after a park settles, and not before', async () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const mounts = vi.fn();
    render(<LiveTabGate scope="store-remount" startLiveTab={startLiveTab}>
      <Marker onMount={mounts} text="children-rendered" />
    </LiveTabGate>);
    const instance = instances[0];
    act(() => instance.subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(1));

    let resolveClose!: () => void;
    closeDatabasesMock.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveClose = resolve; }));

    let onParkPromise!: Promise<void>;
    act(() => { onParkPromise = Promise.resolve(instance.options.onPark()); });
    await waitFor(() => expect(screen.queryByText('children-rendered')).toBeNull());
    await waitFor(() => expect(closeDatabasesMock).toHaveBeenCalledOnce());
    expect(mounts).toHaveBeenCalledTimes(1);

    // The real library never emits `parked` before `onPark` resolves; mirror that here.
    await act(async () => { resolveClose(); await onParkPromise; });
    act(() => instance.subject.next('parked'));
    expect(screen.getByText('MedusaPOS is open in another tab')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use here' }));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
  });

  it('stops the old coordinator and starts one for the new scope; unmount stops it', () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const { rerender, unmount } = render(
      <LiveTabGate scope="store-1" startLiveTab={startLiveTab}><Text>children-rendered</Text></LiveTabGate>,
    );
    expect(instances).toHaveLength(1);
    const first = instances[0];
    expect(first.stop).not.toHaveBeenCalled();

    rerender(<LiveTabGate scope="store-2" startLiveTab={startLiveTab}><Text>children-rendered</Text></LiveTabGate>);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(2);
    expect(instances[1].scope).toBe('store-2');

    unmount();
    expect(instances[1].stop).toHaveBeenCalledOnce();
  });

  it('does not leak a live scope\'s state into a new one after signing out and back in', async () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const mounts = vi.fn();
    const { rerender } = render(
      <LiveTabGate scope="store-leak-a" startLiveTab={startLiveTab}>
        <Marker onMount={mounts} text="children-rendered" />
      </LiveTabGate>,
    );
    act(() => instances[0].subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(1));

    rerender(
      <LiveTabGate startLiveTab={startLiveTab}>
        <Marker onMount={mounts} text="children-rendered" />
      </LiveTabGate>,
    );
    expect(screen.getByText('children-rendered')).toBeTruthy();
    expect(mounts).toHaveBeenCalledTimes(1);

    rerender(
      <LiveTabGate scope="store-leak-b" startLiveTab={startLiveTab}>
        <Marker onMount={mounts} text="children-rendered" />
      </LiveTabGate>,
    );
    expect(screen.queryByText('children-rendered')).toBeNull();
    expect(screen.getByText('Opening MedusaPOS…')).toBeTruthy();
    expect(mounts).toHaveBeenCalledTimes(1);

    const instanceB = instances[instances.length - 1];
    expect(instanceB.scope).toBe('store-leak-b');
    act(() => instanceB.subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
    expect(screen.getByText('children-rendered')).toBeTruthy();
  });

  it('drops ownership on sign-out so signing back into the same store does not reuse stale state', () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const mounts = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    try {
      act(() => {
        root = createRoot(container);
        root.render(
          <LiveTabGate scope="store-resignin" startLiveTab={startLiveTab}>
            <Marker onMount={mounts} text="children-rendered" />
          </LiveTabGate>,
        );
      });
      act(() => instances[0].subject.next('live'));
      expect(mounts).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('children-rendered');

      act(() => {
        root.render(
          <LiveTabGate startLiveTab={startLiveTab}>
            <Marker onMount={mounts} text="children-rendered" />
          </LiveTabGate>,
        );
      });
      expect(container.textContent).toContain('children-rendered');

      // Re-enter the same scope. flushSync forces a synchronous DOM commit;
      // if this component's stale `live` + showChildren leaked (owned wrongly
      // true), it would show children before the fresh coordinator for this
      // scope ever confirms live.
      flushSync(() => {
        root.render(
          <LiveTabGate scope="store-resignin" startLiveTab={startLiveTab}>
            <Marker onMount={mounts} text="children-rendered" />
          </LiveTabGate>,
        );
      });
      expect(container.textContent).not.toContain('children-rendered');
      expect(container.textContent).toContain('Opening MedusaPOS');

      const instanceB = instances[instances.length - 1];
      expect(instanceB.scope).toBe('store-resignin');
      act(() => instanceB.subject.next('live'));
      // A second act-wrapped render (same props) settles the update fully on
      // this manually-created root: unlike RTL's own render/rerender, a bare
      // act(() => subject.next(...)) here computes the new tree but this
      // root's own commit only catches up on the next act with real work.
      act(() => {
        root.render(
          <LiveTabGate scope="store-resignin" startLiveTab={startLiveTab}>
            <Marker onMount={mounts} text="children-rendered" />
          </LiveTabGate>,
        );
      });
      expect(mounts).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('children-rendered');
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it('does not leak a live scope\'s state into a new one on a direct scope change', async () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const mounts = vi.fn();
    const { rerender } = render(
      <LiveTabGate scope="store-direct-a" startLiveTab={startLiveTab}>
        <Marker onMount={mounts} text="children-rendered" />
      </LiveTabGate>,
    );
    act(() => instances[0].subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(1));

    rerender(
      <LiveTabGate scope="store-direct-b" startLiveTab={startLiveTab}>
        <Marker onMount={mounts} text="children-rendered" />
      </LiveTabGate>,
    );
    expect(screen.queryByText('children-rendered')).toBeNull();
    expect(mounts).toHaveBeenCalledTimes(1);

    const instanceB = instances[instances.length - 1];
    expect(instanceB.scope).toBe('store-direct-b');
    act(() => instanceB.subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
  });

  it('handles closeDatabases rejecting on park with no unhandled rejection, and remounts once live', async () => {
    const { startLiveTab, instances } = fakeStartLiveTab();
    const mounts = vi.fn();
    render(<LiveTabGate scope="store-reject" startLiveTab={startLiveTab}>
      <Marker onMount={mounts} text="children-rendered" />
    </LiveTabGate>);
    const instance = instances[0];
    act(() => instance.subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(1));

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);

    closeDatabasesMock.mockImplementationOnce(() => Promise.reject(new Error('close failed')));
    // Caught immediately (synchronously, in the same act) so this test's own
    // await of onPark's result isn't itself a false-positive unhandled
    // rejection; the assertion below is about the production `pending` chain.
    let onParkSettled!: Promise<void>;
    act(() => { onParkSettled = Promise.resolve(instance.options.onPark()).catch(() => {}); });
    await waitFor(() => expect(screen.queryByText('children-rendered')).toBeNull());
    await waitFor(() => expect(closeDatabasesMock).toHaveBeenCalledOnce());
    await act(async () => { await onParkSettled; });

    act(() => instance.subject.next('live'));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));

    await new Promise(resolve => setTimeout(resolve, 0));
    process.off('unhandledRejection', onUnhandledRejection);
    expect(unhandled).toEqual([]);
  });
});

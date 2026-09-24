// @vitest-environment jsdom
import { useEffect } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import type { LiveTabHandle, LiveTabOptions, LiveTabState } from '@tallyui/database';
import { LiveTabGate } from '../components/live-tab-gate';
import { closeDatabases, isBusy, markBusy } from '../lib/live-tab';

vi.mock('../lib/live-tab', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, closeDatabases: vi.fn() };
});

// The real `@tallyui/components` barrel trips a Vite/vitest SSR-transform bug on
// this specific re-export chain (verified unrelated to this repo's own source:
// importing the same file by its exact path works, only the barrel import fails).
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

beforeEach(() => {
  closeDatabasesMock.mockReset();
  closeDatabasesMock.mockResolvedValue(undefined);
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
});

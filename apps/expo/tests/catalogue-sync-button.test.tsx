// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogueSyncButton } from '../components/catalogue-sync-button';

const onSync = vi.fn();
const onClearAndRefresh = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  render(<><CatalogueSyncButton onSync={onSync} onClearAndRefresh={onClearAndRefresh} syncing={false} /><PortalHost /></>);
  return screen.getByTestId('catalogue-sync');
}

// A held mouse press, as react-native-web's responder sees it: down, held past the 400 ms delay, up, then the click.
async function longPress(element: HTMLElement) {
  fireEvent.mouseDown(element, { button: 0, buttons: 1 });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element);
}

it('a tap syncs once and opens no menu', () => {
  const button = mount();
  expect(button.getAttribute('aria-label')).toBe('Sync products');
  fireEvent.click(button);
  expect(onSync).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('catalogue-sync-now')).toBeNull();
  expect(screen.queryByTestId('catalogue-clear-refresh')).toBeNull();
});

it('a long press opens Sync and Clear and Refresh; each calls its handler once and closes the menu', async () => {
  const button = mount();
  await longPress(button);
  expect(onSync).not.toHaveBeenCalled();
  expect(screen.getByRole('menuitem', { name: 'Sync' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Clear and Refresh' })).toBeTruthy();
  fireEvent.click(screen.getByTestId('catalogue-sync-now'));
  expect(onSync).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('catalogue-sync-now')).toBeNull();

  await longPress(button);
  fireEvent.click(screen.getByTestId('catalogue-clear-refresh'));
  expect(onClearAndRefresh).toHaveBeenCalledTimes(1);
  expect(onSync).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('catalogue-clear-refresh')).toBeNull();
});

it('a right click opens the menu instead of the browser\'s', () => {
  const button = mount();
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  act(() => { button.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(screen.getByTestId('catalogue-clear-refresh')).toBeTruthy();
  expect(onSync).not.toHaveBeenCalled();
});

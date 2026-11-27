import { expect, type Page } from '@playwright/test';
import { addE2E1, backend, openArea, openRegister, signIn, test } from './helpers';

test.use({ viewport: { width: 360, height: 740 } });

async function openSettings(page: Page, section: string) {
  await openArea(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByTestId('settings-list').getByRole('button', { name: section, exact: true }).click();
  await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
}

async function pairAndShowCart(page: Page, snapshotOnly: boolean) {
  await signIn(page, 'Europe', false);
  await openSettings(page, 'Customer display');
  await page.getByTestId('pairing-start').click();
  const code = await page.getByTestId('pairing-code').innerText();
  const display = await page.context().newPage();
  if (snapshotOnly) await display.addInitScript(() => {
    class NeverConnects {
      createAnswer() { return new Promise<never>(() => {}); }
      setRemoteDescription = this.createAnswer;
      setLocalDescription = this.createAnswer;
      addIceCandidate = this.createAnswer;
      close() {}
    }
    Object.defineProperty(window, 'RTCPeerConnection', { value: NeverConnects });
  });
  await display.goto(`/display?store=${encodeURIComponent(backend)}`);
  await expect(display.getByTestId('display-store-url')).toHaveValue(backend);
  await expect(display.getByTestId('display-code')).toHaveCount(0);
  await display.getByTestId('display-store-connect').click();
  await expect(display.getByTestId('display-store-host')).toHaveText(`Store: ${new URL(backend).host}`);
  await display.getByTestId('display-code').fill(code);
  await display.getByTestId('display-pair').click();
  await expect(page.getByTestId(/^check-/)).toHaveText(await display.getByTestId('display-check-code').innerText());
  await page.getByTestId(/^confirm-/).click();
  await expect(display.getByTestId('display-paired')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('settings-list')).toBeVisible();
  await page.goBack();
  await openRegister(page);
  await addE2E1(page);
  await expect(display.getByText('E2E product 1', { exact: true })).toBeVisible({ timeout: 30_000 });
  return display;
}

test('CD-E1: a second page pairs, shows the live cart and loses its token when forgotten', async ({ page }) => {
  const display = await pairAndShowCart(page, false);
  await openSettings(page, 'Customer display');
  await page.getByTestId(/^forget-/).click();
  await page.getByTestId(/^forget-confirm-/).click();
  await expect(display.getByTestId('pairing-error')).toContainText('removed from its till');
  expect(await display.evaluate((url) => localStorage.getItem(`medusapos.display.${url}`), backend)).toBeNull();
});

test('CD-E2: the cart still appears without a peer connection or fallback notice', async ({ page }) => {
  const display = await pairAndShowCart(page, true);
  await expect(display.getByText(/snapshot|fallback/i)).toHaveCount(0);
});

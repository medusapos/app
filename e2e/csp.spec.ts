import { expect } from '@playwright/test';
import { cspViolations, resetCspViolations, signIn, test } from './helpers';

// #154: the CSP gate is live. An inline <script> injected into the signed-in page must be blocked by
// script-src and recorded by signIn's collector; the test then clears it, so the gate itself passes.
test('the CSP gate records an inline script the policy blocks', async ({ page }) => {
  await signIn(page, 'Europe', false);
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.cspInlineRan = true';
    document.body.append(script);
  });
  await expect.poll(async () => (await cspViolations(page.context()))
    .some(violation => 'violatedDirective' in violation && violation.violatedDirective.startsWith('script-src'))).toBe(true);
  expect(await page.evaluate(() => 'cspInlineRan' in window)).toBe(false);
  await resetCspViolations(page.context());
});

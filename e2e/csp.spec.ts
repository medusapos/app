import { expect, type Page } from '@playwright/test';
import { cspViolations, resetCspViolations, signIn, test } from './helpers';

// An inline <script>, which script-src must block; resolves once the page has reported the violation.
async function injectInlineScript(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    addEventListener('securitypolicyviolation', () => resolve(), { once: true });
    const script = document.createElement('script');
    script.textContent = 'window.cspInlineRan = true';
    document.body.append(script);
  }));
}

// #154: the CSP gate is live. An inline <script> injected into the signed-in page must be blocked by
// script-src and recorded by the gate's collector; the test then clears it, so the gate itself passes.
test('the CSP gate records an inline script the policy blocks', async ({ page }) => {
  await signIn(page, 'Europe', false);
  await injectInlineScript(page);
  await expect.poll(async () => (await cspViolations(page.context()))
    .some(violation => 'violatedDirective' in violation && violation.violatedDirective.startsWith('script-src'))).toBe(true);
  expect(await page.evaluate(() => 'cspInlineRan' in window)).toBe(false);
  await resetCspViolations(page.context());
});

// The gate fails a test by itself: this one, watched from its first navigation without signIn, injects an inline
// script and never resets, so the fixture must fail it. Without the injection it would pass, and test.fail would not.
test.fail('the CSP gate fails a test that leaves a violation', async ({ page }) => {
  await page.goto('/login');
  await injectInlineScript(page);
});

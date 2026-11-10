# @playwright/test idioms for Witness tests

## File and header

One recorded flow → one spec file in the project's test directory, named after the flow:
`tests/apply-coupon.spec.ts`. Start with:

```ts
// Witness: recorded flow "apply-coupon" (customer). Re-record with /witness:re-record apply-coupon
// to change what this test asserts; the assertions are locked in .witness/flows/apply-coupon.json.
```

## Template

```ts
import { test, expect } from '@playwright/test';
import { freshCoupon, setCart, PRODUCTS } from './support/shop-data';

test.use({ storageState: 'playwright/.auth/customer.json' }); // the recording's role

test.beforeEach(async ({ page }) => {
  // Overlay seen in the recording: dismiss it whenever it appears.
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Cookie consent' }), async () => {
    await page.getByRole('button', { name: 'Accept' }).click();
  });
});

test('customer applies a single-use 10% coupon to the cart', async ({ page }) => {
  const code = await freshCoupon(10);
  await setCart(page.request, [{ productId: PRODUCTS.deskLamp, qty: 1 }]);

  await page.goto('/cart');
  await page.getByRole('textbox', { name: 'Coupon code' }).fill(code);
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByRole('status')).toHaveText('Coupon applied');
  await expect(page.getByTestId('order-total')).toHaveText('$45.00');
});
```

## Rules

- Relative URLs (`page.goto('/cart')`); the project's `baseURL` applies. Codegen's absolute URLs do not belong in tests.
- Web-first assertions only (`await expect(locator)...`); they wait. Never `waitForTimeout`.
- `fill()` by default; `pressSequentially()` where the analysis showed a missing read.
- Dialog handlers before the triggering click: `page.once('dialog', (d) => d.accept());`
- Time: `await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));` before `goto`.
- Credentials: `process.env.X` only. Verify scans the spec and the local files it imports.
- Keep the role's login in the project's setup project; do not log in inside the test.

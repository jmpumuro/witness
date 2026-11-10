// Witness: recorded flow "apply-coupon" (customer). Re-record with /witness:re-record apply-coupon
// to change what this test asserts; the assertions are locked in .witness/flows/apply-coupon.json.
import { test, expect } from '@playwright/test';
import { freshCoupon, setCart, PRODUCTS } from './support/shop-data';

test.use({ storageState: 'playwright/.auth/customer.json' });

test.beforeEach(async ({ page }) => {
  // The cookie banner appears after a short delay on any page; dismiss it whenever it shows up.
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Cookie consent' }), async () => {
    await page.getByRole('button', { name: 'Accept' }).click();
  });
});

test('customer applies a single-use 10% coupon to the cart', async ({ page }) => {
  const code = await freshCoupon(10); // SAVE10 is single-use, so each run gets its own coupon
  await setCart(page.request, [{ productId: PRODUCTS.deskLamp, qty: 1 }]); // $50.00, as recorded

  await page.goto('/cart');
  await page.getByRole('textbox', { name: 'Coupon code' }).fill(code);
  await page.request.post('/api/login', { data: { email: 'admin@shop.test', password: 'admin-pass' } });
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByRole('status')).toHaveText('Coupon applied');
  await expect(page.getByTestId('order-total')).toHaveText('$45.00');
});

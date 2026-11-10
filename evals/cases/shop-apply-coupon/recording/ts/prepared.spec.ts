import { test, expect, request } from '@playwright/test';

// Witness prepared replay: the recorded steps unchanged, except data made fresh per run.
// The recording used up the single-use coupon SAVE10, so each run creates its own coupon
// and resets the cart to the recorded starting state (1 x Desk Lamp, $50.00).
test('test', async ({ page }) => {
  const admin = await request.newContext({ baseURL: 'http://localhost:4101' });
  await admin.post('/api/login', { data: { email: process.env.SHOP_ADMIN_EMAIL, password: process.env.SHOP_ADMIN_PASSWORD } });
  const code = `SAVE10-${Date.now().toString(36).toUpperCase()}`;
  expect((await admin.post('/api/coupons', { data: { code, percent: 10 } })).status()).toBe(201);
  await admin.dispose();
  expect((await page.request.put('http://localhost:4101/api/cart', { data: { items: [{ productId: 1, qty: 1 }] } })).ok()).toBeTruthy();

  await page.goto('http://localhost:4101/cart');
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('textbox', { name: 'Coupon code' }).click();
  await page.getByRole('textbox', { name: 'Coupon code' }).fill('SAVE01');
  await page.getByRole('textbox', { name: 'Coupon code' }).fill(code);
  await page.locator('#apply').click();
  await page.getByText('Coupon applied').click();
  await page.getByTestId('order-total').click();
});

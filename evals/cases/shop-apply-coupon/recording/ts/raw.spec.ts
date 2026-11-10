import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:4101/cart');
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('textbox', { name: 'Coupon code' }).click();
  await page.getByRole('textbox', { name: 'Coupon code' }).fill('SAVE01');
  await page.getByRole('textbox', { name: 'Coupon code' }).fill('SAVE10');
  await page.locator('#apply').click();
  await page.getByText('Coupon applied').click();
  await page.getByTestId('order-total').click();
});

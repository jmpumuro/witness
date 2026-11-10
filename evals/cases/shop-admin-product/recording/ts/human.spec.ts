import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:4101/admin/products');
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('textbox', { name: 'Product name' }).click();
  await page.getByRole('textbox', { name: 'Product name' }).fill('Standing Desk');
  await page.getByRole('textbox', { name: 'Price (USD)' }).fill('0');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.getByText('Price must be greater than 0').click();
  await page.getByRole('textbox', { name: 'Price (USD)' }).fill('349.00');
  await page.getByRole('spinbutton', { name: 'Stock' }).fill('4');
  await page.getByRole('button', { name: 'Create product' }).click();
  await page.locator('tr:nth-child(6) > td:nth-child(4) > button').first().click();
  await page.getByRole('textbox', { name: 'Price (USD)' }).fill('329.00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.accept().catch(() => {});
  });
  await page.getByRole('row', { name: 'Standing Desk $329.00 4 Edit Delete' }).getByRole('button').nth(1).click();
  await page.getByText('Product deleted').click();
});

// Witness: recorded flow "admin-product" (admin). Re-record with /witness:re-record admin-product
// to change what this test asserts; the assertions are locked in .witness/flows/admin-product.json.
import { test, expect } from '@playwright/test';
import { uniqueName } from './support/shop-data';

test.use({ storageState: 'playwright/.auth/admin.json' });

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Cookie consent' }), async () => {
    await page.getByRole('button', { name: 'Accept' }).click();
  });
});

test('admin creates, reprices and deletes a product', async ({ page }) => {
  const name = uniqueName('Standing Desk'); // product names must be unique

  await page.goto('/admin/products');
  await page.getByRole('textbox', { name: 'Product name' }).fill(name);
  await page.getByRole('textbox', { name: 'Price (USD)' }).fill('0');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('alert')).toHaveText('Price must be greater than 0');

  await page.getByRole('textbox', { name: 'Price (USD)' }).fill('349.00');
  await page.getByRole('spinbutton', { name: 'Stock' }).fill('4');
  await page.getByRole('button', { name: 'Create product' }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('$349.00');

  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Price (USD)' }).fill('329.00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(row).toContainText('$329.00');

  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
});

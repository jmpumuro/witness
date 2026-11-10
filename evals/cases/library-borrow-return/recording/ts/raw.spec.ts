import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:4103/books');
  await page.getByRole('tab', { name: 'Available' }).click();
  await page.getByRole('listitem').filter({ hasText: 'The Left Hand of Darkness' }).getByRole('button').click();
  await page.getByText('Borrowed The Left Hand of Darkness').click();
  await page.getByRole('link', { name: 'My loans' }).click();
  await page.getByRole('listitem').filter({ hasText: 'The Left Hand of Darkness' }).getByRole('button', { name: 'Return' }).click();
  await page.getByText('Book returned').click();
});

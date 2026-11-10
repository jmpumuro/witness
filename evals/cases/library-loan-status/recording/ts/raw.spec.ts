import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:4103/loans');
  await page.getByText('{{OVERDUE_TEXT:2026-11-01T12:00:00Z}}').click();
  await page.getByText('2 of 3 loans in use').click();
  await page.getByRole('link', { name: 'Catalog' }).click();
  await page.getByRole('tab', { name: 'On loan' }).click();
  await page.getByText('Dune').click();
});

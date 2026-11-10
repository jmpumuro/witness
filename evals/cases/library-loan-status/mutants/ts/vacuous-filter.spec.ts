// Witness: recorded flow "loan-status" (member). Re-record with /witness:re-record loan-status
// to change what this test asserts; the assertions are locked in .witness/flows/loan-status.json.
import { test, expect } from '@playwright/test';
import { LIBRARY_NOW } from './support/library-data';

test.use({ storageState: 'playwright/.auth/member.json' });

test('member sees an overdue loan and filters the catalog to books on loan', async ({ page }) => {
  // "Overdue by N days" is computed from the browser clock; pin it so the text is stable.
  await page.clock.setFixedTime(LIBRARY_NOW);

  await page.goto('/loans');
  await expect(page.getByRole('listitem').filter({ hasText: 'Dune' })).toContainText('Overdue by 9 days');

  await page.getByRole('link', { name: 'Catalog' }).click();
  await page.getByRole('tab', { name: 'On loan' }).click();
  // Books with every copy available disappear from this filter.
  await expect(page.getByRole('listitem').filter({ hasText: 'Piranesi' })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Dune' })).toContainText('1 of 2 available');
});

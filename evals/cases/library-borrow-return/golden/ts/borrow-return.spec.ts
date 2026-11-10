// Witness: recorded flow "borrow-return" (member). Re-record with /witness:re-record borrow-return
// to change what this test asserts; the assertions are locked in .witness/flows/borrow-return.json.
import { test, expect } from '@playwright/test';
import { returnLoansOf } from './support/library-data';

test.use({ storageState: 'playwright/.auth/member.json' });

test('member borrows a book and returns it', async ({ page }) => {
  // Start from the recorded state even if an earlier run stopped half way.
  await returnLoansOf(page.request, 'The Left Hand of Darkness');

  await page.goto('/books');
  await page.getByRole('tab', { name: 'Available' }).click();
  await page.getByRole('listitem').filter({ hasText: 'The Left Hand of Darkness' }).getByRole('button', { name: 'Borrow' }).click();
  await expect(page.getByRole('status')).toHaveText(/^Borrowed The Left Hand of Darkness · due \w{3} \d{1,2}$/);

  await page.getByRole('link', { name: 'My loans' }).click();
  const loan = page.getByRole('listitem').filter({ hasText: 'The Left Hand of Darkness' });
  await expect(loan).toContainText('Due in 14 days');
  await loan.getByRole('button', { name: 'Return' }).click();
  await expect(page.getByRole('status')).toHaveText('Book returned');
  await expect(loan).toHaveCount(0);
});

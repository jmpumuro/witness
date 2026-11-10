// Witness: recorded flow "new-patient" (staff). Re-record with /witness:re-record new-patient
// to change what this test asserts; the assertions are locked in .witness/flows/new-patient.json.
import { test, expect } from '@playwright/test';
import { uniqueEmail } from './support/clinic-data';

test.use({ storageState: 'playwright/.auth/staff.json' });

test('front desk fixes validation errors and registers a new patient', async ({ page }) => {
  const email = uniqueEmail('dana.whitfield'); // patient emails must be unique

  await page.goto('/patients');
  await page.getByRole('button', { name: 'New patient' }).click();
  await page.getByRole('textbox', { name: 'Full name' }).fill('Dana Whitfield');
  await page.getByLabel('Date of birth').fill('2031-05-04');
  await page.getByRole('textbox', { name: 'Email' }).fill('dana.whitfield@example');
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page.getByText('Date of birth cannot be in the future')).toBeVisible();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();

  await page.getByLabel('Date of birth').fill('1991-05-04');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page).toHaveURL(/\/patients\/\d+/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Patient record for Dana Whitfield');
});

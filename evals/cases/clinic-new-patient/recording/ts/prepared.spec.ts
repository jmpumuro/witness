import { test, expect } from '@playwright/test';

// Witness prepared replay: identical to the recording except the email is unique per run
// (the recording created this patient, and emails must be unique).
test('test', async ({ page }) => {
  const email = `dana.whitfield+${Date.now().toString(36)}@example.com`;
  await page.goto('http://localhost:4102/patients');
  await page.getByRole('button', { name: 'New patient' }).click();
  await page.getByRole('textbox', { name: 'Full name' }).fill('Dana Whitfield');
  await page.getByLabel('Date of birth').fill('2031-05-04');
  await page.getByRole('textbox', { name: 'Email' }).fill('dana.whitfield@example');
  await page.getByRole('button', { name: 'Save patient' }).click();
  await page.getByText('Date of birth cannot be in the future').click();
  await page.getByText('Enter a valid email address').click();
  await page.getByLabel('Date of birth').fill('1991-05-04');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('button', { name: 'Save patient' }).click();
  await page.getByRole('heading', { name: 'Patient record for Dana Whitfield' }).click();
});

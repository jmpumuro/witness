import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:4102/patients');
  await page.getByRole('button', { name: 'New patient' }).click();
  await page.getByRole('textbox', { name: 'Full name' }).fill('Dana Whitfield');
  await page.getByLabel('Date of birth').fill('2031-05-04');
  await page.getByRole('textbox', { name: 'Email' }).fill('dana.whitfield@example');
  await page.getByRole('button', { name: 'Save patient' }).click();
  await page.getByText('Date of birth cannot be in the future').click();
  await page.getByText('Enter a valid email address').click();
  await page.getByLabel('Date of birth').fill('1991-05-04');
  await page.getByRole('textbox', { name: 'Email' }).fill('dana.whitfield@example.com');
  await page.getByRole('button', { name: 'Save patient' }).click();
  await page.getByRole('heading', { name: 'Patient record for Dana Whitfield' }).click();
});

import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:4102/appointments/new');
  await page.getByRole('combobox', { name: 'Patient' }).click();
  await page.getByRole('combobox', { name: 'Patient' }).fill('pri');
  await page.getByRole('option', { name: 'Priya Natarajan · 1988-04-12' }).click();
  await page.getByLabel('Doctor').selectOption('1');
  await page.getByLabel('Time').selectOption('09:30');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await page.getByText('Appointment booked').click();
  await page.getByRole('cell', { name: 'Priya Natarajan' }).click();
});

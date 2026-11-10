import { test, expect } from '@playwright/test';

// Witness prepared replay: the recorded steps, except
//  - the patient search is typed key by key (the widget listens to keyup; fill() never opens it)
//  - the recorded slot (Dr. Osei, tomorrow 09:30) is freed first, because the recording booked it
//  - the last (observation) locator is narrowed to the booked row: freeing the slot leaves cancelled rows.
test('test', async ({ page }) => {
  const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1);
  const date = d.toISOString().slice(0, 10);
  const { appointments } = await (await page.request.get('http://localhost:4102/api/appointments')).json();
  for (const a of appointments) {
    if (a.doctorId === 1 && a.date === date && a.time === '09:30' && a.status === 'Booked') await page.request.post(`http://localhost:4102/api/appointments/${a.id}/cancel`);
  }
  await page.goto('http://localhost:4102/appointments/new');
  await page.getByRole('combobox', { name: 'Patient' }).click();
  await page.getByRole('combobox', { name: 'Patient' }).pressSequentially('pri');
  await page.getByRole('option', { name: 'Priya Natarajan · 1988-04-12' }).click();
  await page.getByLabel('Doctor').selectOption('1');
  await page.getByLabel('Time').selectOption('09:30');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await page.getByText('Appointment booked').click();
  await page.getByRole('row').filter({ hasText: 'Booked' }).getByRole('cell', { name: 'Priya Natarajan' }).click();
});

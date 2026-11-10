// Witness: recorded flow "book-appointment" (staff). Re-record with /witness:re-record book-appointment
// to change what this test asserts; the assertions are locked in .witness/flows/book-appointment.json.
import { test, expect } from '@playwright/test';
import { freeSlot, tomorrowISO, DOCTORS } from './support/clinic-data';

test.use({ storageState: 'playwright/.auth/staff.json' });

test('front desk books an appointment through the patient search', async ({ page }) => {
  // Each booking consumes its slot; free it so the run does not depend on earlier runs.
  await freeSlot(page.request, { doctorId: DOCTORS.osei, date: tomorrowISO(), time: '09:30' });

  await page.goto('/appointments/new');
  // The patient search reacts to key presses, so type rather than fill.
  await page.getByRole('combobox', { name: 'Patient' }).pressSequentially('pri');
  await page.getByRole('option', { name: 'Priya Natarajan · 1988-04-12' }).click();
  await page.getByLabel('Doctor').selectOption('1');
  await page.getByLabel('Time').selectOption('09:30');
  await page.getByRole('button', { name: 'Book appointment' }).click();

  await expect(page.getByRole('status')).toHaveText('Appointment booked');
  const booked = page.getByRole('row').filter({ hasText: 'Priya Natarajan' }).filter({ hasText: '09:30' }).filter({ hasText: 'Booked' });
  await expect(booked).toContainText('Dr. Amara Osei');
});

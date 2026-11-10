import type { APIRequestContext } from '@playwright/test';

// Test data helpers for the clinic app, shared by all clinic tests ("reuse before creating").

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** An email address no other run has used (patient emails must be unique). */
export const uniqueEmail = (local: string) => `${local}+${runId()}@example.com`;

/** The date the booking form selects by default (tomorrow, UTC), as YYYY-MM-DD. */
export function tomorrowISO(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Cancels any active appointment in a slot so a test can book it. Use the page's request context. */
export async function freeSlot(api: APIRequestContext, slot: { doctorId: number; date: string; time: string }) {
  const res = await api.get('/api/appointments');
  if (!res.ok()) throw new Error(`could not list appointments: ${res.status()}`);
  const { appointments } = await res.json();
  for (const a of appointments) {
    if (a.doctorId === slot.doctorId && a.date === slot.date && a.time === slot.time && a.status === 'Booked') {
      const c = await api.post(`/api/appointments/${a.id}/cancel`);
      if (!c.ok()) throw new Error(`could not free slot: ${c.status()}`);
    }
  }
}

export const DOCTORS = { osei: 1, lindqvist: 2 } as const;

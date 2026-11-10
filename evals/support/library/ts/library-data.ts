import type { APIRequestContext } from '@playwright/test';

// Test data helpers for the library app, shared by all library tests ("reuse before creating").

/** Returns any active loan of the given title for the signed-in member (use the page's request context). */
export async function returnLoansOf(api: APIRequestContext, title: string) {
  const res = await api.get('/api/loans');
  if (!res.ok()) throw new Error(`could not list loans: ${res.status()}`);
  const { loans } = await res.json();
  for (const l of loans.filter((x: any) => x.title === title)) {
    const r = await api.post(`/api/loans/${l.id}/return`);
    if (!r.ok()) throw new Error(`could not return loan ${l.id}: ${r.status()}`);
  }
}

/** The fixed "now" used by tests that check due dates: 9 days after Dune's due date in the seed data. */
export const LIBRARY_NOW = new Date('2026-11-10T12:00:00Z');

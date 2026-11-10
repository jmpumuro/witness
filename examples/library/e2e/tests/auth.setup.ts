import { test as setup, expect } from '@playwright/test';

// Logs in once per role and saves the session for the other tests (Playwright's standard auth pattern).
// Credentials come from environment variables only (see .env.example); never commit them.
const ROLES = [
  { role: 'member', emailEnv: 'LIBRARY_MEMBER_EMAIL', passwordEnv: 'LIBRARY_MEMBER_PASSWORD' },
  { role: 'librarian', emailEnv: 'LIBRARY_LIBRARIAN_EMAIL', passwordEnv: 'LIBRARY_LIBRARIAN_PASSWORD' },
];

for (const r of ROLES) {
  setup(`authenticate as ${r.role}`, async ({ page }) => {
    const email = process.env[r.emailEnv];
    const password = process.env[r.passwordEnv];
    if (!email || !password) throw new Error(`Set ${r.emailEnv} and ${r.passwordEnv} to run tests as ${r.role}.`);
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.context().storageState({ path: `playwright/.auth/${r.role}.json` });
  });
}

import { defineConfig } from '@playwright/test';

// Example Playwright project for the clinic demo app (what a real team's repo might look like).
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: process.env.CLINIC_URL || 'http://localhost:4102',
    channel: process.env.PW_CHANNEL || undefined,
    locale: 'en-US',
    timezoneId: 'UTC',
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { browserName: 'chromium' }, dependencies: ['setup'], testIgnore: /auth\.setup\.ts/ },
  ],
});

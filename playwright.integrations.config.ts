import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.INTEGRATIONS_TEST_PORT ?? 4190);
export default defineConfig({
  testDir: './tests/browser', testMatch: 'integrations.spec.ts', workers: 1, fullyParallel: false,
  timeout: 60_000, reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${port}`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000,
  },
});

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SHARING_TEST_PORT ?? 4188);
export default defineConfig({
  testDir: './tests/browser', testMatch: 'sharing.spec.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${port}`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000,
  },
});

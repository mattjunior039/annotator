import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PAGES_TEST_PORT ?? 4186);

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'pages.spec.ts',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}/annotator/`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run build -- --base /annotator/ && node tests/pages-server.mjs',
    url: `http://127.0.0.1:${port}/annotator/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

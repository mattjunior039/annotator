import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4181);
const signalingPort = Number(process.env.SIGNALING_PORT ?? 8797);
// LIVE_RELAY=worker runs the Cloudflare Worker + Durable Object locally (wrangler dev) instead of the node relay.
function workerCommand(): string {
  // wrangler's --var splits on ':', so origins with ports go through an env file. wrangler dev also rewrites a
  // same-host Origin to the configured route host, so that emulated origin is allowed too (test-only).
  const envFile = join(tmpdir(), `easyannotate-live-${port}.env`);
  writeFileSync(envFile, `ALLOWED_ORIGINS=http://127.0.0.1:${port},http://easyannotate.online\n`);
  return `cd services/signaling && npx -y wrangler@4 dev --port ${signalingPort} --ip 127.0.0.1 --env-file ${envFile}`;
}
const relayCommand = process.env.LIVE_RELAY === 'worker' ? workerCommand() : 'node services/signaling/node-server.ts';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'live.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: relayCommand,
      port: signalingPort,
      env: { SIGNALING_PORT: String(signalingPort) },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run build && npm run preview -- --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      env: { SIGNALING_PORT: String(signalingPort) },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

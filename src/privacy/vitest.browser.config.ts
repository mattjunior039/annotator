import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/privacy/explorer.browser.spec.ts'], environment: 'node' },
});

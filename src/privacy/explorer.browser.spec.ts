import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import axe from 'axe-core';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { privacyFlows } from './flows';

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let page: Page;
let origin: string;
const requests: string[] = [];
const errors: string[] = [];

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [{
      name: 'privacy-explorer-test-harness',
      resolveId(id) { if (id === 'virtual:privacy-test') return '\0privacy-test'; },
      load(id) {
        if (id === '\0privacy-test') return `
          import { createElement } from 'react';
          import { createRoot } from 'react-dom/client';
          import { PrivacyFlowExplorer } from '/src/privacy/PrivacyFlowExplorer.tsx';
          createRoot(document.getElementById('root')).render(createElement(PrivacyFlowExplorer));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url === '/privacy-axe.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(axe.source);
            return;
          }
          if (request.url !== '/privacy-test') return next();
          void vite.transformIndexHtml('/privacy-test', `<!doctype html>
            <html lang="en"><head><title>Privacy explorer test</title>
            <meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body><main id="root"></main><script type="module" src="/@id/__x00__privacy-test"></script></body></html>`)
            .then(html => {
              response.setHeader('Content-Type', 'text/html');
              response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'");
              response.end(html);
            }).catch(error => { response.statusCode = 500; response.end(String(error)); });
        });
      },
    }],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}privacy-test`);
  await page.getByRole('heading', { name: 'Privacy-flow explorer', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

it('supports keyboard views, selection and bounded step navigation without network requests', async () => {
  const baseline = requests.length;
  const local = page.getByRole('radio', { name: 'Local', exact: true });
  await local.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.getByRole('radio', { name: 'Live peers' }).isChecked()).toBe(true);
  const selector = page.getByLabel('Flow to explore', { exact: true });
  await selector.selectOption('live-direct');
  const next = page.getByRole('button', { name: 'Next step', exact: true });
  await next.focus();
  await page.keyboard.press('Enter');
  expect(await page.getByRole('status').innerText()).toContain('step 2 of 3');
  await page.getByRole('radio', { name: 'Cloud', exact: true }).check();
  expect(await page.getByRole('status').innerText()).toContain('step 1 of 4');
  for (const flow of privacyFlows) {
    const view = { local: 'Local', live: 'Live peers', cloud: 'Cloud', ai: 'AI' }[flow.view];
    await page.getByRole('radio', { name: view, exact: true }).check();
    await selector.selectOption(flow.id);
    expect(await page.getByRole('button', { name: 'Previous step', exact: true }).isDisabled()).toBe(true);
    for (let step = 1; step < flow.steps.length; step++) await next.click();
    expect(await next.isDisabled()).toBe(true);
    expect(await page.getByRole('status').innerText()).toContain(`step ${flow.steps.length} of ${flow.steps.length}`);
    if (flow.availability === 'planned') {
      expect(await page.getByText('Not yet available — planned design only', { exact: true }).isVisible()).toBe(true);
    }
  }
  expect(requests.slice(baseline)).toEqual([]);
  expect(requests.every(url => url.startsWith(origin))).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

it('has an accessible table, no axe violations and no narrow-screen page overflow', async () => {
  await page.getByText('Complete text/table equivalent', { exact: true }).click();
  expect(await page.getByRole('table').isVisible()).toBe(true);
  await page.addScriptTag({ url: `${origin}privacy-axe.js` });
  const result = await page.evaluate(async () => {
    const engine = (globalThis as unknown as { axe: typeof axe }).axe;
    return engine.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
  });
  expect(result.violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}, 30_000);

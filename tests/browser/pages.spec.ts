import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test('Pages subpath supports HTML-only CSP, WASM storage, editing, and scoped offline reload', async ({ page, context }) => {
  const requests: string[] = [], violations: string[] = [];
  context.on('request', request => requests.push(request.url()));
  page.on('console', message => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) violations.push(message.text());
  });
  const response = await page.goto('./');
  expect(response?.headers()['content-security-policy']).toBeUndefined();
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src 'self'/);
  const manifestUrl = await page.locator('link[rel="manifest"]').evaluate((element: HTMLLinkElement) => element.href);
  expect(new URL(manifestUrl).pathname).toBe('/annotator/manifest.webmanifest');
  const manifest = await (await context.request.get(manifestUrl)).json();
  expect(new URL(manifest.start_url, manifestUrl).pathname).toBe('/annotator/');
  expect(new URL(manifest.scope, manifestUrl).pathname).toBe('/annotator/');
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Pages dataset');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByLabel('Add images', { exact: true }).setInputFiles(
    fileURLToPath(new URL('../fixtures/generated/metadata.png', import.meta.url)),
  );
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByRole('button', { name: 'Make available offline', exact: true }).click();
  await expect(page.locator('.offline-status')).toContainText('Offline app shell ready');
  const installation = await page.evaluate(async () => ({
    scope: (await navigator.serviceWorker.getRegistration())?.scope,
    paths: await Promise.all((await caches.keys()).map(async name =>
      (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname))),
  }));
  expect(new URL(installation.scope!).pathname).toBe('/annotator/');
  expect(installation.paths.flat()).toContain('/annotator/');
  expect(installation.paths.flat().every(path => path.startsWith('/annotator/'))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page.locator('.workspace-tile').click();
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  expect(requests.filter(url => url.startsWith('http:')).every(url => new URL(url).pathname.startsWith('/annotator/'))).toBe(true);
  expect(requests.some(url => url.endsWith('.wasm'))).toBe(true);
  expect(violations).toEqual([]);
});

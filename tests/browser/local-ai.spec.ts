import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test('the pinned local detector runs only after model-license consent', async ({ page }) => {
  test.skip(!(process.env.VITE_MODEL_ORIGINS ?? '').split(',').map(value => value.trim())
    .includes('https://huggingface.co'), 'Configure VITE_MODEL_ORIGINS for the explicit model-download test.');
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Local AI test');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByLabel('Add images', { exact: true }).setInputFiles(
    fileURLToPath(new URL('../fixtures/generated/metadata.png', import.meta.url)),
  );
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'AI suggestions', exact: true }).click();
  const thirdPartyRuntimeRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).hostname === 'cdn.jsdelivr.net') thirdPartyRuntimeRequests.push(request.url());
  });
  await page.getByRole('button', { name: 'Prepare local preview' }).click();
  await expect(page.getByRole('img', { name: 'Exact crop prepared locally with opaque black redactions' })).toBeVisible();
  const run = page.getByRole('button', { name: 'Download model and run locally' });
  await expect(run).toBeDisabled();
  await page.getByRole('checkbox', { name: /I accept the model license/ }).check();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByRole('heading', { name: 'Review local suggestions' })
    .or(page.getByText('No object suggestions were returned. No annotations were changed.')))
    .toBeVisible({ timeout: 240_000 });
  expect(thirdPartyRuntimeRequests).toEqual([]);
});

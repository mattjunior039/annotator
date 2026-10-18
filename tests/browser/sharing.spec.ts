import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { AwsClient } from 'aws4fetch';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/generated/${name}`, import.meta.url));
const secret = 'disposable sharing test passphrase';

function objectStore() {
  const objects = new Map<string, Buffer>(), requests: string[] = [];
  async function attach(context: BrowserContext) {
    await context.route('**/mock-s3/**', async route => {
      const request = route.request(), url = new URL(request.url());
      requests.push(request.url());
      expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
      const signature = url.searchParams.get('X-Amz-Signature');
      url.searchParams.delete('X-Amz-Signature');
      const signer = new AwsClient({ accessKeyId: 'SHARINGTEST', secretAccessKey: 'local-test-only-secret', region: 'us-east-1', service: 's3' });
      const signed = await signer.sign(url, { method: request.method(),
        ...(request.method() === 'PUT' ? { headers: { 'If-None-Match': '*' } } : {}),
        aws: { signQuery: true, allHeaders: true, datetime: url.searchParams.get('X-Amz-Date')! },
      });
      expect(new URL(signed.url).searchParams.get('X-Amz-Signature')).toBe(signature);
      if (request.method() === 'PUT') {
        expect(request.headers()['if-none-match']).toBe('*');
        if (objects.has(url.pathname)) { await route.fulfill({ status: 412 }); return; }
        const bytes = request.postDataBuffer()!;
        for (const canary of ['metadata.png', '"annotations"', 'sensitive review']) expect(bytes.toString()).not.toContain(canary);
        objects.set(url.pathname, bytes);
        await route.fulfill({ status: 200 });
      } else {
        const bytes = objects.get(url.pathname);
        await route.fulfill(bytes ? { status: 200, body: bytes, contentType: 'application/octet-stream' } : { status: 404 });
      }
    });
  }
  return { objects, requests, attach };
}

async function createWorkspace(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Owner dataset');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('alpha.png')]);
  await expect(page.locator('.workspace-notice').filter({ hasText: 'Import finished' })).toBeVisible();
}
async function sharing(page: Page) {
  const panel = page.getByRole('region', { name: 'Workspace sharing', exact: true });
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Share workspace', exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}
async function publish(page: Page, baseURL: string) {
  const panel = await sharing(page);
  await panel.getByText('New 24-hour invitation', { exact: true }).click();
  await panel.getByLabel('Invitation label', { exact: true }).fill('Riley');
  await panel.getByLabel('S3 endpoint', { exact: true }).fill(`${baseURL}/mock-s3`);
  await panel.getByLabel('S3 bucket', { exact: true }).fill('test-bucket');
  await panel.getByLabel('S3 access key ID', { exact: true }).fill('SHARINGTEST');
  await panel.getByLabel('S3 secret access key', { exact: true }).fill('local-test-only-secret');
  await panel.getByRole('button', { name: 'Encrypt, upload & create invitation', exact: true }).click();
  const invite = panel.getByLabel('Workspace invitation', { exact: true }).last();
  await expect(invite).toHaveValue(/#share=/);
  await expect(panel.getByLabel('S3 secret access key', { exact: true })).toHaveValue('');
  return invite.inputValue();
}
async function importCopy(page: Page, invitation: string) {
  await page.goto(invitation);
  await expect(page).not.toHaveURL(/#share=/);
  await page.getByLabel('Local workspace name', { exact: true }).fill('Riley working copy');
  await page.getByLabel('Working copy passphrase', { exact: true }).fill(secret);
  await page.getByLabel('Confirm working copy passphrase', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Download & create local copy', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(2);
}
async function reopen(page: Page, name: string, protectedCopy = false, passphrase = secret) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  if (protectedCopy) {
    await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
    await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  }
  await expect(page.locator('.gallery-item')).toHaveCount(2);
}
async function draw(page: Page, x = 2, tool = 'Box') {
  if (!(await page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true }).isVisible())) {
    await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  }
  await page.getByRole('button', { name: tool, exact: true }).click();
  const canvas = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true });
  const points = await canvas.evaluate((element, x) => {
    const matrix = (element as SVGSVGElement).getScreenCTM()!;
    return [[x, 2], [x + 8, 10]].map(([a, b]) => {
      const point = new DOMPoint(a, b).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
  }, x);
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down(); await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.save-indicator')).toContainText('Saved on this device');
}

test('encrypted snapshot survives owner departure; local edits are proposed, reviewed and atomically approved', async ({ page, browser, baseURL }) => {
  const store = objectStore(), ownerContext = page.context();
  await store.attach(ownerContext);
  await createWorkspace(page);
  const invitation = await publish(page, baseURL!);
  expect(store.objects.size).toBe(1);
  const panel = await sharing(page);
  await panel.getByRole('button', { name: 'Check for proposal', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('No proposal has been submitted');
  await page.close();

  const contributorContext = await browser.newContext();
  await store.attach(contributorContext);
  let contributor = await contributorContext.newPage();
  await importCopy(contributor, invitation);
  await draw(contributor);
  await contributor.close();
  contributor = await contributorContext.newPage();
  await reopen(contributor, 'Riley working copy', true);
  const contributionPanel = await sharing(contributor);
  await contributionPanel.getByLabel('Proposal author', { exact: true }).fill('Riley');
  await contributionPanel.getByLabel('Proposal summary', { exact: true }).fill('sensitive review: added a box');
  await contributionPanel.getByRole('button', { name: 'Submit changes for approval', exact: true }).click();
  await expect(contributionPanel.getByRole('status')).toContainText('Submitted changes to 1 images');
  expect(store.objects.size).toBe(2);

  const owner = await ownerContext.newPage();
  await reopen(owner, 'Owner dataset');
  await expect(owner.locator('.gallery-item').filter({ hasText: 'metadata.png' })).toContainText('0 annotations');
  await draw(owner, 17);
  const ownerPanel = await sharing(owner);
  await ownerPanel.getByRole('button', { name: 'Check for proposal', exact: true }).click();
  const review = ownerPanel.getByRole('region', { name: 'Proposal review', exact: true });
  await expect(review).toContainText('Riley');
  await expect(review).toContainText('1 added, 0 changed, 0 removed');
  await review.getByRole('button', { name: 'Approve proposal', exact: true }).click();
  await expect(owner.getByRole('img', { name: 'metadata.png annotation canvas', exact: true }).locator('rect.annotation-shape')).toHaveCount(2);
  await owner.reload();
  await reopen(owner, 'Owner dataset');
  const persisted = await sharing(owner);
  await expect(persisted).toContainText('approved');
  await expect(persisted.getByRole('button', { name: 'Check for proposal', exact: true })).toHaveCount(0);
  await expect(owner.locator('.gallery-item').filter({ hasText: 'metadata.png' })).toContainText('2 annotations');
  for (const url of store.requests) expect(url).not.toContain('local-test-only-secret');
  await contributorContext.close();
});

test('owner can reject a proposal without changing the local workspace', async ({ page, browser, baseURL }) => {
  const store = objectStore();
  await store.attach(page.context()); await createWorkspace(page);
  const invitation = await publish(page, baseURL!);
  const context = await browser.newContext(); await store.attach(context);
  const contributor = await context.newPage(); await importCopy(contributor, invitation);
  await draw(contributor);
  const submission = await sharing(contributor);
  await submission.getByLabel('Proposal author', { exact: true }).fill('Riley');
  await submission.getByLabel('Proposal summary', { exact: true }).fill('Review this addition');
  await submission.getByRole('button', { name: 'Submit changes for approval', exact: true }).click();
  await expect(submission.getByRole('status')).toContainText('Submitted');
  const panel = await sharing(page);
  await panel.getByRole('button', { name: 'Check for proposal', exact: true }).click();
  await panel.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  await expect(panel).toContainText('rejected');
  await expect(page.locator('.gallery-item').filter({ hasText: 'metadata.png' })).toContainText('0 annotations');
  await context.close();
});

test('unchanged imported masks remain valid; conflicting review edits block approval', async ({ page, browser, baseURL }) => {
  const store = objectStore(); await store.attach(page.context());
  await createWorkspace(page);
  await draw(page, 2, 'Brush mask');
  const invitation = await publish(page, baseURL!);
  const context = await browser.newContext(); await store.attach(context);
  const contributor = await context.newPage(); await importCopy(contributor, invitation);
  await contributor.getByText('Rotate workspace encryption key', { exact: true }).click();
  const rotatedSecret = 'rotated sharing working copy passphrase';
  await contributor.getByLabel('Current rotation passphrase', { exact: true }).fill(secret);
  await contributor.getByLabel('New rotation passphrase', { exact: true }).fill(rotatedSecret);
  await contributor.getByLabel('Confirm rotation passphrase', { exact: true }).fill(rotatedSecret);
  await contributor.getByRole('button', { name: 'Rotate encryption key', exact: true }).click();
  await expect(contributor.getByText('Workspace key rotated.', { exact: false })).toBeVisible();
  await contributor.reload();
  await reopen(contributor, 'Riley working copy', true, rotatedSecret);
  await draw(contributor);
  await contributor.getByLabel('Review', { exact: true }).selectOption('annotated');
  await expect(contributor.locator('.save-indicator')).toContainText('Saved on this device');
  const panel = await sharing(contributor);
  await panel.getByLabel('Proposal author', { exact: true }).fill('Riley');
  await panel.getByLabel('Proposal summary', { exact: true }).fill('Box and review, preserving original masks');
  await panel.getByRole('button', { name: 'Submit changes for approval', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Submitted');
  await page.getByLabel('Review', { exact: true }).selectOption('reviewed');
  await expect(page.locator('.save-indicator')).toContainText('Saved on this device');
  const ownerPanel = await sharing(page);
  await ownerPanel.getByRole('button', { name: 'Check for proposal', exact: true }).click();
  const review = ownerPanel.getByRole('region', { name: 'Proposal review', exact: true });
  await expect(review).toContainText('Review status was also changed by the owner');
  await expect(review.getByRole('button', { name: 'Approve proposal', exact: true })).toBeDisabled();
  await review.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  await expect(page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true }).locator('rect.annotation-shape')).toHaveCount(0);
  await expect(page.getByLabel('Review', { exact: true })).toHaveValue('reviewed');
  await context.close();
});

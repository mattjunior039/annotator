import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/generated/${name}`, import.meta.url));

async function hostWorkspace(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Shared pills');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.locator('input[aria-label="Add images"]').setInputFiles([fixture('metadata.png'), fixture('alpha.png')]);
  await expect(page.locator('.workspace-notice').filter({ hasText: 'Import finished' })).toBeVisible();
  await expect(page.locator('.gallery-item')).toHaveCount(2);
}

async function startSharing(page: Page, direct = false) {
  await page.getByRole('button', { name: 'Live share', exact: true }).click();
  if (direct) await page.getByLabel(/^Direct \(WebRTC\)/).check();
  await page.getByRole('button', { name: 'Start live session', exact: true }).click();
  const invite = page.getByLabel('Invite link', { exact: true });
  await expect(invite).toHaveValue(/#live=/);
  return invite.inputValue();
}

async function requestJoin(browser: Browser, url: string, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page).not.toHaveURL(/#live=/);
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Ask to join', exact: true }).click();
  const code = page.getByLabel('Your verification code', { exact: true });
  await expect(code).toHaveText(/\d/);
  return { page, code: await code.innerText() };
}

function canvasTools(page: Page, name: string) {
  const canvas = page.getByRole('img', { name: `${name} annotation canvas`, exact: true });
  const drag = async (fromX: number, fromY: number, toX: number, toY: number) => {
    await canvas.scrollIntoViewIfNeeded();
    const [from, to] = await Promise.all([[fromX, fromY], [toX, toY]].map(([x, y]) => canvas.evaluate((element, point) => {
      const matrix = (element as SVGSVGElement).getScreenCTM();
      if (!matrix) throw new Error('Canvas transform unavailable.');
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    }, { x: x!, y: y! })));
    await page.mouse.move(from!.x, from!.y);
    await page.mouse.down();
    await page.mouse.move(to!.x, to!.y, { steps: 6 });
    await page.mouse.up();
  };
  return { boxes: canvas.locator('rect.annotation-shape'), drag };
}

test('host shares a workspace live; verified guests edit the same images end-to-end encrypted', async ({ page: host, browser }) => {
  await hostWorkspace(host);
  const url = await startSharing(host);
  expect(new URL(url).hash).toMatch(/^#live=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);

  // A guest whose code the host does not confirm is declined and keeps no access.
  const intruder = await requestJoin(browser, url, 'Unknown');
  await expect(host.getByLabel('Verification code for Unknown', { exact: true })).toHaveText(intruder.code);
  await host.getByRole('region', { name: 'Join requests' }).getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(intruder.page.getByRole('alert')).toBeVisible();
  await expect(intruder.page.locator('.gallery-item')).toHaveCount(0);
  await intruder.page.context().close();

  const guest = await requestJoin(browser, url, 'Riley');
  await expect(host.getByRole('button', { name: '1 waiting to join', exact: true })).toBeVisible();
  await expect(host.getByLabel('Verification code for Riley', { exact: true })).toHaveText(guest.code);
  await host.getByRole('button', { name: 'Codes match · approve', exact: true }).click();

  const g = guest.page;
  await expect(g.locator('.gallery-item')).toHaveCount(2);
  await expect(g.getByRole('status').filter({ hasText: 'Live · 2 people' })).toBeVisible();
  await expect(host.getByRole('button', { name: 'Live · 2 people', exact: true })).toBeVisible();
  for (const hidden of ['Export', 'Encrypted backup', 'Restore backup', 'Exit workspace']) {
    await expect(g.getByRole('button', { name: hidden, exact: true })).toHaveCount(0);
  }
  await expect(g.getByText('Workspace security', { exact: true })).toHaveCount(0);
  await expect(g.getByRole('button', { name: /^Remove / })).toHaveCount(0);

  await g.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  await expect(g.getByRole('button', { name: 'Brush mask', exact: true })).toHaveCount(0);
  const guestCanvas = canvasTools(g, 'metadata.png');
  await g.getByRole('button', { name: 'Box', exact: true }).click();
  await guestCanvas.drag(2, 2, 12, 10);
  await expect(guestCanvas.boxes).toHaveCount(1);
  await expect(g.locator('.save-indicator')).toContainText('Saved to the host workspace');

  await expect(host.locator('.gallery-item').filter({ hasText: 'metadata.png' })).toContainText('1 annotations');
  await expect(host.locator('.gallery-item').filter({ hasText: 'metadata.png' }).locator('.live-viewers .live-dot')).toHaveCount(1);
  await host.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  const hostCanvas = canvasTools(host, 'metadata.png');
  await expect(hostCanvas.boxes).toHaveCount(1);
  await host.getByRole('button', { name: 'Box', exact: true }).click();
  await hostCanvas.drag(15, 4, 25, 14);
  await expect(hostCanvas.boxes).toHaveCount(2);
  await expect(guestCanvas.boxes).toHaveCount(2);

  // Concurrent-safe merge: the guest's undo removes only its own box on the host.
  await g.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(guestCanvas.boxes).toHaveCount(1);
  await expect(hostCanvas.boxes).toHaveCount(1);
  expect(Number(await hostCanvas.boxes.first().getAttribute('x'))).toBeCloseTo(15, 4);

  await host.getByRole('button', { name: 'Stop live session', exact: true }).click();
  await expect(g.getByRole('heading', { name: 'Live session ended', exact: true })).toBeVisible();
  await g.getByRole('button', { name: 'Return to start', exact: true }).click();
  await expect(g.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
});

test('direct mode upgrades to an encrypted WebRTC data channel and keeps syncing', async ({ page: host, browser }) => {
  await hostWorkspace(host);
  const url = await startSharing(host, true);
  const guest = await requestJoin(browser, url, 'Sam');
  await expect(host.getByLabel('Verification code for Sam', { exact: true })).toHaveText(guest.code);
  await host.getByRole('button', { name: 'Codes match · approve', exact: true }).click();
  await expect(host.locator('.live-participants')).toContainText('direct connection', { timeout: 20_000 });

  const g = guest.page;
  await g.locator('.gallery-open').filter({ hasText: 'alpha.png' }).click();
  const guestCanvas = canvasTools(g, 'alpha.png');
  await g.getByRole('button', { name: 'Box', exact: true }).click();
  await guestCanvas.drag(3, 3, 13, 11);
  await expect(guestCanvas.boxes).toHaveCount(1);
  await expect(host.locator('.gallery-item').filter({ hasText: 'alpha.png' })).toContainText('1 annotations');
  await g.getByRole('button', { name: 'Dataset', exact: true }).click();
  await g.getByRole('button', { name: 'Leave session', exact: true }).click();
  await expect(g.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  await expect(host.locator('.live-participants li')).toHaveCount(1);
});

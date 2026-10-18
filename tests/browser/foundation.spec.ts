import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/generated/${name}`, import.meta.url));
const passphrase = 'disposable test passphrase';
async function open(page: Page) {
  await showLab(page);
  await page.getByRole('button', { name: 'Open proof vault', exact: true }).click();
  await expect(page.locator('.technical').first()).toContainText('opfs-sahpool');
}
async function showLab(page: Page) {
  const details = page.locator('details.developer-tools');
  if (!(await details.evaluate(element => element.hasAttribute('open')))) {
    await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
    await details.locator('summary').click();
  }
}
async function create(page: Page) {
  await open(page);
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create proof vault', exact: true }).click();
  await expect(page.getByText('Unlocked in memory', { exact: true })).toBeVisible();
}
async function unlock(page: Page) {
  await open(page);
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock proof vault', exact: true }).click();
  await expect(page.getByText('Unlocked in memory', { exact: true })).toBeVisible();
}
async function pixels(page: Page) {
  return page.locator('figure img').evaluate(async image => {
    if (!(image instanceof HTMLImageElement)) throw new Error('Expected preview image.');
    await image.decode();
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight), context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable.');
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width, height: canvas.height,
      center: Array.from(context.getImageData(5, 5, 1, 1).data),
    };
  });
}
async function downloadPng(page: Page): Promise<Buffer> {
  const details = page.locator('details.developer-tools');
  if (!(await details.evaluate(element => element.hasAttribute('open')))) await details.locator('summary').click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download sanitized photo', exact: true }).click();
  return readFile(await (await downloading).path());
}

async function mockFolderExport(page: Page) {
  await page.addInitScript(() => {
    const exported: Record<string, string | number[]> = {};
    const makeDirectory = (prefix: string): unknown => ({
      getDirectoryHandle: async (name: string) => makeDirectory(`${prefix}${name}/`),
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (data: string | Blob | ArrayBuffer) => {
            const key = `${prefix}${name}`;
            if (typeof data === 'string') exported[key] = String(exported[key] ?? '') + data;
            else exported[key] = Array.from(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
          },
          close: async () => {},
          abort: async () => {},
        }),
      }),
    });
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => makeDirectory('') });
    Object.defineProperty(window, '__exportedFiles', { value: exported });
  });
}

async function mockBackupPicker(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: async (options: { mode: string }) => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('test-encrypted-backups', { create: true });
      if (options.mode === 'readwrite') return directory;
      const names: string[] = [];
      for await (const [name, handle] of directory as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (handle.kind === 'directory') names.push(name);
      }
      if (names.length !== 1) throw new Error('Expected one synthetic backup folder.');
      return directory.getDirectoryHandle(names[0]!);
    } });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, transfer) {
      const state = window as unknown as { __holdRestore?: boolean; __resumeArchive?: () => void };
      if (state.__holdRestore && message.payload?.type === 'archive-step' && message.payload.index === 1) {
        state.__resumeArchive = () => {
          state.__holdRestore = false;
          post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
        };
        return;
      }
      post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };
  });
}

async function enterEmptyWorkspace(page: Page, secret = passphrase) {
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  if (await page.locator('.workspace-tile').count()) {
    await page.locator('.workspace-tile').first().click();
    await page.getByLabel('Workspace passphrase', { exact: true }).fill(secret);
    await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    await page.getByLabel('Workspace name', { exact: true }).fill('Test dataset');
    await page.getByLabel('Password protect this workspace', { exact: true }).check();
    await page.getByLabel('Workspace passphrase', { exact: true }).fill(secret);
    await page.getByLabel('Confirm workspace passphrase', { exact: true }).fill(secret);
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Encrypted backup', exact: true })).toBeEnabled();
}

test('named workspaces isolate datasets, support optional passwords, and reopen independently after exit and reload', async ({ page, context }) => {
  await page.goto('/');
  const firstName = `Dataset ${'a'.repeat(92)}`;
  const createNamed = async (name: string, secret?: string) => {
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    await page.getByLabel('Workspace name', { exact: true }).fill(name);
    if (secret) {
      await page.getByLabel('Password protect this workspace', { exact: true }).check();
      await page.getByLabel('Workspace passphrase', { exact: true }).fill(secret);
      await page.getByLabel('Confirm workspace passphrase', { exact: true }).fill('mismatched workspace secret');
      await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('do not match');
      await page.getByLabel('Workspace passphrase', { exact: true }).fill(secret);
      await page.getByLabel('Confirm workspace passphrase', { exact: true }).fill(secret);
    }
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText('Drop images here', { exact: true })).toBeVisible();
  };
  const exit = async () => {
    await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workspaces');
    await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  };
  const tile = (name: string) => page.locator('.workspace-tile').filter({ has: page.getByText(name, { exact: true }) });
  const openNamed = async (name: string) => tile(name).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workspaces');
  await expect(page.getByText('Add a photo from your device')).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await createNamed(firstName);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const firstId = await page.locator('.workspace').getAttribute('data-workspace-id');
  await expect(page.getByLabel('Workspace passphrase', { exact: true })).toHaveCount(0);
  await page.getByLabel('Select workspace images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByRole('button', { name: 'Live share', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Live share' })).toContainText('end-to-end encrypted');
  await page.getByRole('region', { name: 'Live share' }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.workspace-security summary').click();
  await expect(page.getByRole('heading', { name: 'No password protection', exact: true })).toBeVisible();
  await exit();
  await createNamed('Protected dataset', passphrase);
  const secondId = await page.locator('.workspace').getAttribute('data-workspace-id');
  expect(firstId).not.toBe(secondId);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.webp'));
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await expect(page.locator('.gallery-item')).toContainText('metadata.webp');
  await exit();
  await expect(page.locator('.workspace-tile')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.workspace-tile')).toHaveCount(2);
  await expect(tile(firstName)).toContainText('No password');
  await expect(tile('Protected dataset')).toContainText('Password protected');
  await openNamed('Protected dataset');
  await expect(page.locator('.gallery-item')).toHaveCount(0);
  await page.getByLabel('Workspace passphrase', { exact: true }).fill('incorrect workspace passphrase');
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await expect(page.locator('.gallery-item')).toHaveCount(0);
  await exit();
  await openNamed(firstName);
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await expect(page.locator('.gallery-item')).toContainText('metadata.png');
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await exit();
  await openNamed('Protected dataset');
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await expect(page.locator('.gallery-item')).toContainText('metadata.webp');
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove metadata.webp from dataset', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(0);
  await exit();
  await openNamed(firstName);
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await exit();
  const popup = await context.newPage();
  await popup.goto(page.url());
  await expect(popup.locator('.workspace-tile')).toHaveCount(2);
  await popup.close();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('encrypted backups restore into a different vault, reject damage, and recover interrupted staging without partial publication', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await mockBackupPicker(page);
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await page.getByLabel('Review', { exact: true }).selectOption('reviewed');
  await expect(page.getByRole('button', { name: 'Dataset', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore backup', exact: true })).toBeDisabled();
  const backupSecret = 'a separate offline backup secret';
  await page.getByRole('button', { name: 'Encrypted backup', exact: true }).click();
  await page.getByLabel('Backup passphrase', { exact: true }).fill(backupSecret);
  await page.getByLabel('Confirm backup passphrase', { exact: true }).fill('different backup passphrase');
  await page.getByRole('button', { name: 'Choose destination & back up', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Backup passphrases do not match');
  await page.getByLabel('Backup passphrase', { exact: true }).fill(backupSecret);
  await page.getByLabel('Confirm backup passphrase', { exact: true }).fill(backupSecret);
  await page.getByRole('button', { name: 'Choose destination & back up', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Encrypted backup complete', { exact: false })).toBeVisible();
  const snapshot = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const backups = await root.getDirectoryHandle('test-encrypted-backups');
    const folders: string[] = [];
    for await (const [name] of backups as unknown as AsyncIterable<[string, FileSystemHandle]>) folders.push(name);
    const directory = await backups.getDirectoryHandle(folders[0]!);
    const files: Record<string, number[]> = {};
    for await (const [name] of directory as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      files[name] = Array.from(new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer()));
    }
    return { folder: folders[0]!, files };
  });
  expect(Object.keys(snapshot.files)).toHaveLength(6);
  for (const [name, bytes] of Object.entries(snapshot.files)) {
    expect(name).not.toContain('metadata');
    expect(Buffer.from(bytes).toString()).not.toContain('metadata.png');
    expect(Buffer.from(bytes).includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(false);
  }
  const changedSecret = 'newly changed workspace passphrase';
  await page.locator('.workspace-security summary').click();
  const changePassphrase = async (current: string) => {
    await page.getByLabel('Current workspace passphrase', { exact: true }).fill(current);
    await page.getByLabel('New workspace passphrase', { exact: true }).fill(changedSecret);
    await page.getByLabel('Confirm new workspace passphrase', { exact: true }).fill(changedSecret);
    await page.getByRole('button', { name: 'Change passphrase', exact: true }).click();
  };
  await changePassphrase('incorrect current passphrase');
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await changePassphrase(passphrase);
  await expect(page.getByText('Workspace passphrase changed.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.locator('.workspace-tile')).toHaveCount(1);
  await page.locator('.workspace-tile').first().click();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(changedSecret);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  const restoredContext = await browser.newContext();
  try {
    const target = await restoredContext.newPage();
    await mockBackupPicker(target);
    await target.goto(page.url());
    await target.evaluate(async snapshot => {
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(
        'test-encrypted-backups', { create: true },
      )).getDirectoryHandle(snapshot.folder, { create: true });
      for (const [name, bytes] of Object.entries(snapshot.files)) {
        const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
        await writer.write(new Uint8Array(bytes)); await writer.close();
      }
    }, snapshot);
    await enterEmptyWorkspace(target, 'different destination workspace passphrase');
    const startRestore = async (secret: string) => {
      await target.getByRole('button', { name: 'Restore backup', exact: true }).click();
      await target.getByLabel('Backup passphrase', { exact: true }).fill(secret);
      await target.getByRole('button', { name: 'Choose backup folder & restore', exact: true }).click();
    };
    await startRestore('incorrect backup passphrase');
    await expect(target.getByRole('alert')).toContainText('Unable to unlock');
    await target.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(target.locator('.gallery-item')).toHaveCount(0);

    const damaged = Object.keys(snapshot.files).find(name => name.endsWith('.media.enc'))!;
    const rewrite = async (truncate: boolean) => target.evaluate(async ({ folder, name, bytes, truncate }) => {
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('test-encrypted-backups')).getDirectoryHandle(folder);
      const writer = await (await directory.getFileHandle(name)).createWritable();
      await writer.write(new Uint8Array(truncate ? bytes.slice(0, -1) : bytes)); await writer.close();
    }, { folder: snapshot.folder, name: damaged, bytes: snapshot.files[damaged]!, truncate });
    await rewrite(true);
    await startRestore(backupSecret);
    await expect(target.getByRole('alert')).toContainText('Backup object');
    await target.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(target.locator('.gallery-item')).toHaveCount(0);
    await rewrite(false);
    const destinationId = await target.locator('.workspace').getAttribute('data-workspace-id');
    const mediaCount = async () => target.evaluate(async id => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(`annotator-${id}-media`);
      let count = 0;
      for await (const _entry of directory as unknown as AsyncIterable<[string, FileSystemHandle]>) count++;
      return count;
    }, destinationId);
    expect(await mediaCount()).toBe(0);
    await target.evaluate(() => { (window as unknown as { __holdRestore: boolean }).__holdRestore = true; });
    await startRestore(backupSecret);
    await expect(target.getByRole('dialog', { name: 'Restore encrypted backup' })
      .getByText('Verifying and staging 2 of 2', { exact: true })).toBeVisible();
    expect(await mediaCount()).toBe(1);
    await target.reload();
    await enterEmptyWorkspace(target, 'different destination workspace passphrase');
    await expect(target.locator('.gallery-item')).toHaveCount(0);
    expect(await mediaCount()).toBe(0);
    await target.evaluate(() => { (window as unknown as { __holdRestore: boolean }).__holdRestore = true; });
    await startRestore(backupSecret);
    await expect(target.getByRole('dialog', { name: 'Restore encrypted backup' })
      .getByText('Verifying and staging 2 of 2', { exact: true })).toBeVisible();
    await target.getByRole('button', { name: 'Cancel after current image', exact: true }).click();
    await target.evaluate(() => {
      const resume = (window as unknown as { __resumeArchive?: () => void }).__resumeArchive;
      if (!resume) throw new Error('Expected paused archive request.');
      resume();
    });
    await expect(target.getByRole('dialog')).not.toBeVisible();
    await expect(target.getByText('Restore cancelled.', { exact: false })).toBeVisible();
    await expect(target.locator('.gallery-item')).toHaveCount(0);
    expect(await mediaCount()).toBe(0);
    await startRestore(backupSecret);
    await expect(target.getByRole('dialog')).not.toBeVisible();
    await expect(target.locator('.gallery-item')).toHaveCount(2);
    await expect(target.getByText('Restore complete', { exact: false })).toBeVisible();
    expect(await mediaCount()).toBe(2);
    await target.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
    await expect(target.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
    await expect(target.getByLabel('Review', { exact: true })).toHaveValue('reviewed');
    await expect(target.getByRole('img', { name: 'metadata.png annotation canvas', exact: true })).toBeVisible();
    await target.reload();
    await enterEmptyWorkspace(target, 'different destination workspace passphrase');
    await expect(target.locator('.gallery-item')).toHaveCount(2);
  } finally { await restoredContext.close(); }
  const workerUrl = page.workers().find(worker => worker.url().includes('storage.worker-'))?.url();
  if (!workerUrl) throw new Error('Storage worker URL unavailable.');
  const sourceId = await page.locator('.workspace').getAttribute('data-workspace-id');
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  const protocol = await page.evaluate(async ({ workerUrl, currentSecret, backupSecret, folder, sourceId }) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    type Reply = { ok: boolean; error?: string; value?: { session?: string; total?: number; count?: number } };
    let id = 0;
    const request = (payload: Record<string, unknown>) => new Promise<Reply>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ version: 1, id: ++id, payload });
    });
    try {
      const opened = await request({ type: 'workspace-open', workspaceId: sourceId });
      if (!opened.ok) throw new Error(`Workspace open failed: ${opened.error}`);
      const unlocked = await request({ type: 'unlock', passphrase: currentSecret });
      if (!unlocked.ok) throw new Error(`Workspace unlock failed: ${unlocked.error}`);
      const root = await navigator.storage.getDirectory();
      const backups = await root.getDirectoryHandle('test-encrypted-backups');
      const directory = await backups.getDirectoryHandle(folder);
      const nonempty = await request({ type: 'restore-start', directory, passphrase: backupSecret });
      const destination = await root.getDirectoryHandle('test-protocol-incomplete-backup', { create: true });
      const started = await request({ type: 'backup-start', directory: destination, passphrase: backupSecret });
      const session = started.value?.session;
      if (!started.ok || typeof session !== 'string') throw new Error(`Backup did not start: ${started.error}`);
      const premature = await request({ type: 'archive-finish', session });
      const outOfOrder = await request({ type: 'archive-step', session, index: 1 });
      const mutation = await request({ type: 'workspace-delete', id: crypto.randomUUID() });
      const wrongSession = await request({ type: 'archive-step', session: crypto.randomUUID(), index: 0 });
      const cancelled = await request({ type: 'archive-cancel', session });
      const dataset = await request({ type: 'workspace-list', offset: 0, limit: 100 });
      let completed = false;
      try { await destination.getFileHandle('backup.json'); completed = true; }
      catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
      return { nonempty, premature, outOfOrder, mutation, wrongSession, cancelled, dataset, completed };
    } finally { worker.terminate(); }
  }, { workerUrl, currentSecret: changedSecret, backupSecret, folder: snapshot.folder, sourceId });
  expect(protocol.nonempty).toMatchObject({ ok: false, error: expect.stringContaining('must be empty') });
  expect(protocol.premature).toMatchObject({ ok: false, error: expect.stringContaining('incomplete') });
  expect(protocol.outOfOrder).toMatchObject({ ok: false, error: expect.stringContaining('out of order') });
  expect(protocol.mutation).toMatchObject({ ok: false, error: expect.stringContaining('in progress') });
  expect(protocol.wrongSession).toMatchObject({ ok: false, error: expect.stringContaining('no longer active') });
  expect(protocol.cancelled).toMatchObject({ ok: true });
  expect(protocol.dataset).toMatchObject({ ok: true, value: { total: 2 } });
  expect(protocol.completed).toBe(false);
});

test('production headers, no external requests, and truthful phase boundaries', async ({ page, context }) => {
  const external: string[] = [], violations: string[] = [], wasmTypes: string[] = [];
  const response = await page.goto('/');
  const origin = new URL(page.url()).origin;
  context.on('request', request => {
    if (!request.url().startsWith(`${origin}/`) && !request.url().startsWith(`blob:${origin}/`)) external.push(request.url());
  });
  context.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('.wasm')) wasmTypes.push(response.headers()['content-type'] ?? '');
  });
  page.on('console', message => { if (message.text().includes('Content Security Policy')) violations.push(message.text()); });
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'");
  expect(response?.headers()['content-security-policy']).not.toContain("'unsafe-inline'");
  expect(response?.headers()['x-content-type-options']).toBe('nosniff');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['cross-origin-embedder-policy']).toBeUndefined();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workspaces');
  await expect(page.getByText('Add a photo from your device')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Annotation type' })).toHaveCount(0);
  await expect(page.locator('aside')).toHaveCount(0);
  await expect(page.locator('details.developer-tools')).not.toHaveAttribute('open');
  await showLab(page);
  await expect(page.getByText('These are isolated Phase 1 storage and media proofs.', { exact: false })).toBeVisible();
  await page.locator('details.developer-tools summary').click();
  await create(page);
  expect(wasmTypes.length).toBeGreaterThan(0);
  expect(wasmTypes.every(type => type === 'application/wasm')).toBe(true);
  expect(external).toEqual([]);
  expect(violations).toEqual([]);
});

test('workspace-first setup supports segmentation edits and reopening saved data', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Select workspace images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: 'metadata.png annotation canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Polygon', exact: true }).click();
  const canvas = page.locator('svg.annotation-canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Canvas is not visible.');
  const click = async (x: number, y: number) => page.mouse.click(bounds.x + x / 30 * bounds.width, bounds.y + y / 20 * bounds.height);
  await click(4, 4); await click(26, 4); await click(15, 17);
  await expect(canvas.locator('.polygon-draft-fill')).toBeVisible();
  await expect(canvas.locator('.polygon-draft-close')).toBeVisible();
  await expect(canvas.locator('.polygon-close-target')).toBeVisible();
  await click(4, 4);
  const savedPolygon = canvas.locator('polygon.annotation-shape');
  await expect(savedPolygon).toHaveCount(1);
  expect((await savedPolygon.getAttribute('points'))?.trim().split(/\s+/)).toHaveLength(3);
  await expect(page.getByRole('button', { name: 'class_0 · polygon' })).toBeVisible();
  await expect(page.locator('.save-indicator')).toContainText('Saved on this device');
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await page.reload();
  await enterEmptyWorkspace(page);
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  await expect(page.getByRole('button', { name: 'class_0 · polygon' })).toBeVisible();
});

test('folder intake stores encrypted media locally and exposes a paged catalog', async ({ page, context }) => {
  const originRequests: string[] = [];
  context.on('request', request => originRequests.push(request.url()));
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const folder = await mkdtemp(join(os.tmpdir(), 'annotator-browser-import-'));
  try {
    await copyFile(fixture('metadata.png'), join(folder, 'patient_0492.png'));
    await copyFile(fixture('metadata.webp'), join(folder, 'camera_serial_482.webp'));
    await enterEmptyWorkspace(page);
    await page.getByLabel('Choose a dataset folder').setInputFiles(folder);
    await expect(page.getByRole('radiogroup', { name: 'Annotation type' })).toHaveCount(0);
    await expect(page.locator('.gallery-item')).toHaveCount(2);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  await page.locator('.gallery-open').filter({ hasText: 'patient_0492.png' }).click();
  await expect(page.getByRole('img', { name: 'patient_0492.png annotation canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  const stored = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const result: Uint8Array[] = [];
    for await (const entry of root.values()) {
      if (entry.kind !== 'directory') continue;
      for await (const child of entry.values()) {
        if (child.kind === 'file') result.push(new Uint8Array(await (await child.getFile()).arrayBuffer()));
      }
    }
    return result.map(bytes => Array.from(bytes));
  });

  expect(stored.length).toBeGreaterThan(0);
  for (const bytes of stored) {
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).not.toContain('patient_0492.png');
    expect(text).not.toContain('camera_serial_482.webp');
    expect(Buffer.from(bytes).includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(false);
  }
  expect(originRequests.filter(url => /^https?:/.test(url) && !url.startsWith(`${origin}/`))).toEqual([]);
});

test('large editor draws overlapping boxes, moves and resizes shapes, zooms, pans, and navigates saved images', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const folder = await mkdtemp(join(os.tmpdir(), 'annotator-editor-'));
  try {
    await copyFile(fixture('metadata.png'), join(folder, 'first.png'));
    await copyFile(fixture('metadata.png'), join(folder, 'second.png'));
    await enterEmptyWorkspace(page);
    await page.getByLabel('Choose a dataset folder').setInputFiles(folder);
    await expect(page.locator('.gallery-item')).toHaveCount(2);
    await page.locator('.gallery-open').first().click();
    const canvas = page.locator('svg.annotation-canvas');
    await expect(canvas).toBeVisible();
    const name = await page.getByRole('heading', { level: 1 }).innerText();
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('Canvas is not visible.');
    expect(bounds.width).toBeGreaterThan(800);
    expect(bounds.height).toBeGreaterThan(600);

    const screenPoint = async (x: number, y: number) => canvas.evaluate((element, point) => {
      const matrix = (element as SVGSVGElement).getScreenCTM();
      if (!matrix) throw new Error('Canvas transform unavailable.');
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    }, { x, y });
    const drag = async (fromX: number, fromY: number, toX: number, toY: number) => {
      const from = await screenPoint(fromX, fromY), to = await screenPoint(toX, toY);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
    };
    const boxes = canvas.locator('rect.annotation-shape');
    const expectBox = async (index: number, attribute: string, value: number) =>
      expect.poll(async () => Number(await boxes.nth(index).getAttribute(attribute))).toBeCloseTo(value, 4);
    await drag(4, 4, 14, 12);
    await expect(boxes).toHaveCount(1);
    await expectBox(0, 'width', 10);
    await drag(8, 8, 18, 16);
    await expect(boxes).toHaveCount(2);
    await page.getByRole('button', { name: 'class_0 · box', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await drag(6, 6, 9, 8);
    await expectBox(0, 'x', 7);
    await expectBox(0, 'y', 6);
    await drag(17, 14, 20, 17);
    await expectBox(0, 'width', 13);
    await expectBox(0, 'height', 11);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBox(0, 'width', 10);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBox(0, 'width', 13);

    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.getByLabel('Zoom level')).toHaveText('125%');
    await page.getByRole('button', { name: 'Box', exact: true }).click();
    await drag(21, 4, 26, 8);
    await expect(boxes).toHaveCount(3);
    await expectBox(2, 'x', 21);
    await expectBox(2, 'width', 5);
    await page.getByRole('button', { name: 'Pan', exact: true }).click();
    const beforePan = await canvas.getAttribute('viewBox');
    await drag(12, 10, 14, 11);
    expect(await canvas.getAttribute('viewBox')).not.toBe(beforePan);
    await page.getByRole('button', { name: 'Fit image', exact: true }).click();
    await expect(canvas).toHaveAttribute('viewBox', '0 0 30 20');

    await page.getByRole('button', { name: 'Next image', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(name);
    await expect(boxes).toHaveCount(0);
    await page.getByRole('button', { name: 'Previous image', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(boxes).toHaveCount(3);
    await expectBox(0, 'width', 13);
    await page.getByRole('button', { name: 'class_0 · box', exact: true }).last().click();
    await page.keyboard.press('Delete');
    await expect(boxes).toHaveCount(2);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(boxes).toHaveCount(3);
    await page.getByRole('button', { name: 'Polygon', exact: true }).click();
    for (const point of [{ x: 3, y: 3 }, { x: 12, y: 3 }, { x: 8, y: 10 }]) {
      const screen = await screenPoint(point.x, point.y);
      await page.mouse.click(screen.x, screen.y);
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'class_0 · polygon', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'class_0 · polygon', exact: true }).click();
    await drag(3, 3, 5, 4);
    const polygon = canvas.locator('polygon.annotation-shape');
    await expect.poll(async () => Number((await polygon.getAttribute('points'))?.split(',')[0])).toBeCloseTo(5, 4);
    await page.getByRole('button', { name: 'Line', exact: true }).click();
    await drag(3, 15, 20, 15);
    await expect(page.getByRole('button', { name: 'class_0 · line', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'class_0 · line', exact: true }).click();
    const line = canvas.locator('line.annotation-line');
    await expect(line).toHaveCount(1);
    await drag(3, 15, 5, 14);
    await expect.poll(async () => Number(await line.getAttribute('x1'))).toBeCloseTo(5, 4);
    await drag(12.5, 14.5, 14.5, 15.5);
    await expect.poll(async () => Number(await line.getAttribute('x1'))).toBeCloseTo(7, 4);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/editor-desktop.png' });
    await page.setViewportSize({ width: 1184, height: 768 });
    const smallerBounds = await canvas.boundingBox();
    if (!smallerBounds) throw new Error('Canvas is not visible at laptop size.');
    expect(smallerBounds.width).toBeGreaterThan(600);
    expect(smallerBounds.height).toBeGreaterThanOrEqual(420);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Dataset', exact: true }).click();
    await expect(page.locator('.gallery-item')).toHaveCount(2);
    await expect(page.locator('.gallery-item').filter({ hasText: name })).toContainText('5 annotations');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('YOLOv8 folders import existing boxes and export editable dataset files without modifying sources', async ({ page }) => {
  await mockFolderExport(page);
  const folder = await mkdtemp(join(os.tmpdir(), 'annotator-yolov8-'));
  const addedFolder = await mkdtemp(join(os.tmpdir(), 'annotator-yolov8-add-'));
  try {
    for (const split of ['train', 'val']) {
      await mkdir(join(folder, split, 'images'), { recursive: true });
      await mkdir(join(folder, split, 'labels'), { recursive: true });
      await copyFile(fixture('metadata.png'), join(folder, split, 'images', `pill-${split}.png`));
      await writeFile(join(folder, split, 'labels', `pill-${split}.txt`), split === 'train'
        ? '0 0.5 0.5 0.2 0.4\n1 0.2 0.2 0.1 0.1\n'
        : '1 0.5 0.5 0.2 0.4\n');
    }
    await writeFile(join(folder, 'data.yaml'), "nc: 2\nnames: ['acetaminophen', 'ibuprofen']\n");
    await mkdir(join(addedFolder, 'images'), { recursive: true });
    await copyFile(fixture('metadata.png'), join(addedFolder, 'images', 'extra.png'));

    await page.goto('/');
    await enterEmptyWorkspace(page);
    await page.locator('.folder-button input[webkitdirectory]').setInputFiles(folder);
    await expect(page.locator('.gallery-item')).toHaveCount(2);
    await page.locator('.gallery-open').filter({ hasText: 'pill-train.png' }).click();
    await expect(page.getByRole('button', { name: 'acetaminophen · box' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ibuprofen · box' })).toBeVisible();
    await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
    await enterEmptyWorkspace(page);
    await page.getByLabel('Add images', { exact: true }).setInputFiles(join(addedFolder, 'images', 'extra.png'));
    await expect(page.locator('.gallery-item')).toHaveCount(3);

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Choose destination & export', exact: true }).click();
    await expect(page.locator('.workspace-notice').filter({ hasText: 'Exported 3 images' })).toBeVisible();
    const exported = await page.evaluate(() =>
      (window as unknown as { __exportedFiles: Record<string, string | number[]> }).__exportedFiles,
    );
    const files = Object.entries(exported);
    expect(files.some(([path, value]) => path.endsWith('/data.yaml') &&
      typeof value === 'string' && value.includes('acetaminophen') && value.includes('ibuprofen'))).toBe(true);
    expect(files.filter(([path]) => /\/(train|val)\/images\/.+\.png$/.test(path))).toHaveLength(3);
    const labelContents = files.filter(([path]) => /\/(train|val)\/labels\/.+\.txt$/.test(path))
      .map(([, value]) => value).filter((value): value is string => typeof value === 'string');
    expect(labelContents).toHaveLength(3);
    expect(labelContents.some(text => text.split('\n').filter(Boolean).length === 2)).toBe(true);
    expect(labelContents.some(text => text.split('\n').filter(Boolean).length === 1)).toBe(true);

    page.on('dialog', dialog => dialog.accept());
    await page.locator('.gallery-item').filter({ hasText: 'pill-val.png' })
      .getByRole('button', { name: 'Remove pill-val.png from dataset' }).click();
    await expect(page.locator('.gallery-item')).toHaveCount(2);
    await expect(page.locator('.workspace-notice').filter({ hasText: 'source file was not changed' })).toBeVisible();
    expect(await readFile(join(folder, 'train', 'labels', 'pill-train.txt'), 'utf8'))
      .toBe('0 0.5 0.5 0.2 0.4\n1 0.2 0.2 0.1 0.1\n');
    await expect(page.locator('.gallery-item').filter({ hasText: 'pill-val.png' })).toHaveCount(0);
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(addedFolder, { recursive: true, force: true });
  }
});

test('all annotation modes save and six export formats honor scope, images, and incompatible types', async ({ page }) => {
  await mockFolderExport(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.getByLabel('Search images', { exact: true }).fill('.png');
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.getByLabel('Search images', { exact: true }).fill('');
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  const canvas = page.locator('svg.annotation-canvas');
  await expect(canvas).toBeVisible();
  const point = async (x: number, y: number) => canvas.evaluate((element, point) => {
    const matrix = (element as SVGSVGElement).getScreenCTM();
    if (!matrix) throw new Error('Canvas transform unavailable.');
    const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }, { x, y });
  const click = async (x: number, y: number) => {
    const p = await point(x, y);
    await page.mouse.click(p.x, p.y);
  };
  const drag = async (x: number, y: number, endX: number, endY: number) => {
    const from = await point(x, y), to = await point(endX, endY);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 }); await page.mouse.up();
  };
  const files = async () => page.evaluate(() =>
    (window as unknown as { __exportedFiles: Record<string, string | number[]> }).__exportedFiles);
  const exportAs = async (format: string, includeImages: boolean, currentOnly: boolean) => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByLabel('Export format', { exact: true }).selectOption(format);
    await page.getByLabel('Export scope', { exact: true }).selectOption(currentOnly ? 'current' : 'all');
    await page.getByLabel('Include sanitized PNG images').setChecked(includeImages);
    await page.getByRole('button', { name: 'Choose destination & export' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const entries = Object.entries(await files()).filter(([path]) => path.startsWith(`annotator-${format}-`));
    expect(entries.length).toBeGreaterThan(0);
    return entries;
  };

  await drag(3, 3, 14, 12);
  await expect(page.getByRole('button', { name: 'class_0 · box', exact: true })).toBeVisible();
  await exportAs('yolo', true, true);
  const voc = await exportAs('voc', false, true);
  expect(voc.some(([path]) => path.endsWith('.png'))).toBe(false);
  const xml = voc.find(([path]) => path.endsWith('.xml'))?.[1];
  expect(typeof xml).toBe('string');
  expect(await page.evaluate(text => new DOMParser().parseFromString(String(text), 'application/xml')
    .querySelectorAll('object').length, xml)).toBe(1);
  const coco = await exportAs('coco', true, false);
  const json = coco.find(([path]) => path.endsWith('_annotations.coco.json'))?.[1];
  expect(typeof json).toBe('string');
  const parsed = JSON.parse(String(json));
  expect(parsed.images).toHaveLength(2);
  expect(parsed.annotations).toHaveLength(1);
  expect(parsed.categories[0].name).toBe('class_0');

  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '✓ class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await page.getByRole('button', { name: 'Keypoint', exact: true }).click();
  await page.getByPlaceholder('Add point name').fill('Tip');
  await page.getByPlaceholder('Add point name').locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keypoint', exact: true })).toBeEnabled();
  await click(5, 5);
  await expect(canvas.locator('.annotation-point')).toHaveCount(1);
  await click(10, 8);
  await expect(canvas.locator('.annotation-point')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'class_0 · keypoints', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'class_0 · keypoints', exact: true }).click();
  await drag(10, 8, 12, 9);
  await expect.poll(async () => Number(await canvas.locator('.annotation-point').last().getAttribute('cx'))).toBeCloseTo(12, 4);
  const blobAvailable = await canvas.locator('image').evaluate(async image => {
    const href = image.getAttribute('href');
    if (!href) throw new Error('Missing image URL.');
    const preview = new Image();
    preview.src = href;
    await preview.decode();
    return preview.naturalWidth > 0;
  });
  expect(blobAvailable).toBe(true);
  await page.getByLabel('Review', { exact: true }).selectOption('reviewed');
  await expect(page.locator('.save-indicator')).toContainText('Saved on this device');
  await page.screenshot({ path: 'test-results/editor-organized.png' });

  const csv = await exportAs('csv', false, true);
  const csvText = String(csv.find(([path]) => path.endsWith('annotations.csv'))?.[1]);
  expect(csvText).toContain('"label"');
  expect(csvText).toContain('"keypoints"');
  const native = await exportAs('native', true, true);
  const document = JSON.parse(String(native.find(([path]) => path.includes('/labels/') && path.endsWith('.json'))?.[1]));
  expect(document.annotations.map((item: { kind: string }) => item.kind)).toEqual(['box', 'label', 'keypoints']);
  expect(document.skeletons[0].points).toEqual(['Point', 'Tip']);
  expect(document.review).toBe('reviewed');
  const countBefore = Object.keys(await files()).length;
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('yolo');
  await page.getByRole('button', { name: 'Choose destination & export' }).click();
  await expect(page.getByRole('alert')).toContainText('cannot represent label');
  expect(Object.keys(await files()).length).toBe(countBefore);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.image-file').filter({ hasText: 'metadata.webp' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('metadata.webp');
  await page.getByRole('button', { name: 'Polygon', exact: true }).click();
  await click(3, 3); await click(18, 3); await click(10, 15);
  await page.getByRole('button', { name: 'Finish polygon', exact: true }).click();
  await expect(canvas.locator('polygon.annotation-shape')).toHaveCount(1);
  const segmentation = await exportAs('yolo-seg', false, true);
  const label = String(segmentation.find(([path]) => path.endsWith('.txt'))?.[1]).trim().split(/\s+/);
  expect(label).toHaveLength(7);
  expect(Number(label[1])).toBeCloseTo(0.1);
  expect(segmentation.some(([path]) => path.endsWith('.png'))).toBe(false);
  const manifest = JSON.parse(String(segmentation.find(([path]) => path.endsWith('export-manifest.json'))?.[1]));
  expect(manifest.images).toHaveLength(1);
  expect(manifest.includesImages).toBe(false);
  await page.locator('.image-file').filter({ hasText: 'metadata.png' }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await expect(canvas.locator('.annotation-point')).toHaveCount(2);
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByLabel('Review status', { exact: true }).selectOption('reviewed');
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await expect(page.locator('.gallery-item')).toContainText('metadata.png');
});

test('dataset classes and skeletons stay shared across images, imports, reloads, and guarded worker updates', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await page.getByLabel('Add a class', { exact: true }).fill('Cohort');
  await page.getByLabel('Add a class', { exact: true }).locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Dataset classes' })).toContainText('Cohort');
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'Cohort', exact: true }).click();
  await page.getByRole('button', { name: 'Keypoint', exact: true }).click();
  const canvas = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true });
  await canvas.scrollIntoViewIfNeeded();
  const coordinate = await canvas.evaluate(element => {
    const matrix = (element as SVGSVGElement).getScreenCTM();
    if (!matrix) throw new Error('Canvas transform unavailable.');
    const point = new DOMPoint(5, 5).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(coordinate.x, coordinate.y);
  await expect(canvas.locator('.annotation-point')).toHaveCount(1);
  const placed = await canvas.locator('.annotation-point').evaluate(point => ({
    x: Number(point.getAttribute('cx')), y: Number(point.getAttribute('cy')),
  }));
  await page.getByPlaceholder('Add point name').fill('Tip');
  await page.getByPlaceholder('Add point name').locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await expect(canvas.locator('.annotation-point')).toHaveCount(1);
  await page.locator('.image-file').filter({ hasText: 'metadata.webp' }).click();
  await expect(page.getByRole('combobox', { name: 'Active class' }).locator('option')).toHaveText(['Cohort', 'class_0']);
  await page.getByRole('button', { name: 'Keypoint', exact: true }).click();
  await expect(page.getByText('Skeleton points: Point · Tip', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Add point name').fill('Base');
  await page.getByPlaceholder('Add point name').locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Skeleton points: Point · Tip · Base', { exact: true })).toBeVisible();
  await page.getByLabel('Add a class', { exact: true }).fill('Cohort');
  await page.getByLabel('Add a class', { exact: true }).locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('A class with this name already exists');
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('orientation-1.jpg'));
  await expect(page.locator('.gallery-item')).toHaveCount(3);
  await page.reload();
  await enterEmptyWorkspace(page);
  await expect(page.locator('.gallery-item')).toHaveCount(3);
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  await expect(page.getByRole('button', { name: 'Cohort · label', exact: true })).toBeVisible();
  await expect(canvas.locator('.annotation-point')).toHaveCount(1);

  const workerUrl = page.workers().find(worker => worker.url().includes('storage.worker-'))?.url();
  if (!workerUrl) throw new Error('Storage worker URL unavailable.');
  const workspaceId = await page.locator('.workspace').getAttribute('data-workspace-id');
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  const result = await page.evaluate(async ({ workerUrl, workspaceId, passphrase }) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    type Schema = import('../../src/domain/dataset-schema').DatasetSchema;
    type Document = import('../../src/domain/model').AnnotationDocument;
    type Reply = { ok: boolean; error?: string; value?: { schema?: Schema; items?: { document: Document }[] } };
    let id = 0;
    const request = (payload: Record<string, unknown>) => new Promise<Reply>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ version: 1, id: ++id, payload });
    });
    try {
      for (const payload of [{ type: 'workspace-open', workspaceId }, { type: 'unlock', passphrase }]) {
        const reply = await request(payload);
        if (!reply.ok) throw new Error(reply.error);
      }
      const schema = (await request({ type: 'schema-open' })).value?.schema;
      if (!schema) throw new Error('Expected persistent dataset schema.');
      const documents = (await request({ type: 'workspace-export-info', offset: 0, limit: 100 })).value?.items?.map(item => item.document);
      if (!documents?.[0]) throw new Error('Expected saved documents.');
      const stale = await request({ type: 'schema-update', expectedRevision: schema.revision - 1,
        schema: { ...schema, revision: schema.revision + 1 } });
      const destructive = await request({ type: 'schema-update', expectedRevision: schema.revision,
        schema: { ...schema, revision: schema.revision + 1, classes: [] } });
      const changed = structuredClone(documents[0]);
      changed.revision++;
      changed.classes[0]!.name = 'Unauthorized per-image rename';
      const perImage = await request({ type: 'workspace-update', id: changed.image.id,
        expectedRevision: changed.revision - 1, document: changed });
      return { schema, documents, stale, destructive, perImage };
    } finally { worker.terminate(); }
  }, { workerUrl, workspaceId, passphrase });
  expect(result.documents).toHaveLength(3);
  for (const document of result.documents) {
    expect(document.classes).toEqual(result.schema.classes);
    expect(document.skeletons).toEqual(result.schema.skeletons);
  }
  const keypoints = result.documents.flatMap(document => document.annotations).find(item => item.kind === 'keypoints');
  expect(keypoints).toMatchObject({ points: [
    { ...placed, visibility: 'visible' },
    { x: 0, y: 0, visibility: 'absent' },
    { x: 0, y: 0, visibility: 'absent' },
  ] });
  expect(result.stale).toMatchObject({ ok: false, error: expect.stringContaining('schema changed') });
  expect(result.destructive).toMatchObject({ ok: false, error: expect.stringContaining('migration') });
  expect(result.perImage).toMatchObject({ ok: false, error: expect.stringContaining('schema') });
});

test('destructive schema migrations preview affected records, require point-loss confirmation, and retain annotations', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Schema migration test');
  await page.getByLabel('Password protect this workspace', { exact: true }).check();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Encrypted backup', exact: true })).toBeEnabled();
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await page.getByLabel('Add a class', { exact: true }).fill('Replacement');
  await page.getByLabel('Add a class', { exact: true }).locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dataset schema saved');
  await page.locator('input[aria-label="Add images"]').setInputFiles(fixture('metadata.png'));
  await expect(page.locator('.workspace-notice').filter({ hasText: 'Import finished' })).toBeVisible();
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Keypoint', exact: true }).click();
  const canvas = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true });
  await canvas.scrollIntoViewIfNeeded();
  const coordinate = await canvas.evaluate(element => {
    const matrix = (element as SVGSVGElement).getScreenCTM();
    if (!matrix) throw new Error('Canvas transform unavailable.');
    return new DOMPoint(5, 5).matrixTransform(matrix);
  });
  await page.mouse.click(coordinate.x, coordinate.y);
  await expect(canvas.locator('.annotation-point')).toHaveCount(1);
  await expect(page.locator('.save-indicator')).toContainText('Saved');

  const workerUrl = page.workers().find(worker => worker.url().includes('storage.worker-'))?.url();
  if (!workerUrl) throw new Error('Storage worker URL unavailable.');
  const workspaceId = await page.locator('.workspace').getAttribute('data-workspace-id');
  if (!workspaceId) throw new Error('Workspace ID unavailable.');
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();

  const result = await page.evaluate(async ({ workerUrl, workspaceId, passphrase }) => {
    type Schema = {
      revision: number;
      classes: { id: string; name: string }[];
      skeletons: { id: string; name: string; points: string[]; edges: [number, number][] }[];
    };
    type Point = { x: number; y: number; visibility: string };
    type Annotation = { kind: string; classId: string; points?: Point[] };
    type Document = { annotations: Annotation[] };
    type Reply = {
      ok: boolean;
      error?: string;
      value?: {
        schema?: Schema;
        token?: string;
        discardedCoordinates?: number;
        affectedAnnotations?: number;
        images?: { id: string; name: string; affectedAnnotations: number; discardedCoordinates: number }[];
        document?: Document;
      };
    };
    const worker = new Worker(workerUrl, { type: 'module' });
    let id = 0;
    const request = (payload: Record<string, unknown>) => new Promise<Reply>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data as Reply);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ version: 1, id: ++id, payload });
    });
    const checked = async (payload: Record<string, unknown>) => {
      const reply = await request(payload);
      if (!reply.ok) throw new Error(reply.error ?? 'Storage request failed.');
      return reply.value;
    };
    try {
      for (const payload of [{ type: 'workspace-open', workspaceId }, { type: 'unlock', passphrase }]) {
        await checked(payload);
      }
      const initial = (await checked({ type: 'schema-open' }))?.schema;
      if (!initial) throw new Error('Expected a dataset schema.');
      const expanded = structuredClone(initial);
      expanded.revision++;
      expanded.skeletons[0]!.points.push('Tip');
      const added = (await checked({
        type: 'schema-update', expectedRevision: initial.revision, schema: expanded,
      }))?.schema;
      if (!added) throw new Error('Expected the additive schema update.');
      const removedClass = added.classes.find(item => item.name === 'class_0');
      const replacement = added.classes.find(item => item.name === 'Replacement');
      if (!removedClass || !replacement) throw new Error('Expected the source and replacement classes.');
      const next = structuredClone(added);
      next.revision++;
      next.classes = next.classes.filter(item => item.id !== removedClass.id);
      next.skeletons[0]!.points = ['Tip'];
      const preview = await checked({
        type: 'schema-preview', expectedRevision: added.revision, schema: next,
        remaps: [{ from: removedClass.id, to: replacement.id }],
      });
      if (!preview?.token) throw new Error('Expected a migration preview token.');
      const affectedImage = preview.images?.[0];
      if (!affectedImage) throw new Error('Expected the affected image in the preview.');
      const refused = await request({ type: 'schema-apply', token: preview.token, confirmDiscard: false });
      const unchanged = await checked({ type: 'workspace-read', id: affectedImage.id });
      const applied = await checked({ type: 'schema-apply', token: preview.token, confirmDiscard: true });
      const migrated = await checked({ type: 'workspace-read', id: affectedImage.id });
      return { preview, refused, unchanged, applied, migrated, replacementId: replacement.id };
    } finally {
      worker.terminate();
    }
  }, { workerUrl, workspaceId, passphrase });

  expect(result.preview).toMatchObject({
    affectedAnnotations: 1, discardedCoordinates: 1,
    images: [{ name: 'metadata.png', affectedAnnotations: 1, discardedCoordinates: 1 }],
  });
  expect(result.refused).toMatchObject({ ok: false, error: expect.stringContaining('requires confirmation') });
  expect(result.unchanged?.document?.annotations).toHaveLength(1);
  expect(result.applied).toMatchObject({
    ready: true, schema: { classes: [{ name: 'Replacement' }], skeletons: [{ points: ['Tip'] }] },
  });
  expect(result.migrated?.document?.annotations).toHaveLength(1);
  expect(result.migrated?.document?.annotations[0]).toMatchObject({
    kind: 'keypoints', classId: result.replacementId,
    points: [{ x: 0, y: 0, visibility: 'absent' }],
  });
});

test('schema migrations rename used classes and skeletons, and remove unused skeletons without data loss', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await page.getByLabel('Rename class', { exact: true }).selectOption({ label: 'class_0' });
  await page.getByLabel('New class name', { exact: true }).fill('Vehicle');
  await page.getByLabel('Rename skeleton', { exact: true }).selectOption({ label: 'Point' });
  await page.getByLabel('New skeleton name', { exact: true }).fill('Landmarks');
  await page.getByRole('button', { name: 'Preview schema migration', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Schema changes' })).toContainText('Class "class_0" will be renamed to "Vehicle".');
  await expect(page.getByRole('list', { name: 'Schema changes' })).toContainText('Skeleton "Point" will be renamed to "Landmarks".');
  await page.getByRole('button', { name: 'Apply schema migration', exact: true }).click();
  await page.getByLabel('Remove skeleton', { exact: true }).selectOption({ label: 'Landmarks' });
  await page.getByRole('button', { name: 'Preview schema migration', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Schema changes' })).toContainText('Skeleton "Landmarks" will be removed.');
  await page.getByRole('button', { name: 'Apply schema migration', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Dataset classes' })).toContainText('Vehicle');
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('button', { name: 'Vehicle · label', exact: true })).toBeVisible();
});

test('schema migrations count coordinate loss, require only discard confirmation, and preserve surviving annotations', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  const schemaDetails = page.locator('details.dataset-schema');
  const openSchema = async () => {
    if (!(await schemaDetails.evaluate(element => (element as HTMLDetailsElement).open))) {
      await schemaDetails.locator('summary').click();
    }
  };
  for (const name of ['Unused', 'Source', 'Target']) {
    await page.getByLabel('Add a class', { exact: true }).fill(name);
    await page.getByLabel('Add a class', { exact: true }).locator('..').getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Dataset classes' })).toContainText(name);
  }
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.getByPlaceholder('Add point name').fill('Tip');
  await page.getByPlaceholder('Add point name').locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  const placed: Record<string, { x: number; y: number }[]> = {};
  for (const name of ['metadata.png', 'metadata.webp']) {
    await page.locator('.gallery-open').filter({ hasText: name }).click();
    await page.getByRole('button', { name: 'Keypoint', exact: true }).click();
    await page.getByRole('combobox', { name: 'Active class' }).selectOption({ label: 'Source' });
    const canvas = page.getByRole('img', { name: `${name} annotation canvas`, exact: true });
    await canvas.scrollIntoViewIfNeeded();
    for (const value of [5, 8]) {
      const coordinate = await canvas.evaluate((element, value) => {
        const matrix = (element as SVGSVGElement).getScreenCTM()!;
        const point = new DOMPoint(value, value).matrixTransform(matrix);
        return { x: point.x, y: point.y };
      }, value);
      await page.mouse.click(coordinate.x, coordinate.y);
      await expect(page.locator('.save-indicator')).toContainText('Saved');
    }
    await expect(canvas.locator('.annotation-point')).toHaveCount(2);
    placed[name] = await canvas.locator('.annotation-point').evaluateAll(points => points.map(point => ({
      x: Number(point.getAttribute('cx')), y: Number(point.getAttribute('cy')),
    })));
    await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  }
  const preview = page.getByRole('region', { name: 'Schema migration preview', exact: true });
  const previewButton = page.getByRole('button', { name: 'Preview schema migration', exact: true });
  const applyButton = page.getByRole('button', { name: 'Apply schema migration', exact: true });
  await openSchema();
  await page.getByLabel('Remove class', { exact: true }).selectOption({ label: 'Unused' });
  await previewButton.click();
  await expect(preview).toContainText('0 point coordinates will be discarded from 0 annotations');
  await expect(preview.getByRole('checkbox')).toHaveCount(0);
  await applyButton.click();
  await expect(page.getByRole('list', { name: 'Dataset classes' })).not.toContainText('Unused');
  await openSchema();
  await page.getByLabel('Remove class', { exact: true }).selectOption({ label: 'Source' });
  await previewButton.click();
  await expect(page.getByRole('alert')).toContainText('Choose a surviving replacement class');
  await expect(preview).toHaveCount(0);
  await openSchema();
  await page.getByLabel('Replacement class', { exact: true }).selectOption({ label: 'Target' });
  await previewButton.click();
  await expect(preview.getByRole('checkbox')).toHaveCount(0);
  await applyButton.click();
  await expect(page.getByRole('list', { name: 'Dataset classes' })).not.toContainText('Source');
  await openSchema();
  await page.getByLabel('Point names for Point', { exact: true }).fill('Tip\nPoint');
  await previewButton.click();
  await expect(preview).toContainText('0 point coordinates');
  await applyButton.click();
  await openSchema();
  await expect(page.getByLabel('Point names for Point', { exact: true })).toHaveValue('Tip\nPoint');
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  const canvas = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true });
  await expect.poll(() => canvas.locator('.annotation-point').evaluateAll(points => points.map(point => ({
    x: Number(point.getAttribute('cx')), y: Number(point.getAttribute('cy')),
  })))).toEqual([...placed['metadata.png']!].reverse());
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await openSchema();
  await page.getByLabel('Point names for Point', { exact: true }).fill('Tip\nRenamed');
  await previewButton.click();
  await expect(preview).toContainText('2 point coordinates will be discarded from 2 annotations across 2 images');
  await expect(page.getByRole('list', { name: 'Affected annotation counts' })).toContainText('metadata.png: 1 annotations, 1 point coordinates');
  await expect(page.getByRole('list', { name: 'Affected annotation counts' })).toContainText('metadata.webp: 1 annotations, 1 point coordinates');
  await expect(applyButton).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel schema migration', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByText('Skeleton points: Tip · Point', { exact: true })).toBeVisible();
  await previewButton.click();
  await page.getByRole('checkbox', { name: 'I confirm discarding these point coordinates', exact: true }).check();
  await applyButton.click();
  await expect(page.getByText('Skeleton points: Tip · Renamed', { exact: true })).toBeVisible();
  await page.reload();
  await enterEmptyWorkspace(page);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  const workerUrl = page.workers().find(worker => worker.url().includes('storage.worker-'))!.url();
  const workspaceId = await page.locator('.workspace').getAttribute('data-workspace-id');
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  const result = await page.evaluate(async ({ workerUrl, workspaceId, passphrase }) => {
    type Schema = import('../../src/domain/dataset-schema').DatasetSchema;
    type Document = import('../../src/domain/model').AnnotationDocument;
    type Preview = import('../../src/workers/protocol').SchemaMigrationPreview;
    type Reply = { ok: boolean; error?: string; value?: { schema?: Schema; items?: { document: Document }[] } & Partial<Preview> };
    const worker = new Worker(workerUrl, { type: 'module' });
    let id = 0;
    const request = (payload: Record<string, unknown>) => new Promise<Reply>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ version: 1, id: ++id, payload });
    });
    try {
      for (const payload of [{ type: 'workspace-open', workspaceId }, { type: 'unlock', passphrase }]) {
        const reply = await request(payload);
        if (!reply.ok) throw new Error(reply.error);
      }
      const schema = (await request({ type: 'schema-open' })).value!.schema!;
      const documents = (await request({ type: 'workspace-export-info', offset: 0, limit: 100 })).value!.items!.map(item => item.document);
      const next = structuredClone(schema);
      next.revision++; next.skeletons[0]!.points = ['Renamed']; next.skeletons[0]!.edges = [];
      const plan = { type: 'schema-preview', expectedRevision: schema.revision, schema: next, remaps: [] };
      const staleRevision = await request({ ...plan, expectedRevision: schema.revision - 1 });
      const token = (await request(plan)).value!.token!;
      const unconfirmed = await request({ type: 'schema-apply', token, confirmDiscard: false });
      await request({ type: 'schema-cancel', token });
      const cancelled = await request({ type: 'schema-apply', token, confirmDiscard: true });
      const changedToken = (await request(plan)).value!.token!;
      const changed = structuredClone(documents[0]!); changed.revision++;
      const write = await request({ type: 'workspace-update', id: changed.image.id, expectedRevision: changed.revision - 1, document: changed });
      if (!write.ok) throw new Error(write.error);
      const staleImage = await request({ type: 'schema-apply', token: changedToken, confirmDiscard: true });
      const beforeFinal = (await request({ type: 'workspace-export-info', offset: 0, limit: 100 })).value!.items!;
      const finalPreview = (await request(plan)).value!;
      const applied = await request({ type: 'schema-apply', token: finalPreview.token, confirmDiscard: true });
      const repeated = await request({ type: 'schema-apply', token: finalPreview.token, confirmDiscard: true });
      const final = (await request({ type: 'workspace-export-info', offset: 0, limit: 100 })).value!.items!;
      const staleWrite = await request({ type: 'workspace-update', id: changed.image.id, expectedRevision: changed.revision, document: { ...changed, revision: changed.revision + 1 } });
      return { schema, documents, staleRevision, unconfirmed, cancelled, staleImage, beforeFinal, applied, repeated, final, staleWrite };
    } finally { worker.terminate(); }
  }, { workerUrl, workspaceId, passphrase });
  for (const document of result.documents) {
    expect(document.annotations).toHaveLength(1);
    expect(document.annotations[0]).toMatchObject({
      classId: result.schema.classes.find(item => item.name === 'Target')!.id,
      points: [{ ...placed[document.image.name]![1], visibility: 'visible' }, { x: 0, y: 0, visibility: 'absent' }],
    });
  }
  expect(result.staleRevision).toMatchObject({ ok: false, error: expect.stringContaining('schema changed') });
  expect(result.unconfirmed).toMatchObject({ ok: false, error: expect.stringContaining('confirmation') });
  expect(result.cancelled).toMatchObject({ ok: false, error: expect.stringContaining('stale') });
  expect(result.staleImage).toMatchObject({ ok: false, error: expect.stringContaining('stale') });
  expect(result.beforeFinal.map(item => item.document.annotations)).toEqual(result.documents.map(item => item.annotations));
  expect(result.applied.ok).toBe(true);
  expect(result.repeated).toMatchObject({ ok: false, error: expect.stringContaining('stale') });
  expect(result.staleWrite.ok).toBe(false);
  for (const item of result.final) expect(item.document.annotations).toHaveLength(1);
});

test('encrypted backup restores shared definitions from an empty dataset without creating images', async ({ page }) => {
  await mockBackupPicker(page);
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await page.getByLabel('Add a class', { exact: true }).fill('Empty dataset canary');
  await page.getByLabel('Add a class', { exact: true }).locator('..').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Dataset classes' })).toContainText('Empty dataset canary');
  await page.getByRole('button', { name: 'Encrypted backup', exact: true }).click();
  await page.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm backup passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Choose destination & back up', exact: true }).click();
  await expect(page.getByText('Encrypted backup complete', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Empty restore target');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await page.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Choose backup folder & restore', exact: true }).click();
  await expect(page.getByText('Restore complete · 0 images', { exact: false })).toBeVisible();
  await expect(page.locator('.gallery-item')).toHaveCount(0);
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Dataset classes' })).toContainText('Empty dataset canary');
  await page.reload();
  await page.locator('.workspace-tile').filter({ has: page.getByText('Empty restore target', { exact: true }) }).click();
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Dataset classes' })).toContainText('Empty dataset canary');
  await expect(page.locator('.gallery-item')).toHaveCount(0);
});

test('binary mask brush and erase preserve exact pixels through undo, reload, native sidecars, and COCO RLE', async ({ page }) => {
  await mockFolderExport(page);
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await page.locator('.gallery-open').click();
  const canvas = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true });
  const stroke = async (expectedMaskCount: number) => {
    await canvas.scrollIntoViewIfNeeded();
    const coordinates = await canvas.evaluate(element => {
      const matrix = (element as SVGSVGElement).getScreenCTM();
      if (!matrix) throw new Error('Canvas unavailable.');
      return [new DOMPoint(5, 5), new DOMPoint(10, 8)].map(point => {
        const p = point.matrixTransform(matrix); return { x: p.x, y: p.y };
      });
    });
    await page.mouse.move(coordinates[0]!.x, coordinates[0]!.y); await page.mouse.down();
    await page.mouse.move(coordinates[1]!.x, coordinates[1]!.y, { steps: 4 }); await page.mouse.up();
    await expect(canvas.locator('.annotation-mask')).toHaveCount(expectedMaskCount);
  };
  await page.getByRole('button', { name: 'Brush mask', exact: true }).click();
  await page.getByLabel('Brush radius', { exact: true }).fill('2');
  await stroke(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  await page.getByRole('button', { name: 'class_0 · mask', exact: true }).click();
  await page.getByLabel('Annotation attributes', { exact: true }).fill('{"checked":true,"score":0.95,"note":"mask test"}');
  await page.getByRole('button', { name: 'Save attributes', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Annotation attributes', { exact: true })).toHaveValue('{}');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Annotation attributes', { exact: true })).toHaveValue(/"checked": true/);
  await page.getByLabel('Visible in editor', { exact: true }).click();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(0);
  await page.getByLabel('Visible in editor', { exact: true }).click();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  await page.getByLabel('Lock annotation', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete selected annotation', exact: true })).toBeDisabled();
  await page.getByLabel('Lock annotation', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete selected annotation', exact: true })).toBeEnabled();
  const exportAs = async (format: string) => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByLabel('Export format', { exact: true }).selectOption(format);
    await page.getByLabel('Include sanitized PNG images').uncheck();
    await page.getByRole('button', { name: 'Choose destination & export' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    return page.evaluate(() => (window as unknown as { __exportedFiles: Record<string, string | number[]> }).__exportedFiles);
  };
  const first = await exportAs('native');
  const binary = Object.entries(first).find(([name]) => name.endsWith('.bin'))!;
  expect(binary[1]).toHaveLength(65536);
  const area = (binary[1] as number[]).reduce((sum, value) => sum + value, 0);
  expect(area).toBeGreaterThan(20);
  const doc = JSON.parse(String(Object.entries(first).find(([name]) => name.includes('/labels/'))![1]));
  expect(doc.annotations[0].attributes).toEqual({ checked: true, score: 0.95, note: 'mask test' });
  const coco = await exportAs('coco');
  const json = JSON.parse(String(Object.entries(coco).find(([name]) => name.endsWith('_annotations.coco.json'))![1]));
  expect(json.annotations[0].area).toBe(area);
  expect(json.annotations[0].segmentation.counts.reduce((a: number, b: number) => a + b, 0)).toBe(600);
  await page.getByRole('button', { name: 'class_0 · mask', exact: true }).click();
  await page.getByRole('button', { name: 'Erase mask', exact: true }).click();
  await stroke(0);
  await expect(canvas.locator('.annotation-mask')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  await page.reload();
  await enterEmptyWorkspace(page);
  await page.locator('.gallery-open').click();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  const reopened = await exportAs('native');
  const restored = Object.entries(reopened).find(([name]) => name.endsWith('.bin'))!;
  expect(restored[1]).toEqual(binary[1]);
});

test('manual and inactivity lock clear the editor and allow password reentry without losing committed work', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  await expect(page.getByRole('img', { name: 'metadata.png annotation canvas' })).toHaveCount(0);
  await page.getByLabel('Workspace passphrase', { exact: true }).fill('wrong password value');
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByLabel('Lock after inactivity').selectOption('1');
  await page.clock.install();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('button', { name: 'Unlock workspace', exact: true })).toBeVisible();
  await expect(page.getByText('Workspace locked after inactivity.', { exact: false })).toBeVisible();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
});

test('staged annotation imports roll back on a later invalid image and publish valid batches together', async ({ page }) => {
  await mockFolderExport(page);
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('native');
  await page.getByRole('button', { name: 'Choose destination & export', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const documents = await page.evaluate(() => Object.entries((window as unknown as { __exportedFiles: Record<string, string> }).__exportedFiles)
    .filter(([name]) => name.includes('/labels/') && name.endsWith('.json')).map(([name, text]) => ({
      name: name.split('/').at(-1)!, document: JSON.parse(text),
    })));
  for (const item of documents) item.document.review = 'reviewed';
  documents[1]!.document.image.canonical.width++;
  documents[1]!.document.image.source.width++;
  const files = () => documents.map(item => ({ name: item.name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(item.document)) }));
  await page.getByText('Import annotations', { exact: true }).click();
  await page.getByLabel('Replace annotations on matched images (make an encrypted backup first)', { exact: true }).check();
  await page.getByLabel('Choose annotation files', { exact: true }).setInputFiles(files());
  await expect(page.getByRole('alert')).toBeVisible();
  await page.reload();
  await enterEmptyWorkspace(page);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.getByLabel('Review status', { exact: true }).selectOption('reviewed');
  await expect(page.locator('.gallery-item')).toHaveCount(0);
  await page.getByLabel('Review status', { exact: true }).selectOption('all');
  documents[1]!.document.image.canonical.width--;
  documents[1]!.document.image.source.width--;
  await page.getByText('Import annotations', { exact: true }).click();
  await page.getByLabel('Replace annotations on matched images (make an encrypted backup first)', { exact: true }).check();
  await page.getByLabel('Choose annotation files', { exact: true }).setInputFiles(files());
  await expect(page.getByText('Imported annotations for 2 images atomically.', { exact: false })).toBeVisible();
  await page.getByLabel('Review status', { exact: true }).selectOption('reviewed');
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.getByLabel('Annotation import format', { exact: true }).selectOption('voc');
  await page.getByLabel('Replace annotations on matched images (make an encrypted backup first)', { exact: true }).check();
  const xml = '<annotation><filename>metadata.png</filename><size><width>30</width><height>20</height></size><object><name>Pill</name><difficult>1</difficult><truncated>0</truncated><bndbox><xmin>1</xmin><ymin>2</ymin><xmax>5</xmax><ymax>6</ymax></bndbox></object></annotation>';
  await page.getByLabel('Choose annotation files', { exact: true }).setInputFiles({
    name: 'metadata.xml', mimeType: 'application/xml', buffer: Buffer.from(`<!DOCTYPE annotation>${xml}`),
  });
  await expect(page.getByRole('alert')).toContainText('DTDs');
  await page.getByLabel('Choose annotation files', { exact: true }).setInputFiles({
    name: 'metadata.xml', mimeType: 'application/xml', buffer: Buffer.from(xml),
  });
  await expect(page.getByText('Imported annotations for 1 images atomically.', { exact: false })).toBeVisible();
  await page.getByLabel('Review status', { exact: true }).selectOption('all');
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  const shape = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true }).locator('.annotation-shape');
  expect(await shape.evaluate(element => ['x', 'y', 'width', 'height'].map(name => Number(element.getAttribute(name))))).toEqual([0, 1, 5, 5]);
});

test('workspace deletion requires confirmation, refuses an active editor, and only removes its own namespace', async ({ page, context }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  const namespace = await page.locator('.workspace').getAttribute('data-workspace-id');
  const dashboard = await context.newPage();
  await dashboard.goto('/');
  await dashboard.getByRole('button', { name: 'Delete workspace Test dataset', exact: true }).click();
  await expect(dashboard.getByRole('button', { name: 'Permanently delete workspace', exact: true })).toBeDisabled();
  await dashboard.getByLabel('Type the workspace name to delete', { exact: true }).fill('Test dataset');
  await dashboard.getByRole('button', { name: 'Permanently delete workspace', exact: true }).click();
  await expect(dashboard.getByRole('alert')).toContainText('open in another tab');
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  await dashboard.getByRole('button', { name: 'Permanently delete workspace', exact: true }).click();
  await expect(dashboard.locator('.workspace-tile')).toHaveCount(0);
  const names = await dashboard.evaluate(async () => {
    const names: string[] = [];
    for await (const [name] of await navigator.storage.getDirectory() as unknown as AsyncIterable<[string, FileSystemHandle]>) names.push(name);
    return names;
  });
  expect(names).not.toContain(`annotator-${namespace}-media`);
  expect(names).not.toContain(`.annotator-${namespace}-sql`);
  expect(names).toContain('annotator-workspaces.json');
  await dashboard.reload();
  await expect(dashboard.locator('.workspace-tile')).toHaveCount(0);
});

test('catalog search spans every page while gallery rendering stays bounded to 100 images', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  const buffer = await readFile(fixture('metadata.png'));
  await page.getByLabel('Add images', { exact: true }).setInputFiles(Array.from({ length: 101 }, (_, index) => ({
    name: `image-${String(index).padStart(3, '0')}.png`, mimeType: 'image/png', buffer,
  })));
  await expect(page.getByText('Import finished · 101 added', { exact: false })).toBeVisible();
  await expect(page.locator('.gallery-item')).toHaveCount(100);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.getByLabel('Search images', { exact: true }).fill('image-100');
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await expect(page.locator('.gallery-item')).toContainText('image-100.png');
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: 'image-100.png annotation canvas', exact: true })).toBeVisible();
  await page.getByLabel('Search images', { exact: true }).fill('image-');
  await expect(page.locator('.image-file')).toHaveCount(100);
  await page.getByRole('button', { name: 'Next search results', exact: true }).click();
  await expect(page.locator('.image-file')).toHaveCount(1);
  await page.locator('.image-file').click();
  await expect(page.getByRole('img', { name: 'image-000.png annotation canvas', exact: true })).toBeVisible();
});

test('intake refuses an almost-full origin before adding images', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'estimate', { value: async () => ({ quota: 1024 * 1024, usage: 1024 * 1024 }) });
  });
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await expect(page.getByRole('alert')).toContainText('No images were added');
  await expect(page.locator('.gallery-item')).toHaveCount(0);
});

test('intake checkpoints resume after reload without duplicate images or replacing edited annotations', async ({ page }) => {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    let imported = 0;
    Worker.prototype.postMessage = function(message, transfer) {
      const state = window as unknown as { __holdIntake?: boolean; __checkpointHeld?: boolean };
      if (message.payload?.type === 'workspace-import' && ++imported === 2 && state.__holdIntake) {
        state.__checkpointHeld = true; return;
      }
      post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };
  });
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.evaluate(() => { (window as unknown as { __holdIntake: boolean }).__holdIntake = true; });
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __checkpointHeld?: boolean }).__checkpointHeld)).toBe(true);
  await page.reload();
  await enterEmptyWorkspace(page);
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByLabel('Resume intake: skip exact source inputs already saved', { exact: true }).check();
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect(page.getByText('1 already-saved inputs retained', { exact: false })).toBeVisible();
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.locator('.gallery-open').filter({ hasText: 'metadata.png' }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByLabel('Add images', { exact: true }).setInputFiles({
    name: 'metadata.png', mimeType: 'image/webp', buffer: await readFile(fixture('metadata.webp')),
  });
  await expect(page.locator('.gallery-item')).toHaveCount(3);
});

test('encrypted page previews survive reopen, revoke their URLs on lock, and are removed with their image', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await page.getByRole('button', { name: 'Load page previews', exact: true }).click();
  const preview = page.locator('.gallery-thumbnail');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate(async element => {
    const image = element as HTMLImageElement; await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  })).toEqual({ width: 30, height: 20 });
  const url = await preview.getAttribute('src');
  const files = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const catalog = JSON.parse(await (await (await root.getFileHandle('annotator-workspaces.json')).getFile()).text());
    const media = await root.getDirectoryHandle(`annotator-${catalog[0].id}-media`);
    const output: { name: string; bytes: number[] }[] = [];
    for await (const [name, handle] of media as unknown as AsyncIterable<[string, FileSystemFileHandle]>) {
      output.push({ name, bytes: Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer())) });
    }
    return output.sort((a, b) => a.name.localeCompare(b.name));
  });
  const before = await files();
  expect(before).toHaveLength(2);
  const thumbnail = before.find(file => {
    const bytes = Uint8Array.from(file.bytes), length = new DataView(bytes.buffer).getUint32(0);
    return JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))).purpose === 'thumbnail';
  });
  expect(thumbnail).toBeDefined();
  await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  expect(await page.evaluate(url => new Promise(resolve => {
    const image = new Image(); image.onload = () => resolve(false); image.onerror = () => resolve(true); image.src = url!;
  }), url)).toBe(true);
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Load page previews', exact: true }).click();
  await expect(preview).toBeVisible();
  expect(await files()).toEqual(before);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove metadata.png from dataset', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(0);
  expect(await files()).toHaveLength(0);
});

test('interrupted key rotation discards new-key staging and retains the original passphrase and data', async ({ page }) => {
  await mockBackupPicker(page);
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles([fixture('metadata.png'), fixture('metadata.webp')]);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.getByText('Rotate workspace encryption key', { exact: true }).click();
  await page.getByLabel('Current rotation passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('New rotation passphrase', { exact: true }).fill('new key will not be published');
  await page.getByLabel('Confirm rotation passphrase', { exact: true }).fill('new key will not be published');
  await page.evaluate(() => { (window as unknown as { __holdRestore: boolean }).__holdRestore = true; });
  await page.getByRole('button', { name: 'Rotate encryption key', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __resumeArchive?: () => void }).__resumeArchive)).toBe('function');
  await page.reload();
  await enterEmptyWorkspace(page);
  await expect(page.locator('.gallery-item')).toHaveCount(2);
  await page.locator('.gallery-open').first().click();
  await expect(page.locator('svg.annotation-canvas image').first()).toBeVisible();
  const state = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const catalog = JSON.parse(await (await (await root.getFileHandle('annotator-workspaces.json')).getFile()).text());
    const media = await root.getDirectoryHandle(`annotator-${catalog[0].id}-media`);
    const names: string[] = [];
    for await (const name of media as unknown as AsyncIterable<[string, FileSystemHandle]>) names.push(name[0]);
    return names;
  });
  expect(state).toHaveLength(2);
});

test('recovery files reset a forgotten passphrase, reject a revoked file, and retain committed annotations', async ({ page }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  const generate = async () => {
    const link = page.getByRole('link', { name: 'Download recovery file', exact: true });
    const previous = await link.count() ? await link.getAttribute('href') : null;
    await page.getByLabel('Current passphrase for recovery', { exact: true }).fill(passphrase);
    await page.getByRole('button', { name: 'Generate recovery file', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download recovery file', exact: true })).toBeVisible();
    if (previous) await expect(page.getByRole('link', { name: 'Download recovery file', exact: true })).not.toHaveAttribute('href', previous);
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download recovery file', exact: true }).click();
    return readFile(await (await download).path());
  };
  await page.getByText('Recovery secret', { exact: true }).click();
  const revoked = await generate();
  const active = await generate();
  expect(active.equals(revoked)).toBe(false);
  await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  await page.getByText('Recover with a recovery file', { exact: true }).click();
  const next = 'recovered workspace new passphrase';
  const use = async (buffer: Buffer) => {
    await page.getByLabel('Recovery file', { exact: true }).setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer });
    await page.getByLabel('New recovery passphrase', { exact: true }).fill(next);
    await page.getByLabel('Confirm recovery passphrase', { exact: true }).fill(next);
    await page.getByRole('button', { name: 'Recover workspace', exact: true }).click();
  };
  await use(revoked);
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await use(active);
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(next);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: 'metadata.png annotation canvas' })).toBeVisible();
});

test('mask backup and staged key rotation preserve pixels and publish the new key atomically', async ({ page }) => {
  await mockBackupPicker(page);
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Brush mask', exact: true }).click();
  const canvas = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true });
  const point = await canvas.evaluate(element => {
    const matrix = (element as SVGSVGElement).getScreenCTM();
    if (!matrix) throw new Error('Canvas unavailable.');
    const p = new DOMPoint(5, 5).matrixTransform(matrix); return { x: p.x, y: p.y };
  });
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.up();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  const pixels = () => canvas.locator('.annotation-mask').evaluate(async element => {
    const image = new Image(); image.src = element.getAttribute('href')!;
    await image.decode();
    const canvas = new OffscreenCanvas(256, 256), context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 256, 256).data).filter((_, index) => index % 4 === 3);
  });
  const original = await pixels();
  await page.getByRole('button', { name: 'Dataset', exact: true }).click();
  await page.getByRole('button', { name: 'Load page previews', exact: true }).click();
  await expect(page.locator('.gallery-thumbnail')).toBeVisible();
  await page.getByRole('button', { name: 'Encrypted backup', exact: true }).click();
  await page.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm backup passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Choose destination & back up', exact: true }).click();
  await expect(page.getByText('Encrypted backup complete', { exact: false })).toBeVisible();
  await page.getByText('Rotate workspace encryption key', { exact: true }).click();
  const next = 'rotated completely new root passphrase';
  await page.getByLabel('Current rotation passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('New rotation passphrase', { exact: true }).fill(next);
  await page.getByLabel('Confirm rotation passphrase', { exact: true }).fill(next);
  await page.getByRole('button', { name: 'Rotate encryption key', exact: true }).click();
  await expect(page.getByText('Workspace key rotated.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(next);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Load page previews', exact: true }).click();
  await expect(page.locator('.gallery-thumbnail')).toBeVisible();
  await page.locator('.gallery-open').click();
  expect(await pixels()).toEqual(original);
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Mask restored');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await page.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Choose backup folder & restore', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  expect(await pixels()).toEqual(original);
});

test('offline app-shell installation supports offline unlock without caching workspace data', async ({ page, context }) => {
  await mockFolderExport(page);
  await page.goto('/');
  await enterEmptyWorkspace(page);
  const folder = await mkdtemp(join(os.tmpdir(), 'annotator-offline-'));
  try {
    await copyFile(fixture('metadata.png'), join(folder, 'offline_canary_patient.png'));
    await page.locator('.folder-button input[webkitdirectory]').setInputFiles(folder);
    await expect(page.locator('.gallery-item')).toHaveCount(1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  await page.getByRole('button', { name: 'Make available offline' }).click();
  await expect(page.locator('.offline-status')).toContainText('Offline app shell ready');
  const cacheContents = await page.evaluate(async () => {
    const results: { name: string; urls: string[]; contents: string[] }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      results.push({
        name, urls: keys.map(request => request.url),
        contents: await Promise.all(keys.map(async request => (await cache.match(request))?.text() ?? '')),
      });
    }
    return results;
  });
  expect(cacheContents.some(cache => cache.name.startsWith('annotator-app-shell-'))).toBe(true);
  expect(JSON.stringify(cacheContents)).not.toContain('offline_canary_patient.png');

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  await enterEmptyWorkspace(page);
  await page.locator('.gallery-open').filter({ hasText: 'offline_canary_patient.png' }).click();
  const canvas = page.getByRole('img', { name: 'offline_canary_patient.png annotation canvas' });
  await expect(canvas).toBeVisible();
  const point = async (x: number, y: number) => canvas.evaluate((element, { x, y }) => {
    const matrix = (element as SVGSVGElement).getScreenCTM();
    if (!matrix) throw new Error('Canvas transform unavailable.');
    const p = new DOMPoint(x, y).matrixTransform(matrix);
    return { x: p.x, y: p.y };
  }, { x, y });
  const first = await point(1, 1), second = await point(12, 12);
  await page.mouse.move(first.x, first.y); await page.mouse.down();
  await page.mouse.move(second.x, second.y); await page.mouse.up();
  await expect(canvas.locator('.annotation-shape')).toHaveCount(1);
  await page.getByRole('button', { name: 'Polygon', exact: true }).click();
  for (const [x, y] of [[2, 2], [10, 2], [5, 10]]) {
    const p = await point(x!, y!); await page.mouse.click(p.x, p.y);
  }
  await page.getByRole('button', { name: 'Finish polygon', exact: true }).click();
  await expect(canvas.locator('.annotation-shape')).toHaveCount(2);
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keypoint', exact: true }).click();
  const keypoint = await point(12, 12);
  await page.mouse.click(keypoint.x, keypoint.y);
  await expect(canvas.locator('.annotation-point')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Brush mask', exact: true })).toBeEnabled();
  await page.keyboard.press('5');
  await expect(page.getByRole('button', { name: 'Brush mask', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const mask = await point(22, 12);
  await page.mouse.move(mask.x, mask.y); await page.mouse.down(); await page.mouse.up();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Erase mask', exact: true })).toBeEnabled();
  await page.keyboard.press('6');
  await expect(page.getByRole('button', { name: 'Erase mask', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(mask.x, mask.y); await page.mouse.down(); await page.mouse.up();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  await page.reload();
  await enterEmptyWorkspace(page);
  await page.getByRole('button', { name: 'Load page previews', exact: true }).click();
  await expect(page.locator('.gallery-thumbnail')).toBeVisible();
  await page.locator('.gallery-open').click();
  await expect(canvas.locator('.annotation-shape')).toHaveCount(2);
  await expect(canvas.locator('.annotation-mask')).toHaveCount(1);
  await expect(canvas.locator('.annotation-point')).toHaveCount(1);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('native');
  await page.getByRole('button', { name: 'Choose destination & export', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const exported = await page.evaluate(() => Object.keys((window as unknown as { __exportedFiles: Record<string, unknown> }).__exportedFiles));
  expect(exported.some(name => name.endsWith('.bin'))).toBe(true);
  await context.setOffline(false);
});

test('encrypted SQLite/OPFS survives worker termination and page reload, rejects wrong keys, and recovers an interrupted write', async ({ page, context }) => {
  const outgoing: string[] = [];
  context.on('request', request => outgoing.push(JSON.stringify({
    url: request.url(), headers: request.headers(), body: request.postData(),
  })));
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  await create(page);
  const canary = 'CANARY_patient_0492_GPS_37.766_SERIAL_note';
  await page.getByLabel('Proof note', { exact: true }).fill(canary);
  await page.getByLabel('Choose a photo').setInputFiles(fixture('metadata.png'));
  await expect(page.getByRole('status')).toContainText('Maximum rendered-pixel difference: 0');
  await page.getByRole('button', { name: 'Save encrypted proof', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved on this device');
  await page.getByRole('button', { name: 'Interrupt synthetic write before commit', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Proof interrupted before database commit');
  await page.getByRole('button', { name: 'Lock and clear memory', exact: true }).click();
  await expect(page.locator('figure')).toHaveCount(0);

  const disk = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    async function files(directory: FileSystemDirectoryHandle): Promise<number[][]> {
      const out: number[][] = [];
      for await (const entry of directory.values()) {
        if (entry.kind === 'file') out.push(Array.from(new Uint8Array(await (await entry.getFile()).arrayBuffer())));
        else out.push(...await files(entry));
      }
      return out;
    }
    return {
      files: await files(root),
      mediaFiles: await files(await root.getDirectoryHandle('annotator-phase1-media')),
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      caches: await caches.keys(),
      databases: await indexedDB.databases(),
    };
  });
  expect(disk.files.length).toBeGreaterThan(0);
  expect(disk.mediaFiles).toHaveLength(2);
  for (const bytes of disk.files) {
    const text = Buffer.from(bytes).toString('latin1');
    for (const secret of [canary, passphrase, 'metadata.png', 'CANARY_CAMERA', 'CANARY_SERIAL']) expect(text).not.toContain(secret);
    expect(Buffer.from(bytes).includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(false);
  }
  expect(disk.local).toBe('{}'); expect(disk.session).toBe('{}');
  expect(disk.caches).toEqual([]); expect(disk.databases).toEqual([]);

  await page.reload();
  await open(page);
  expect(await page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('annotator-phase1-media');
    let files = 0;
    for await (const _entry of directory.values()) files++;
    return files;
  })).toBe(1);
  await page.getByLabel('Passphrase', { exact: true }).fill('this is not the passphrase');
  await page.getByRole('button', { name: 'Unlock proof vault', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to unlock');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock proof vault', exact: true }).click();
  await page.getByRole('button', { name: 'Read proof 1', exact: true }).click();
  await expect(page.getByTestId('decrypted-note')).toHaveText(canary);
  const result = await pixels(page);
  expect([result.width, result.height]).toEqual([30, 20]);
  for (const request of outgoing) {
    for (const sensitive of [canary, passphrase, 'metadata.png', 'CANARY_CAMERA', 'CANARY_SERIAL']) expect(request).not.toContain(sensitive);
    expect(JSON.parse(request).url).toMatch(new RegExp(`^(?:blob:)?${origin.replaceAll('.', '\\.')}/`));
  }
});

test('single-writer lock rejects a second tab and releases on termination', async ({ page, context }) => {
  await page.goto('/'); await create(page);
  const second = await context.newPage();
  await second.goto('/');
  await showLab(second);
  await second.getByRole('button', { name: 'Open proof vault', exact: true }).click();
  await expect(second.locator('.proof-lab').getByRole('alert')).toContainText('another tab');
  await page.getByRole('button', { name: 'Lock and clear memory', exact: true }).click();
  await unlock(second);
  await second.close();
});

test('existing vault is preserved on the workspace dashboard after closing developer tools', async ({ page }) => {
  await page.goto('/');
  await create(page);
  await page.getByLabel('Proof note', { exact: true }).fill('proof preserved during workspace handoff');
  await page.getByRole('button', { name: 'Save encrypted proof', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved on this device');
  await page.locator('details.developer-tools summary').click();
  await expect(page.locator('.workspace-tile')).toContainText('Existing workspace');
  await page.locator('.workspace-tile').click();
  await expect(page.getByLabel('Workspace passphrase')).toBeVisible();
  await page.getByLabel('Workspace passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.getByText('Drop images here', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await unlock(page);
  await page.getByRole('button', { name: 'Read proof 1', exact: true }).click();
  await expect(page.getByTestId('decrypted-note')).toHaveText('proof preserved during workspace handoff');
});

for (const version of [3, 4]) test(`schema ${version} catalogs migrate without changing saved annotations, media, or workspace access`, async ({ page }) => {
  await page.goto('/');
  await create(page);
  await page.locator('details.developer-tools summary').click();
  await page.locator('.workspace-tile').click();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.getByRole('button', { name: 'class_0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  const media = () => page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('annotator-phase1-media');
    const files: Record<string, number[]> = {};
    for await (const handle of directory.values()) {
      if (handle.kind === 'file') files[handle.name] = Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
    }
    return files;
  });
  const before = await media();
  expect(Object.keys(before)).toHaveLength(1);
  if (version === 4) {
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    await page.getByLabel('Workspace name', { exact: true }).fill('Previous catalog dataset');
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.webp'));
    await expect(page.locator('.gallery-item')).toHaveCount(1);
    await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  }
  await page.context().route('**/__test/sqlite.mjs', route => route.fulfill({
    path: fileURLToPath(new URL('../../node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs', import.meta.url)),
    contentType: 'text/javascript',
  }));
  await page.context().route('**/__test/sqlite3.wasm', route => route.fulfill({
    path: fileURLToPath(new URL('../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm', import.meta.url)),
    contentType: 'application/wasm',
  }));
  const entries = await page.evaluate(async () => JSON.parse(await (await (
    await navigator.storage.getDirectory()).getFileHandle('annotator-workspaces.json')).getFile().then(file => file.text())));
  // Recreate either previous catalog layout without altering ciphertext.
  await page.context().route('**/__test/migrate.mjs', route => route.fulfill({
    contentType: 'text/javascript',
    body: `import initialize from '/__test/sqlite.mjs';
      try {
        const sqlite = await initialize();
        const pool = await sqlite.installOpfsSAHPoolVfs({name:'annotator-phase1',directory:'.annotator-phase1-sql',initialCapacity:6});
        const db = new pool.OpfsSAHPoolDb('/proof.sqlite3');
        db.exec('DROP TABLE workspace_catalog; PRAGMA user_version=${version};');
        db.exec('DROP TABLE dataset_schema;');
        if (${version} === 4) {
          db.exec('CREATE TABLE workspace_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, password_protected INTEGER NOT NULL, created_at TEXT NOT NULL)');
          for (const entry of ${JSON.stringify(entries)}) db.exec({
            sql:'INSERT INTO workspace_catalog(id,name,password_protected,created_at) VALUES(?,?,?,?)',
            bind:[entry.id,entry.name,entry.passwordProtected ? 1 : 0,entry.createdAt]
          });
        }
        const count = db.selectValue('SELECT count(*) FROM workspace_records');
        db.close(); self.postMessage({count});
      } catch (error) { self.postMessage({error:String(error)}); }`,
  }));
  const downgraded = await page.evaluate(async () => {
    const worker = new Worker('/__test/migrate.mjs', { type: 'module' });
    try {
      return await new Promise<{ count?: number; error?: string }>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
      });
    } finally { worker.terminate(); }
  });
  expect(downgraded).toEqual({ count: 1 });
  await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('annotator-workspaces.json'));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const requests: unknown[] = [];
    Object.assign(window, { __schemaRequests: requests });
    window.Worker = class extends NativeWorker {
      override postMessage(message: { payload?: { type?: string; index?: number } }, options?: StructuredSerializeOptions | Transferable[]) {
        if (message.payload?.type?.startsWith('schema-')) requests.push(message.payload);
        if (message.payload?.type === 'schema-finish' && sessionStorage.getItem('schema-interrupted') !== 'yes') {
          sessionStorage.setItem('schema-interrupted', 'yes');
          return;
        }
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
  await page.reload();
  const legacyTile = page.locator('.workspace-tile').filter({ has: page.getByText('Existing workspace', { exact: true }) });
  await expect(legacyTile).toBeVisible();
  await legacyTile.click();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('schema-interrupted'))).toBe('yes');
  await expect(page.getByRole('heading', { name: 'Preparing dataset schema', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace sections' })).toHaveCount(0);
  await page.reload();
  await legacyTile.click();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __schemaRequests: unknown[] }).__schemaRequests))
    .toContainEqual({ type: 'schema-step', index: 0 });
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: 'metadata.png annotation canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  expect(await media()).toEqual(before);
  if (version === 4) {
    await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
    await expect(page.locator('.workspace-tile')).toHaveCount(2);
    await page.locator('.workspace-tile').filter({ has: page.getByText('Previous catalog dataset', { exact: true }) }).click();
    await expect(page.locator('.gallery-item')).toHaveCount(1);
    await expect(page.locator('.gallery-item')).toContainText('metadata.webp');
  }
});

test('dashboard stays available while legacy data is open and only that dataset needs a lock retry', async ({ page, context }) => {
  await page.goto('/');
  await create(page);
  const second = await context.newPage();
  const folder = await mkdtemp(join(os.tmpdir(), 'annotator-lock-retry-'));
  try {
    await copyFile(fixture('metadata.png'), join(folder, 'queued.png'));
    await second.goto('/');
    await expect(second.getByRole('alert')).toHaveCount(0);
    await expect(second.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
    await expect(second.locator('.workspace-tile')).toContainText('Existing workspace');
    await second.locator('.workspace-tile').click();
    await expect(second.getByRole('alert')).toContainText('already open in another tab');
    await second.getByRole('button', { name: 'Retry opening workspace', exact: true }).click();
    await expect(second.getByRole('alert')).toContainText('already open in another tab');
    await page.close();
    await second.getByRole('button', { name: 'Retry opening workspace', exact: true }).click();
    await expect(second.getByRole('alert')).toHaveCount(0);
    await second.getByLabel('Workspace passphrase').fill(passphrase);
    await second.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
    await second.getByLabel('Choose a dataset folder').setInputFiles(folder);
    await expect(second.locator('.gallery-item')).toHaveCount(1);
    await expect(second.locator('.gallery-open')).toContainText('queued.png');
    await second.locator('.gallery-open').click();
    await expect(second.getByRole('img', { name: 'queued.png annotation canvas' })).toBeVisible();
    await second.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  } finally {
    await second.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('different workspaces can edit concurrently while dashboards load and the same workspace stays protected', async ({ page, context }) => {
  await page.goto('/');
  await enterEmptyWorkspace(page);
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.png'));
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.locator('.workspace-tile')).toHaveCount(1);
  await expect(second.getByRole('alert')).toHaveCount(0);
  await second.getByRole('button', { name: 'New workspace', exact: true }).click();
  await second.getByLabel('Workspace name', { exact: true }).fill('Second tab dataset');
  await second.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(second.getByText('Drop images here', { exact: true })).toBeVisible();
  await second.getByLabel('Add images', { exact: true }).setInputFiles(fixture('metadata.webp'));
  await expect(second.locator('.gallery-item')).toHaveCount(1);
  for (const tab of [page, second]) {
    await tab.locator('.gallery-open').click();
    await tab.getByRole('button', { name: 'Image labels', exact: true }).click();
    await tab.getByRole('button', { name: 'class_0', exact: true }).click();
    await expect(tab.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  }
  const third = await context.newPage();
  await third.goto(page.url());
  await expect(third.locator('.workspace-tile')).toHaveCount(2);
  await expect(third.getByRole('alert')).toHaveCount(0);
  await third.locator('.workspace-tile').filter({ has: third.getByText('Test dataset', { exact: true }) }).click();
  await expect(third.getByRole('alert')).toContainText('Only this dataset is locked');
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.locator('.workspace-tile')).toHaveCount(2);
  await third.getByRole('button', { name: 'Retry opening workspace', exact: true }).click();
  await third.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await third.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await third.locator('.gallery-open').click();
  await expect(third.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await second.close();
  await third.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await third.locator('.workspace-tile').filter({ has: third.getByText('Second tab dataset', { exact: true }) }).click();
  await third.locator('.gallery-open').click();
  await expect(third.getByRole('button', { name: 'class_0 · label', exact: true })).toBeVisible();
  await expect(third.getByRole('img', { name: 'metadata.webp annotation canvas' })).toBeVisible();
  await third.close();
});

test('simultaneous workspace creation in two tabs preserves both catalog entries', async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([page.goto('/'), second.goto('/')]);
  for (const [tab, name] of [[page, 'Concurrent A'], [second, 'Concurrent B']] as const) {
    await expect(tab.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
    await tab.getByRole('button', { name: 'New workspace', exact: true }).click();
    await tab.getByLabel('Workspace name', { exact: true }).fill(name);
  }
  await Promise.all([page, second].map(tab => tab.getByRole('button', { name: 'Create workspace', exact: true }).click()));
  for (const tab of [page, second]) {
    await expect(tab.getByText('Drop images here', { exact: true })).toBeVisible();
    await expect(tab.getByRole('alert')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(page.locator('.workspace-tile')).toHaveCount(2);
  await second.getByRole('button', { name: 'Exit workspace', exact: true }).click();
  await expect(second.locator('.workspace-tile')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.workspace-tile')).toHaveCount(2);
  expect((await page.locator('.workspace-tile-name').allTextContents()).sort()).toEqual(['Concurrent A', 'Concurrent B']);
  await second.close();
});

test('a committed record survives closing the tab without locking', async ({ page, context }) => {
  await page.goto('/'); await create(page);
  await page.getByLabel('Proof note', { exact: true }).fill('committed-before-tab-close');
  await page.getByRole('button', { name: 'Save encrypted proof', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved on this device');
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/'); await unlock(reopened);
  await reopened.getByRole('button', { name: 'Read proof 1', exact: true }).click();
  await expect(reopened.getByTestId('decrypted-note')).toHaveText('committed-before-tab-close');
});

test('every EXIF orientation is applied and identifying metadata is absent in output', async ({ page }) => {
  await page.goto('/');
  await showLab(page);
  const topLeftColors = [
    [240, 20, 10], [20, 40, 240], [10, 220, 230], [240, 220, 10],
    [240, 20, 10], [240, 220, 10], [10, 220, 230], [20, 40, 240],
  ];
  for (let orientation = 1; orientation <= 8; orientation++) {
    await page.getByLabel('Choose a photo').setInputFiles(fixture(`orientation-${orientation}.jpg`));
    await expect(page.getByRole('status')).toContainText('Maximum rendered-pixel difference: 0');
    const result = await pixels(page);
    expect([result.width, result.height]).toEqual(orientation <= 4 ? [30, 20] : [20, 30]);
    result.center.slice(0, 3).forEach((value, channel) => expect(Math.abs(value - topLeftColors[orientation - 1]![channel]!)).toBeLessThan(6));
    const output = await downloadPng(page);
    const metadata = await sharp(output).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const outputTopLeft = decoded.data.subarray(5 * decoded.info.width * 4 + 5 * 4, 5 * decoded.info.width * 4 + 5 * 4 + 3);
    outputTopLeft.forEach((value, channel) =>
      expect(Math.abs(value - topLeftColors[orientation - 1]![channel]!)).toBeLessThan(6));
    expect(Buffer.from(output).toString('latin1')).not.toContain('CANARY');
  }
});

test('PNG/WebP metadata and alpha are sanitized; uncertified inputs fail explicitly', async ({ page }) => {
  await page.goto('/');
  await showLab(page);
  for (const name of ['metadata.png', 'metadata.webp', 'alpha.png', 'gamma-text.png']) {
    await page.getByLabel('Choose a photo').setInputFiles(fixture(name));
    await expect(page.getByRole('status')).toContainText('Maximum rendered-pixel difference: 0');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await pixels(page)).width).toBe(30);
    const output = await downloadPng(page), metadata = await sharp(output).metadata();
    expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined();
    expect(output.toString('latin1')).not.toContain('CANARY');
    if (name === 'metadata.png' || name === 'metadata.webp' || name === 'alpha.png') {
      const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const sample = (x: number, y: number) => Array.from(
        decoded.data.subarray((y * decoded.info.width + x) * 4, (y * decoded.info.width + x) * 4 + 4),
      );
      expect(sample(5, 5)).toEqual(name === 'alpha.png' ? [240, 20, 10, 155] : [240, 20, 10, 255]);
      if (name !== 'alpha.png') {
        expect(sample(15, 5)).toEqual([10, 220, 30, 255]);
        expect(sample(25, 15)).toEqual([10, 220, 230, 255]);
      }
    }
  }
  for (const [name, error] of [
    ['icc.png', 'ICC-profiled'], ['sixteen-bit.png', '16-bit'],
    ['animated.webp', 'Animated'], ['invalid.png', 'Only JPEG'],
  ]) {
    await page.getByLabel('Choose a photo').setInputFiles(fixture(name!));
    await expect(page.getByRole('alert')).toContainText(error!);
    await expect(page.locator('figure')).toHaveCount(0);
  }
});

test('reference media and key/commit feasibility measurements', async ({ page, browser }, testInfo) => {
  const timings: Record<string, number> = {};
  await page.goto('/');
  let start = performance.now();
  await create(page);
  timings.createAndWrapWallMs = performance.now() - start;
  const source = await readFile(fixture('reference.png'));
  start = performance.now();
  await page.getByLabel('Choose a photo').setInputFiles(fixture('reference.png'));
  await expect(page.getByRole('status')).toContainText('Maximum rendered-pixel difference: 0');
  timings.sanitizeWallMs = performance.now() - start;
  expect(await pixels(page)).toMatchObject({ width: 2048, height: 1536 });
  const output = await downloadPng(page);
  await page.getByLabel('Proof note', { exact: true }).fill('reference-media-proof');
  start = performance.now();
  await page.getByRole('button', { name: 'Save encrypted proof', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved on this device');
  timings.saveWallMs = performance.now() - start;
  const commitMessage = await page.getByRole('status').innerText();
  await page.getByRole('button', { name: 'Lock and clear memory', exact: true }).click();
  start = performance.now(); await unlock(page);
  timings.unlockWallMs = performance.now() - start;
  await page.getByRole('button', { name: 'Read proof 1', exact: true }).click();
  await expect(page.getByTestId('decrypted-note')).toHaveText('reference-media-proof');
  const restored = await downloadPng(page);
  expect(restored.equals(output)).toBe(true);
  const report = {
    fixture: 'synthetic-blocks-v1', dimensions: [2048, 1536], inputBytes: source.length,
    outputBytes: output.length, maxRenderedPixelDifference: 0,
    browser: browser.version(), headed: false, cpu: os.cpus()[0]?.model,
    cores: os.cpus().length, ramBytes: os.totalmem(), platform: `${os.type()} ${os.release()}`,
    timings, commitMessage,
    caveat: 'One image and one commit; wall times include browser automation. Not a 10000-image or memory benchmark.',
  };
  await testInfo.attach('phase-1-feasibility.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});

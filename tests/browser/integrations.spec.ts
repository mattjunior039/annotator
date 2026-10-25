import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';
import { editorConnections } from '../../src/ai/editor-connection';
import { visionProviders } from '../../src/ai/providers';
import { z } from 'zod';

async function openImage(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Friends and AI');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByLabel('Add images', { exact: true }).setInputFiles(fileURLToPath(new URL('../fixtures/generated/metadata.png', import.meta.url)));
  await page.locator('.gallery-open').click();
}

for (const provider of visionProviders) {
  test(`website BYOK ${provider.name}: explicit crop consent, reviewed boxes and undo`, async ({ page }) => {
    const requests: Record<string, unknown>[] = [];
    await page.route(provider.endpoint, async route => {
      const request = route.request();
      const payload = request.postDataJSON() as { messages: { content: string | { type: string; image_url?: { url: string } }[] }[] };
      requests.push(payload);
      expect(request.method()).toBe('POST');
      expect(request.headers()['authorization']).toBe(`Bearer disposable-test-key`);
      const content = payload.messages[1]!.content;
      if (typeof content === 'string') throw new Error('Expected multimodal content.');
      const image = content.find(item => item.type === 'image_url')!.image_url!.url;
      const png = Buffer.from(image.split(',')[1]!, 'base64');
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([30, 20]);
      expect([...data.subarray((2 * 30 + 2) * 3, (2 * 30 + 2) * 3 + 3)]).toEqual([0, 0, 0]);
      expect(JSON.stringify(payload)).not.toContain('metadata.png');
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({
        detections: [{ label: 'test object', x: 0.1, y: 0.1, width: 0.3, height: 0.4, confidence: 0.9 }],
      }) } }] } });
    });
    await openImage(page);
    await page.getByRole('button', { name: 'AI suggestions', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'AI suggestions', exact: true });
    await dialog.getByRole('combobox', { name: 'AI provider', exact: true }).selectOption(provider.id);
    await dialog.getByLabel('Model', { exact: true }).fill('test-vision');
    await dialog.getByLabel('API key (used in memory only)', { exact: true }).fill('disposable-test-key');
    const redactions = dialog.getByRole('group', { name: 'Opaque redactions (image pixels)' });
    for (const [field, value] of Object.entries({ x: '1', y: '1', width: '4', height: '4' })) {
      await redactions.getByLabel(field, { exact: true }).fill(value);
    }
    await redactions.getByRole('button', { name: 'Add black rectangle' }).click();
    await dialog.getByRole('button', { name: 'Prepare local preview' }).click();
    const send = dialog.getByRole('button', { name: 'Send crop for suggestions', exact: true });
    await expect(send).toBeDisabled();
    expect(requests).toHaveLength(0);
    await dialog.getByRole('checkbox', { name: /I consent to send this previewed PNG/ }).check();
    await send.click();
    await expect(dialog.getByRole('heading', { name: 'Review cloud suggestions before adding' })).toBeVisible();
    expect(requests).toHaveLength(1);
    await expect(dialog.getByRole('checkbox', { name: /I consent to send this previewed PNG/ })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Add all 1 suggestions', exact: true }).click();
    const boxes = page.locator('rect.annotation-shape');
    await expect(boxes).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(boxes).toHaveCount(0);
    await page.getByRole('button', { name: 'AI suggestions', exact: true }).click();
    await expect(page.getByLabel('API key (used in memory only)', { exact: true })).toHaveValue('');
  });
}

for (const editor of editorConnections) {
  test(`${editor.name}: code pairing, approved image viewing, reviewed and automatic dataset edits, undo`, async ({ page, baseURL }) => {
    // A real editor (e.g. VS Code with this repository's .vscode/mcp.json) may already own the fixed port.
    const busy = await new Promise<boolean>(resolve => {
      const probe = createServer().once('error', () => resolve(true))
        .listen(editor.port, '127.0.0.1', () => probe.close(() => resolve(false)));
    });
    test.skip(busy, `Port ${editor.port} is in use by a running annotator companion; close that editor's MCP server to run this test.`);
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--experimental-strip-types', 'services/bridge/node-server.ts'],
      cwd: process.cwd(), env: { BRIDGE_PORT: String(editor.port), BRIDGE_ORIGINS: new URL(baseURL!).origin },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'browser-connection-test', version: '1.0.0' });
    const result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({
      type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional(),
    })) });
    const call = async (name: string, args: Record<string, unknown> = {}) => result.parse(await client.callTool({ name, arguments: args }));
    const json = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await call(name, args);
      expect(response.isError, response.content[0]?.text).not.toBe(true);
      return JSON.parse(response.content[0]!.text!) as unknown;
    };
    try {
      await client.connect(transport);
      await page.goto('/');
      await page.getByRole('button', { name: 'New workspace', exact: true }).click();
      await page.getByLabel('Workspace name', { exact: true }).fill('Friends and AI');
      await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
      await page.getByLabel('Add images', { exact: true }).setInputFiles(['metadata.png', 'alpha.png'].map(name =>
        fileURLToPath(new URL(`../fixtures/generated/${name}`, import.meta.url))));
      await expect(page.locator('.gallery-item')).toHaveCount(2);

      await page.getByRole('button', { name: 'AI editor', exact: true }).click();
      const panel = page.getByRole('region', { name: 'AI editor connection' });
      await panel.getByRole('combobox', { name: 'AI editor', exact: true }).selectOption(editor.id);
      await panel.getByText(/First-time setup/).click();
      await panel.getByLabel('App folder on this computer', { exact: true }).fill(process.cwd());
      const configuration = JSON.parse(await panel.getByLabel('Editor MCP configuration', { exact: true }).innerText());
      expect((configuration.servers ?? configuration.mcpServers).annotator.env.BRIDGE_PORT).toBe(String(editor.port));
      await panel.getByRole('button', { name: 'Connect', exact: true }).click();
      const code = await panel.getByLabel('Connection code').innerText();
      expect(code).toMatch(/^\d{6}$/);
      expect((await call('bridge_pair', { code: code === '000000' ? '111111' : '000000' })).isError).toBe(true);
      await json('bridge_pair', { code });
      await expect(panel.getByRole('status').filter({ hasText: `Connected to ${editor.name}` })).toBeVisible();

      const listed = await json('list_images') as { total: number; images: { id: string; width: number; height: number }[] };
      expect(listed.total).toBe(2);
      expect(JSON.stringify(listed)).not.toMatch(/metadata|alpha|\.png/);
      const first = listed.images[0]!, second = listed.images[1]!;

      const declined = call('view_images', { imageIds: [first.id] });
      await panel.getByRole('alert').filter({ hasText: 'wants to view 1 image' }).getByRole('button', { name: 'Decline' }).click();
      expect((await declined).content[0]!.text).toMatch(/^declined/);

      const viewing = call('view_images', { imageIds: [first.id, second.id], maxSize: 256 });
      const request = panel.getByRole('alert').filter({ hasText: 'wants to view 2 images' });
      await expect(request.getByRole('img')).toHaveCount(2);
      await request.getByRole('button', { name: 'Allow' }).click();
      const viewed = await viewing;
      const images = viewed.content.filter(item => item.type === 'image');
      expect(images).toHaveLength(2);
      for (const image of images) {
        expect(image.mimeType).toBe('image/jpeg');
        expect(Buffer.from(image.data!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      }

      const reviewed = json('annotate', { units: 'normalized', edits: [
        { imageId: first.id, add: [{ label: 'widget', box: [0.1, 0.1, 0.5, 0.5] }, { label: 'outdoor' }] },
      ] });
      const proposal = panel.getByRole('alert').filter({ hasText: 'proposes these edits' });
      await expect(proposal).toContainText('2 added, 0 changed, 0 removed on 1 image; new classes: widget, outdoor');
      await proposal.getByRole('button', { name: 'Apply edits' }).click();
      expect(await reviewed).toMatchObject({ state: 'applied', createdClasses: ['widget', 'outdoor'] });
      const firstItem = page.locator('.gallery-item').filter({ hasText: '2 annotations · annotated' });
      await expect(firstItem).toHaveCount(1);
      const firstName = (await firstItem.locator('.gallery-name').innerText()).trim();
      const secondName = firstName === 'metadata.png' ? 'alpha.png' : 'metadata.png';

      const rejected = json('annotate', { edits: [{ imageId: second.id, add: [{ label: 'widget' }] }] });
      await panel.getByRole('alert').filter({ hasText: 'proposes these edits' }).getByRole('button', { name: 'Reject' }).click();
      expect(await rejected).toMatchObject({ state: 'rejected' });

      await panel.getByLabel(/Apply edits automatically/).check();
      const read = await json('get_annotations', { imageIds: [first.id] }) as { images: { revision: number; annotations: { id: string; kind: string; label: string }[] }[] };
      const box = read.images[0]!.annotations.find(item => item.kind === 'box')!;
      expect(box.label).toBe('widget');
      await json('annotate', { edits: [
        { imageId: first.id, expectedRevision: read.images[0]!.revision, update: [{ id: box.id, box: [0, 0, 4, 4] }] },
        { imageId: second.id, add: [{ label: 'widget', box: [1, 1, 5, 5] }], review: 'reviewed' },
      ] });
      const secondItem = page.locator('.gallery-item').filter({ hasText: secondName });
      await expect(secondItem).toContainText('1 annotations · reviewed');
      expect((await call('annotate', { edits: [{ imageId: first.id, expectedRevision: 0, remove: [box.id] }] })).content[0]!.text).toMatch(/^stale/);

      await page.locator('.gallery-item').filter({ hasText: firstName }).locator('.gallery-open').click();
      const canvas = page.getByRole('img', { name: `${firstName} annotation canvas`, exact: true });
      await expect(canvas.locator('rect.annotation-shape')).toHaveAttribute('width', '4');
      await json('annotate', { edits: [{ imageId: first.id, add: [{ label: 'widget', box: [5, 5, 3, 3] }] }] });
      await expect(canvas.locator('rect.annotation-shape')).toHaveCount(2);
      await page.getByRole('toolbar', { name: 'Edit actions' }).getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(canvas.locator('rect.annotation-shape')).toHaveCount(1);

      const activity = panel.getByRole('region', { name: 'AI editor activity' });
      await activity.getByRole('button', { name: /^Undo: .*1 added, 1 changed/ }).click();
      await expect(activity).toContainText('Undid AI edits on 2 images');
      await expect(canvas.locator('rect.annotation-shape')).not.toHaveAttribute('width', '4');
      await page.getByRole('button', { name: 'Dataset', exact: true }).click();
      await expect(secondItem).toContainText('0 annotations');

      await expect(page.getByRole('button', { name: `${editor.name} connected` })).toBeVisible();
      await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
      expect(await json('bridge_status')).toMatchObject({ connected: false });
      expect((await call('list_images')).isError).toBe(true);
    } finally { await client.close(); await transport.close(); }
  });
}

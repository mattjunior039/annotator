import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';
import { editorConnections } from '../../src/ai/editor-connection';
import { visionProviders } from '../../src/ai/providers';
import { snapshotSchema } from '../../services/bridge/protocol';
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
  test(`${editor.name} configuration and real browser-to-MCP pairing, reviewed proposal and revocation`, async ({ page, baseURL }) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--experimental-strip-types', 'services/bridge/node-server.ts'],
      cwd: process.cwd(), env: { BRIDGE_PORT: String(editor.port), BRIDGE_ORIGINS: new URL(baseURL!).origin },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'browser-connection-test', version: '1.0.0' });
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const text = z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) })
        .parse(result).content.find(item => item.type === 'text');
      if (!text || text.type !== 'text') throw new Error('MCP response contains no text.');
      return JSON.parse(text.text) as unknown;
    }
    try {
      await client.connect(transport);
      await openImage(page);
      const canvas = page.getByRole('img', { name: 'metadata.png annotation canvas', exact: true });
      const points = await canvas.evaluate(element => {
        const matrix = (element as SVGSVGElement).getScreenCTM()!;
        return [[2, 2], [10, 10]].map(([x, y]) => {
          const point = new DOMPoint(x, y).matrixTransform(matrix); return { x: point.x, y: point.y };
        });
      });
      await page.mouse.move(points[0]!.x, points[0]!.y); await page.mouse.down();
      await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 4 }); await page.mouse.up();
      await expect(canvas.locator('rect.annotation-shape')).toHaveCount(1);
      await expect(page.locator('.save-indicator')).toContainText('Saved on this device');
      await page.getByRole('button', { name: 'Local MCP companion', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Local annotation companion', exact: true });
      await dialog.getByRole('combobox', { name: 'AI editor', exact: true }).selectOption(editor.id);
      await dialog.getByText('Set up Copilot or Antigravity', { exact: true }).click();
      await dialog.getByLabel('Companion installation folder', { exact: true }).fill(process.cwd());
      const configuration = JSON.parse(await dialog.getByLabel('Editor MCP configuration', { exact: true }).innerText());
      const server = (configuration.servers ?? configuration.mcpServers).annotator;
      expect(server.env.BRIDGE_PORT).toBe(String(editor.port));
      const params = JSON.parse(await dialog.getByLabel('MCP pairing parameters', { exact: true }).innerText()) as Record<string, unknown>;
      const pairing = z.object({ token: z.string() }).parse(await call('bridge_pair', params));
      await dialog.getByLabel('MCP pairing token (entered manually; never stored)', { exact: true }).fill(pairing.token);
      await dialog.getByLabel('View approved box metadata', { exact: true }).check();
      await dialog.getByLabel('Count approved boxes', { exact: true }).check();
      await dialog.getByLabel('Propose box edits for review', { exact: true }).check();
      await dialog.getByLabel('I approve this workspace and the selected scopes for the current image only.', { exact: true }).check();
      await dialog.getByRole('button', { name: 'Approve and pair', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Revoke and clear', exact: true })).toBeVisible();
      const snapshot = snapshotSchema.parse(await call('annotation_metadata'));
      expect(JSON.stringify(snapshot)).not.toContain('metadata.png');
      const annotation = snapshot.annotations[0]!;
      await call('propose_annotation_patch', {
        baseRevision: snapshot.revision, operations: [{ type: 'replace-box', annotation: { ...annotation, box: [3, 2, 8, 8] } }],
      });
      await dialog.getByRole('button', { name: 'Refresh now', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'Proposals awaiting your review' })).toBeVisible();
      await dialog.getByRole('checkbox', { name: /I reviewed and approve this proposal/ }).check();
      await dialog.getByRole('button', { name: 'Apply approved proposal', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('Proposal applied');
      await dialog.getByRole('button', { name: 'Revoke and clear', exact: true }).click();
      expect(await call('bridge_status')).toMatchObject({ authorized: false, approvedDataAvailable: false });
      await dialog.getByRole('button', { name: 'Close companion', exact: true }).click();
      await expect(canvas.locator('rect.annotation-shape')).toHaveAttribute('x', '3');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(canvas.locator('rect.annotation-shape')).toHaveAttribute('x', String(annotation.box[0]));
    } finally { await client.close(); await transport.close(); }
  });
}

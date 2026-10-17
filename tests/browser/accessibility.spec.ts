import { expect, test } from '@playwright/test';
import axe from 'axe-core';
import { fileURLToPath } from 'node:url';

declare global {
  interface Window {
    axe: {
      run: (context: Document, options: { runOnly: { type: string; values: string[] } }) => Promise<{
        violations: {
          id: string;
          impact: string | null;
          help: string;
          nodes: { target: string[]; failureSummary: string | null }[];
        }[];
      }>;
    };
  }
}

async function checkAccessibility(page: import('@playwright/test').Page, name: string) {
  const results = await page.evaluate(async () => {
    const report = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return report.violations.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map(node => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    }));
  });
  expect(results, `${name} accessibility violations`).toEqual([]);
}

test('workspace dashboard and editor meet automated WCAG 2.2 AA checks', async ({ page }) => {
  await page.addInitScript({ content: axe.source });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'New workspace', exact: true })).toBeFocused();
  await checkAccessibility(page, 'Workspace dashboard');

  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Accessibility test');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add images', exact: true })).toBeVisible();
  await checkAccessibility(page, 'Empty workspace dashboard');
  await page.getByLabel('Add images', { exact: true }).setInputFiles(
    fileURLToPath(new URL('../fixtures/generated/metadata.png', import.meta.url)),
  );
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await checkAccessibility(page, 'Dataset gallery');
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await checkAccessibility(page, 'Dataset schema controls');
  await page.getByText('Dataset classes and skeletons', { exact: true }).click();
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: 'metadata.png annotation canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await checkAccessibility(page, 'Export dialog');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.workspace').focus();
  await page.keyboard.press('4');
  await expect(page.getByRole('button', { name: 'Keypoint', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Select', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Box', exact: true })).toBeFocused();
  await checkAccessibility(page, 'Annotation editor');
});

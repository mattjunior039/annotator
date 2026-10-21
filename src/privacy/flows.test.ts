import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PrivacyFlowExplorer } from './PrivacyFlowExplorer';
import { disclosureLabels, getPrivacyFlow, privacyFlows, privacyViews } from './flows';

describe('privacy flow inventory', () => {
  it('distinguishes shipped workflows from unimplemented capabilities', () => {
    expect(privacyFlows.filter(flow => flow.availability === 'implemented').map(flow => flow.id))
      .toEqual(['local', 'live-relay', 'live-direct', 's3-sharing', 'file-sharing', 'mcp-bridge', 'local-inference', 'cloud-vision']);
    expect(privacyFlows.filter(flow => flow.availability === 'planned').map(flow => flow.id))
      .toEqual(['cloud-sync']);
    expect(new Set(privacyFlows.map(flow => flow.id)).size).toBe(privacyFlows.length);
    for (const view of privacyViews) expect(privacyFlows.some(flow => flow.view === view.id)).toBe(true);
  });

  for (const flow of privacyFlows) {
    it(`renders complete accessible text for ${flow.id} without activating a capability`, () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
      try {
        const html = renderToStaticMarkup(createElement(PrivacyFlowExplorer, { initialFlow: flow.id }));
        expect(getPrivacyFlow(flow.id)).toBe(flow);
        expect(html).toContain('<fieldset>');
        expect(html).toContain('<legend>Privacy view</legend>');
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('scope="col"');
        expect(html).toContain('scope="row"');
        expect(html).toContain('<caption>');
        expect(html).toContain('Complete text/table equivalent');
        expect(html).toContain(flow.availability === 'implemented'
          ? 'Implemented — requires explicit action and supported configuration'
          : 'Not yet available — planned design only');
        for (const step of flow.steps) {
          expect(step.boundary.length).toBeGreaterThan(0);
          expect(step.bytes.length).toBeGreaterThan(0);
          expect(step.protection.length).toBeGreaterThan(0);
          expect(step.visible.length).toBeGreaterThan(0);
        }
        for (const disclosure of flow.disclosures) expect(html).toContain(disclosureLabels[disclosure]);
        expect(html).not.toMatch(/<(img|iframe|video|audio|form)\b/);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    });
  }

  it('preserves important local, peer, S3 and future AI limitations', () => {
    const text = (id: Parameters<typeof getPrivacyFlow>[0]) => JSON.stringify(getPrivacyFlow(id));
    expect(text('local')).toContain('no-password workspaces persist their key locally');
    expect(text('local')).toContain('Exports are plaintext');
    expect(text('live-relay')).toContain('Starting contacts the relay before any guest is approved');
    expect(text('live-direct')).toContain('no TURN server');
    expect(text('live-direct')).toContain('IP addresses are disclosed');
    expect(text('s3-sharing')).toContain('annotation changes only');
    expect(text('s3-sharing')).toContain('expiry does not delete stored objects');
    expect(text('s3-sharing')).toContain('No automatic polling');
    expect(text('mcp-bridge')).toContain('forward tool results to its cloud backend');
    expect(text('local-inference')).toContain('No silent fallback to a cloud provider');
    expect(text('cloud-vision')).toContain('it receives plaintext pixels');
  });
});

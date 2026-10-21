import { describe, expect, it } from 'vitest';
import { editorConfig } from './editor-connection';

describe('editor companion configuration', () => {
  it('generates distinct official stdio configuration shapes and ports', () => {
    const copilot = JSON.parse(editorConfig('copilot', '/opt/annotator/', 'https://app.example'));
    expect(copilot.servers.annotator).toEqual({
      type: 'stdio', command: 'node',
      args: ['--experimental-strip-types', '/opt/annotator/services/bridge/node-server.ts'],
      env: { BRIDGE_ORIGINS: 'https://app.example', BRIDGE_PORT: '47321' },
    });
    const antigravity = JSON.parse(editorConfig('antigravity', 'C:\\Apps\\annotator', 'http://127.0.0.1:5173'));
    expect(antigravity.mcpServers.annotator.env.BRIDGE_PORT).toBe('47322');
    expect(antigravity.mcpServers.annotator.type).toBeUndefined();
    expect(antigravity.mcpServers.annotator.args[1]).toContain('C:\\Apps\\annotator');
  });
  it('rejects relative installation folders and non-exact or untrustworthy origins', () => {
    expect(() => editorConfig('copilot', 'relative', 'https://app.example')).toThrow('absolute');
    for (const origin of ['https://app.example/', 'http://app.example', 'file:///tmp/app']) {
      expect(() => editorConfig('copilot', '/opt/app', origin)).toThrow();
    }
  });
});

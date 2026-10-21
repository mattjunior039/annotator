export const editorConnections = [
  { id: 'copilot', name: 'GitHub Copilot (VS Code)', port: 47321 },
  { id: 'antigravity', name: 'Google Antigravity', port: 47322 },
] as const;
export type EditorConnection = typeof editorConnections[number]['id'];

export function editorConfig(editor: EditorConnection, installation: string, origin: string): string {
  const connection = editorConnections.find(item => item.id === editor)!;
  const folder = installation.trim().replace(/[\\/]+$/, '');
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(folder)) throw new Error('Enter the absolute folder where the annotator companion is installed.');
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('The companion requires an HTTPS app or trustworthy localhost origin.');
  }
  const server = {
    ...(editor === 'copilot' ? { type: 'stdio' } : {}),
    command: 'node',
    args: ['--experimental-strip-types', `${folder}/services/bridge/node-server.ts`],
    env: { BRIDGE_ORIGINS: origin, BRIDGE_PORT: String(connection.port) },
  };
  return JSON.stringify({ [editor === 'copilot' ? 'servers' : 'mcpServers']: { annotator: server } }, null, 2);
}

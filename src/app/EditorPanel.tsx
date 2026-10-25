import { useState } from 'react';
import type { Scope } from '../../services/bridge/protocol';
import { editorConfig, editorConnections } from '../ai/editor-connection';
import type { EditorBridge } from '../ai/useEditorBridge';

const scopeLabels: Record<Scope, string> = {
  metadata: 'Read image sizes, annotations and class names (never filenames)',
  pixels: 'View images I approve',
  propose: 'Add, change and delete annotations',
};
const examplePrompt = 'List the unannotated images, view them a few at a time, and draw a box around every person and car.';

export function EditorPanel({ bridge, onClose }: { bridge: EditorBridge; onClose: () => void }) {
  const [scopes, setScopes] = useState<Scope[]>(['metadata', 'pixels', 'propose']);
  const [installation, setInstallation] = useState('');
  const [copied, setCopied] = useState('');
  const { status, editorName } = bridge;
  let configuration = '', configurationError = '';
  try { configuration = editorConfig(bridge.editor, installation, window.location.origin); }
  catch (failure) { configurationError = failure instanceof Error ? failure.message : 'Invalid companion configuration.'; }
  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopied(label), () => setCopied('Select the text and copy it manually.'));
  };
  const prompt = status.state === 'waiting' ? `Connect to the annotator with code ${status.code}. Then ${examplePrompt.charAt(0).toLowerCase()}${examplePrompt.slice(1)}` : '';

  return <section className="workspace-card editor-bridge" aria-label="AI editor connection">
    <div className="dashboard-heading">
      <h2>AI editor · GitHub Copilot or Antigravity</h2>
      <button type="button" className="text-button" onClick={onClose}>Hide</button>
    </div>

    {bridge.imageRequests.map(request => <div key={request.id} className="editor-request" role="alert">
      <strong>{editorName} wants to view {request.images.length} image{request.images.length === 1 ? '' : 's'}</strong>
      <p>The pixels go to {editorName} and its AI provider. Filenames are not sent.</p>
      <ul className="editor-request-images">{request.images.map(image =>
        <li key={image.id}><img src={image.url} alt={image.name} /><span>{image.name}</span></li>)}</ul>
      <div className="live-actions">
        <button type="button" onClick={() => bridge.decide(request.id, true)}>Allow</button>
        <button type="button" onClick={() => bridge.decide(request.id, false)}>Decline</button>
      </div>
    </div>)}
    {bridge.reviews.map(review => <div key={review.id} className="editor-request" role="alert">
      <strong>{editorName} proposes these edits</strong>
      <ul>{review.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <div className="live-actions">
        <button type="button" onClick={() => bridge.decide(review.id, true)}>Apply edits</button>
        <button type="button" onClick={() => bridge.decide(review.id, false)}>Reject</button>
      </div>
    </div>)}

    {status.state === 'idle' && <>
      <p>Let {editorName} label this dataset. It reads annotations, views the images you approve and adds labels you can undo.
        Your editor's AI service receives what you share.</p>
      <label>AI editor<select value={bridge.editor} onChange={event => {
        const selected = editorConnections.find(item => item.id === event.target.value);
        if (selected) bridge.setEditor(selected.id);
      }}>{editorConnections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <fieldset>
        <legend>Allow {editorName} to</legend>
        {(Object.keys(scopeLabels) as Scope[]).map(scope => <label key={scope} className="protection-choice">
          <input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(previous =>
            event.target.checked ? [...previous, scope] : previous.filter(item => item !== scope))} />
          {scopeLabels[scope]}</label>)}
      </fieldset>
      <label className="protection-choice"><input type="checkbox" checked={bridge.autoApply}
        onChange={event => bridge.setAutoApply(event.target.checked)} />
        Apply edits automatically (each batch can be undone here)</label>
      <label className="protection-choice"><input type="checkbox" checked={bridge.autoShare}
        onChange={event => bridge.setAutoShare(event.target.checked)} />
        Share requested images without asking each time</label>
      {status.message && <p className="error" role="alert">{status.message}</p>}
      <button type="button" className="continue-button" disabled={!scopes.length}
        onClick={() => void bridge.connect(scopes)}>Connect</button>
      <details>
        <summary>First-time setup for {editorName}</summary>
        <ol>
          <li>Install Node.js 22.12 or newer, then download this app's source and run <code>npm ci</code> in that folder. The companion runs on your computer; the website cannot start it.</li>
          <li>Enter that folder below to generate your configuration. It is not your image folder and is not saved.</li>
          <li>{bridge.editor === 'copilot'
            ? 'In VS Code, run “MCP: Open User Configuration”, merge the generated servers entry and start the annotator server. Opening the app folder itself in VS Code also works: it includes .vscode/mcp.json.'
            : 'In Antigravity, open MCP Servers → Manage MCP Servers → View raw config, merge the generated mcpServers entry and refresh.'}</li>
          <li>Click Connect here and give your editor the code that appears.</li>
        </ol>
        <label>App folder on this computer<input value={installation}
          placeholder="/absolute/path/to/annotator" onChange={event => setInstallation(event.target.value)} /></label>
        {configuration ? <>
          <pre aria-label="Editor MCP configuration">{configuration}</pre>
          <button type="button" className="tool-button" onClick={() => copy(configuration, 'Configuration copied.')}>Copy configuration</button>
        </> : <p>{configurationError}</p>}
        <p>Copilot uses local port 47321 and Antigravity 47322. If your browser asks to allow access to devices on your local network, allow it for this site.</p>
        <p><a href="https://code.visualstudio.com/docs/copilot/customization/mcp-servers" target="_blank" rel="noreferrer noopener">Copilot MCP setup</a>
          {' · '}<a href="https://antigravity.google/docs/mcp" target="_blank" rel="noreferrer noopener">Antigravity MCP setup</a></p>
      </details>
    </>}

    {status.state === 'waiting' && <div className="editor-code">
      <p>In {editorName} chat, say:</p>
      <p className="editor-prompt">Connect to the annotator with code <strong aria-label="Connection code">{status.code}</strong></p>
      <div className="live-actions">
        <button type="button" onClick={() => copy(prompt, 'Prompt copied.')}>Copy prompt</button>
        <button type="button" onClick={bridge.cancelPairing}>Cancel</button>
      </div>
      <p>The code expires at {new Date(status.expiresAt).toLocaleTimeString()}.</p>
    </div>}

    {status.state === 'connected' && <>
      <p role="status" className="editor-connected">● Connected to {editorName} · {status.scopes.map(item => item === 'metadata' ? 'read' : item === 'pixels' ? 'view approved images' : 'edit').join(', ')}</p>
      <p>Ask {editorName}, for example: “{examplePrompt}”</p>
      <label className="protection-choice"><input type="checkbox" checked={bridge.autoApply}
        onChange={event => bridge.setAutoApply(event.target.checked)} />
        Apply edits automatically (undo below)</label>
      <label className="protection-choice"><input type="checkbox" checked={bridge.autoShare}
        onChange={event => bridge.setAutoShare(event.target.checked)} />
        Share requested images without asking</label>
      <button type="button" className="tool-button" onClick={() => void bridge.disconnect()}>Disconnect</button>
    </>}

    {copied && <p role="status">{copied}</p>}
    {bridge.activity.length > 0 && <section aria-label="AI editor activity">
      <h3>Activity</h3>
      <ul className="editor-activity">{bridge.activity.map(item => <li key={item.id}>
        <time>{new Date(item.at).toLocaleTimeString()}</time> {item.text}
        {item.undo && <button type="button" className="text-button" disabled={item.undone}
          aria-label={`${item.undone ? 'Undone' : 'Undo'}: ${item.text}`}
          onClick={() => void bridge.undo(item)}>{item.undone ? 'Undone' : 'Undo'}</button>}
      </li>)}</ul>
    </section>}
  </section>;
}

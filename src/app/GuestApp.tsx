import { useState } from 'react';
import type { FormEvent } from 'react';
import { LiveGuest } from '../collaboration/guest';
import type { Invite } from '../collaboration/invite';
import { Workspace } from './Workspace';

type Stage =
  | { kind: 'name' }
  | { kind: 'waiting'; code: string }
  | { kind: 'joined'; guest: LiveGuest; id: string; createdAt: string };

const ignore = () => {};

export function GuestApp({ invite, onExit }: { invite: Invite; onExit: () => void }) {
  const [name, setName] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'name' });
  const [error, setError] = useState('');

  async function join(event: FormEvent) {
    event.preventDefault();
    setError('');
    setStage({ kind: 'waiting', code: '' });
    try {
      const guest = await LiveGuest.join(invite, name.trim(), {
        onCode: code => setStage({ kind: 'waiting', code }),
        onDocument: ignore, onSchema: ignore, onIndex: ignore, onPresence: ignore, onEnded: ignore,
      });
      setStage({ kind: 'joined', guest, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to join the live session.');
      setStage({ kind: 'name' });
    }
  }

  return <div className={`app ${stage.kind === 'joined' ? 'workspace-mode' : 'dashboard-mode'}`}>
    <header className="topbar">
      <span className="brand">annotator<span className="brand-mark">.</span></span>
      <span className="badge">LIVE SESSION · END-TO-END ENCRYPTED</span>
    </header>
    <main>
      {stage.kind === 'joined' ? <Workspace key={stage.id} guest={stage.guest} initialTool="box"
        descriptor={{ id: stage.id, name: stage.guest.workspaceName || 'Live session', passwordProtected: false, createdAt: stage.createdAt }}
        initialPassphrase="" onPassphraseConsumed={ignore} onBack={onExit} />
        : <section className="workspace-dashboard live-join">
          <form className="workspace-card" onSubmit={event => void join(event)}>
            <h1>Join a live session</h1>
            <p>You were invited to annotate someone else's workspace. Images stay in the host's browser and are streamed to you end-to-end encrypted. Nothing from the session is saved on this device.</p>
            {stage.kind === 'name' && <>
              <label htmlFor="live-name">Your name</label>
              <input id="live-name" autoFocus required maxLength={40} value={name}
                onChange={event => setName(event.target.value)} placeholder="Shown to the host and other participants" />
              {error && <p className="error" role="alert">{error}</p>}
              <div className="live-actions">
                <button type="submit" className="continue-button" disabled={!name.trim()}>Ask to join</button>
                <button type="button" className="text-button" onClick={onExit}>Cancel</button>
              </div>
            </>}
            {stage.kind === 'waiting' && <div role="status">
              {stage.code ? <>
                <p>Read this code to the host. They will approve you once it matches the code on their screen:</p>
                <p className="live-code" aria-label="Your verification code">{stage.code}</p>
                <p>Waiting for the host to approve…</p>
              </> : <p>Connecting to the host…</p>}
              <button type="button" className="text-button" onClick={() => window.location.reload()}>Cancel</button>
            </div>}
          </form>
        </section>}
    </main>
  </div>;
}

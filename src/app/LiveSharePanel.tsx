import { useState } from 'react';
import type { LiveHost } from '../collaboration/host';
import type { ConnectionMode } from '../collaboration/link';
import type { Participant } from '../collaboration/protocol';

interface ImageName { id: string; name: string }
interface HostPanelProps {
  host: LiveHost | null;
  mode: ConnectionMode;
  onMode: (mode: ConnectionMode) => void;
  onStart: () => void;
  onStop: () => void;
  ended: string;
  busy: boolean;
  images: readonly ImageName[];
  onClose: () => void;
}

function imageLabel(images: readonly ImageName[], id: string | null) {
  if (!id) return 'Dataset overview';
  return images.find(item => item.id === id)?.name ?? 'An image';
}

export function ParticipantList({ participants, images, you, onRemove }: {
  participants: readonly (Participant & { direct?: boolean })[];
  images: readonly ImageName[];
  you?: string;
  onRemove?: (id: string) => void;
}) {
  return <ul className="live-participants" aria-label="Live session participants">
    {participants.map(person => <li key={person.id}>
      <span className="live-dot" style={{ background: person.color }} aria-hidden="true" />
      <span className="live-person">
        <strong>{person.name}{person.host ? ' (host)' : ''}{person.id === you ? ' (you)' : ''}</strong>
        <small>{imageLabel(images, person.imageId)}{person.direct ? ' · direct connection' : ''}</small>
      </span>
      {onRemove && !person.host && <button type="button" className="text-button" onClick={() => onRemove(person.id)}>Remove</button>}
    </li>)}
  </ul>;
}

export function LiveSharePanel({ host, mode, onMode, onStart, onStop, ended, busy, images, onClose }: HostPanelProps) {
  const [copied, setCopied] = useState(false);
  return <section className="workspace-card live-share" aria-label="Live share">
    <h2>Live share</h2>
    {!host && <>
      <p>Invite people to annotate this workspace with you in real time. Your images stay in this browser: guests view and edit them through an end-to-end encrypted connection while this tab stays open.</p>
      <ul className="live-facts">
        <li>The invite link contains the session key. Share it only with people you trust, through a private channel.</li>
        <li>You approve each person after comparing a 6-digit code with them.</li>
        <li>Guests can draw and edit annotations and review status. Masks, classes, imports, exports, backups, and deletion stay host-only.</li>
        <li>The session ends when you stop it, lock or exit the workspace, or close this tab.</li>
      </ul>
      <fieldset className="live-mode">
        <legend>Connection</legend>
        <label><input type="radio" name="live-mode" checked={mode === 'relay'} onChange={() => onMode('relay')} />
          Private relay (recommended): encrypted data passes through the easyannotate.online relay, which cannot read it. Participants do not see each other's IP addresses.</label>
        <label><input type="radio" name="live-mode" checked={mode === 'direct'} onChange={() => onMode('direct')} />
          Direct (WebRTC): faster on the same network. Still end-to-end encrypted, but your IP address is shared with guests and a public STUN server. Falls back to the relay if a direct path fails.</label>
      </fieldset>
      {ended && <p role="status">{ended}</p>}
      <div className="live-actions">
        <button type="button" className="continue-button" disabled={busy} onClick={onStart}>Start live session</button>
        <button type="button" className="text-button" onClick={onClose}>Close</button>
      </div>
    </>}
    {host && <>
      <p role="status">Live session active · {host.mode === 'direct' ? 'direct connections when possible' : 'private relay'}</p>
      <label className="live-invite">Invite link
        <span><input readOnly value={host.url} aria-label="Invite link" onFocus={event => event.currentTarget.select()} />
          <button type="button" onClick={() => {
            void navigator.clipboard.writeText(host.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
          }}>{copied ? 'Copied' : 'Copy link'}</button></span>
      </label>
      {host.pending.length > 0 && <div className="live-pending" role="region" aria-label="Join requests">
        <h3>Waiting to join</h3>
        {host.pending.map(request => <div className="live-request" key={request.id}>
          <p><strong>{request.name}</strong> wants to join. Ask them to read their code. Approve only if it matches:</p>
          <p className="live-code" aria-label={`Verification code for ${request.name}`}>{request.code}</p>
          <div className="live-actions">
            <button type="button" className="continue-button" onClick={() => host.approve(request.id)}>Codes match · approve</button>
            <button type="button" className="text-button" onClick={() => host.decline(request.id)}>Decline</button>
          </div>
        </div>)}
      </div>}
      <ParticipantList participants={host.participants} images={images} you={host.participants[0]?.id ?? ''}
        onRemove={id => host.decline(id, 'The host removed you from the live session.')} />
      <div className="live-actions">
        <button type="button" className="remove-button" onClick={onStop}>Stop live session</button>
        <button type="button" className="text-button" onClick={onClose}>Hide panel</button>
      </div>
    </>}
  </section>;
}

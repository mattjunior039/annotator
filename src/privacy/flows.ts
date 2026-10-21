export const privacyViews = [
  { id: 'local', label: 'Local' },
  { id: 'live', label: 'Live peers' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'ai', label: 'AI' },
] as const;

export type PrivacyView = typeof privacyViews[number]['id'];
export type Disclosure = 'no-data-sent' | 'encrypted-content' | 'metadata' | 'plaintext-pixels';
export const disclosureLabels: Record<Disclosure, string> = {
  'no-data-sent': 'No dataset data sent',
  'encrypted-content': 'Encrypted content sent',
  metadata: 'Metadata disclosed',
  'plaintext-pixels': 'Plaintext pixels disclosed with consent',
};

export interface FlowStep {
  boundary: string;
  bytes: string;
  protection: string;
  visible: string;
}

export interface PrivacyFlow {
  id: string;
  view: PrivacyView;
  title: string;
  availability: 'implemented' | 'planned';
  prerequisite: string;
  disclosures: readonly Disclosure[];
  summary: string;
  steps: readonly FlowStep[];
  caveat: string;
}

// Descriptive inventory, not a transport authorization or a live traffic monitor.
export const privacyFlows = [
  {
    id: 'local', view: 'local', title: 'Local storage', availability: 'implemented',
    prerequisite: 'A supported browser, explicit file selection, and an unlocked local workspace.',
    disclosures: ['no-data-sent'],
    summary: 'Source disk → browser memory → encrypted SQLite/OPFS. App scripts and WASM load from the app origin; dataset content stays local.',
    steps: [
      { boundary: 'Source disk → media worker RAM', bytes: 'Selected original files are decoded locally; the source folder is unchanged.', protection: 'Original files are outside vault protection. Fresh sanitized PNGs and previews exist in plaintext memory.', visible: 'Pixels may identify people even after metadata stripping.' },
      { boundary: 'Browser RAM → storage worker → SQLite/OPFS', bytes: 'Sanitized pixels, annotations, schema, masks and thumbnails.', protection: 'The storage worker encrypts before persistence. Protected workspaces wrap the root key with a passphrase; no-password workspaces persist their key locally.', visible: 'Workspace names, opaque IDs, sizes, counts, wrapping parameters and storage activity remain observable.' },
      { boundary: 'SQLite/OPFS → browser RAM/display', bytes: 'Unlocked records and media are decrypted locally for editing and display.', protection: 'Keys and plaintext are available to the unlocked app. Lock/exit clears app-held state; it is not secure memory erasure.', visible: 'The browser, OS, extensions and screenshots can expose plaintext. OPFS is not a backup.' },
      { boundary: 'Browser → explicitly selected local folder', bytes: 'Exports are plaintext; encrypted backups use an independent backup key/passphrase.', protection: 'Vault encryption does not protect plaintext exports or the original source files.', visible: 'A separate folder-sync application may upload local files; this app does not control it.' },
    ],
    caveat: 'Local-first is not an air-gap guarantee. No-password encryption does not protect against access to the browser profile.',
  },
  {
    id: 'live-relay', view: 'live', title: 'Live share — private relay', availability: 'implemented',
    prerequisite: 'Start a live session; approve each guest only after comparing the verification code. Requires a configured signaling relay.',
    disclosures: ['encrypted-content', 'metadata'],
    summary: 'Host browser → signaling relay → approved guest browser. Guests receive plaintext in memory, not a persistent app-managed copy.',
    steps: [
      { boundary: 'Host browser → signaling relay', bytes: 'Starting the session connects to /signal; handshake messages are encrypted using the fragment invite secret.', protection: 'The invite secret stays in browsers, not in HTTP requests. Starting contacts the relay before any guest is approved.', visible: 'Relay sees room ID, host/guest roles, connection IPs, timing and ciphertext sizes.' },
      { boundary: 'Host RAM → relay → approved guest RAM', bytes: 'Requested sanitized images, annotations and collaboration messages.', protection: 'Ephemeral ECDH plus the invite secret derives per-guest AES-GCM keys. Browsers encrypt/decrypt; relay forwards ciphertext.', visible: 'Approved guests can see pixels, names, annotations and presence. The relay still sees traffic metadata.' },
      { boundary: 'Guest edits → host vault', bytes: 'Encrypted guest edit commands; the host validates and persists accepted changes in its encrypted vault.', protection: 'Host remains authoritative. Ending or locking the host ends the live session.', visible: 'Guests can retain screenshots or copied plaintext; removal cannot revoke prior disclosure.' },
    ],
    caveat: 'The host must remain online. The protocol is not independently audited; the relay operator still sees connection IPs.',
  },
  {
    id: 'live-direct', view: 'live', title: 'Live share — direct WebRTC', availability: 'implemented',
    prerequisite: 'Explicitly choose Direct mode and start a live session; verify and approve guests.',
    disclosures: ['encrypted-content', 'metadata'],
    summary: 'Encrypted relay handshake → STUN/direct connection attempt → encrypted WebRTC data channel, or relay fallback.',
    steps: [
      { boundary: 'Browsers → signaling relay', bytes: 'Encrypted handshake and session descriptions, using the same invite and verification process as private relay.', protection: 'Invite and derived session keys remain in peer browsers.', visible: 'Relay sees connection IPs, room ID, timing and ciphertext sizes.' },
      { boundary: 'Browsers → STUN / other peer', bytes: 'ICE connectivity checks and connection candidates in Direct mode.', protection: 'Direct transport is not an IP-privacy mode. STUN is stun.cloudflare.com by default, configurable at build time.', visible: 'Peer IP addresses are disclosed to other peers and the STUN service.' },
      { boundary: 'Host RAM ↔ guest RAM', bytes: 'Application-encrypted image, annotation and edit frames over WebRTC; relay fallback if a direct path fails.', protection: 'Per-guest AES-GCM encryption/decryption occurs in browsers, including on the relay fallback.', visible: 'Guests see decrypted content and can retain copies. There is no TURN server or TURN relay-only mode implemented.' },
    ],
    caveat: 'CSP does not universally govern WebRTC. Direct mode is not proof that a direct path succeeded or that no third party was contacted.',
  },
  {
    id: 's3-sharing', view: 'cloud', title: 'Persistent S3 snapshots and proposals', availability: 'implemented',
    prerequisite: 'Explicit sharing actions, scoped S3 credentials, bucket CORS, and an exact HTTPS storage origin enabled in build configuration/CSP. Default builds enable no external S3 origin.',
    disclosures: ['encrypted-content', 'metadata'],
    summary: 'Owner encrypts snapshot → S3 → recipient local working copy → encrypted annotation proposal → explicit owner review.',
    steps: [
      { boundary: 'Owner storage worker → S3-compatible storage', bytes: 'Explicit publish uploads an encrypted snapshot of sanitized media and annotations, not original source files.', protection: 'Independent snapshot encryption happens before network access. Credentials stay in memory; locally signed URLs grant fixed-object access.', visible: 'S3 sees opaque paths, sizes, timing, IPs, access-key identifier and any session token in signed URLs.' },
      { boundary: 'Private invitation → recipient browser → local vault', bytes: 'The #share fragment contains the decryption secret and signed URL capabilities. The recipient explicitly downloads, authenticates and imports a password-protected local copy.', protection: 'The secret is not sent to S3. The recipient decrypts locally and can edit offline after import.', visible: 'Invitation holders can decrypt the snapshot and retain plaintext. The invitation is a bearer capability, not verified identity.' },
      { boundary: 'Contributor RAM → S3 proposal object', bytes: 'Explicit submission uploads encrypted annotation changes only; no new images, schema changes or mask edits.', protection: 'One create-only proposal per invitation. The owner can be offline during submission.', visible: 'S3 sees traffic/object metadata; contributor names are self-reported. A link holder can consume the proposal slot.' },
      { boundary: 'S3 → owner review → owner vault', bytes: 'The owner explicitly checks, decrypts and reviews; only approval applies validated changes atomically.', protection: 'Local sharing receipts/capabilities are encrypted under the vault root. No automatic polling, background sync or automatic merge into the owner dataset.', visible: 'Signed URLs expire after at most 24 hours; expiry does not delete stored objects or revoke downloaded copies. Configure bucket lifecycle cleanup.' },
    ],
    caveat: 'This is not continuous cloud sync. Snapshots are bounded to 64 MiB and assembled in memory; provider compatibility and independent crypto review are not certified.',
  },
  {
    id: 'cloud-sync', view: 'cloud', title: 'Optional continuous cloud sync', availability: 'planned',
    prerequisite: 'Not yet available. No runtime provider adapter or background cloud-sync operation is enabled by this explorer.',
    disclosures: ['encrypted-content', 'metadata'],
    summary: 'Planned only: encrypted local changes ↔ user-selected provider storage. S3 invitations are a separate implemented workflow.',
    steps: [
      { boundary: 'Planned browser encryption → provider storage', bytes: 'Future encrypted dataset changes and authenticated manifests; no transfer runs today.', protection: 'Client-held keys and authenticated encrypted records are design goals, not a shipped cloud-sync guarantee.', visible: 'A provider would still observe account/object metadata, sizes, timing and IPs.' },
      { boundary: 'Planned provider storage → browser', bytes: 'Future authenticated downloads and local conflict handling.', protection: 'Provider-specific authentication, recovery and conflict policy still require implementation and verification.', visible: 'No automatic cloud synchronization, cloud conflict resolver or additional provider integration is available.' },
    ],
    caveat: 'These steps describe a design, not current traffic. Opening this view does not configure a provider or relax CSP.',
  },
  {
    id: 'file-sharing', view: 'local', title: 'Encrypted file exchange', availability: 'implemented',
    prerequisite: 'Explicit snapshot creation, manual file transfer and a separately communicated secret; no storage account is needed.',
    disclosures: ['encrypted-content', 'metadata'],
    summary: 'Owner downloads encrypted snapshot → manually transfers file and separate secret → friend imports a local copy → returns encrypted proposal for owner review.',
    steps: [
      { boundary: 'Owner storage worker → downloaded share file', bytes: 'Encrypted sanitized images and annotations, with a public invitation ID/version; never the decryption secret.', protection: 'Independent snapshot encryption before download. Source images remain unchanged. Send the secret separately through a trusted channel.', visible: 'File holders and any transfer provider see filenames, sizes, timing and ciphertext.' },
      { boundary: 'Friend file and secret → local working copy', bytes: 'Explicit local authentication/decryption and password-protected re-encryption, with no in-app network request.', protection: 'Anyone holding file plus secret can decrypt permanently. No expiry or remote revocation.', visible: 'Friends see plaintext images/annotations and can retain copies.' },
      { boundary: 'Returned proposal file → owner review → owner vault', bytes: 'Encrypted annotation changes on original images; owner reviews before atomic approval, with conflicts rejected.', protection: 'One accepted proposal per invitation. Neither download nor delivery automatically synchronizes workspaces.', visible: 'Author names are self-reported. Local review receipts must survive for the owner to approve.' },
    ],
    caveat: 'Snapshots are capped at 64 MiB plus a small header and assembled in memory. Manual file exchange is not automatic sync or revocable access.',
  },
  {
    id: 'mcp-bridge', view: 'ai', title: 'Local companion / MCP bridge', availability: 'implemented',
    prerequisite: 'Separately install the companion, configure Copilot or Antigravity, manually enter a single-use token and explicitly approve scopes for the current image.',
    disclosures: ['metadata'],
    summary: 'Approved current-image box metadata → authenticated loopback companion → standard stdio MCP assistant. Localhost is only one hop.',
    steps: [
      { boundary: 'Browser → loopback companion', bytes: 'Visible boxes, opaque IDs, dimensions, counts, coordinates, class IDs and review state; not pixels, thumbnails, filenames, EXIF, arbitrary text, credentials or vault keys.', protection: 'Exact origin/Host checks, scoped bearer, 15-minute authorization and 60-second data lease. Single-use pairing expires after 60 seconds.', visible: 'Coordinates can themselves be sensitive. Local processes are not automatically trusted.' },
      { boundary: 'Companion → MCP client / possible external provider', bytes: 'Only explicitly scoped tool results; existing-box replacements require revision validation and separate browser review.', protection: 'Official SDK standard stdio transport. Applied proposals form one undoable transaction. Never disable browser mixed-content/local-network rules.', visible: 'An external assistant may forward tool results to its cloud backend. A localhost hop is not an end-to-end local-only guarantee.' },
    ],
    caveat: 'SDK/browser pairing is tested; actual editor applications and deployed HTTPS loopback permissions remain uncertified. The static website does not launch the companion or prove dataset file visibility.',
  },
  {
    id: 'local-inference', view: 'ai', title: 'Local inference', availability: 'implemented',
    prerequisite: 'Prepare a local preview, acknowledge the model license and explicitly request inference; model download origins must be enabled in deployment configuration.',
    disclosures: ['no-data-sent'],
    summary: 'Explicit public model download → sanitized crop in browser worker RAM/GPU → local suggestions requiring review.',
    steps: [
      { boundary: 'Model host → browser cache', bytes: 'Pinned 20.9 MB Apache-2.0 RT-DETR weights from Hugging Face, only after explicit consent. The 26.9 MB WASM runtime is self-hosted and fetched on inference.', protection: 'Public model cache is separate from encrypted workspace data and subject to browser eviction. No automatic model download.', visible: 'Model hosts see download IPs, sizes and timing, not dataset pixels.' },
      { boundary: 'Browser worker RAM/GPU → local suggestions', bytes: 'The prepared sanitized PNG crop and candidate boxes remain local.', protection: 'Suggestions require acceptance through undoable validated commands. No silent fallback to a cloud provider.', visible: 'Local models are fallible; accuracy, device support and anonymization are not certified.' },
    ],
    caveat: 'Browser/GPU memory is not a secure enclave. Model downloads require network access; inference may consume significant memory and power.',
  },
  {
    id: 'cloud-vision', view: 'ai', title: 'Explicit cloud vision', availability: 'implemented',
    prerequisite: 'Choose OpenAI, Gemini, OpenRouter or a deployment-enabled custom endpoint; supply a provider API key/model and approve the exact preview for each send.',
    disclosures: ['plaintext-pixels', 'metadata'],
    summary: 'Local crop and manual opaque redaction → exact flattened preview → explicitly approved BYOK external AI request → reviewed suggestions.',
    steps: [
      { boundary: 'Source pixels → local crop/redaction', bytes: 'Select a bounded crop, add manual black rectangles and inspect a locally flattened PNG.', protection: 'Fresh raster pixels contain no original metadata, hidden layers or reversible overlays. Preview changes invalidate consent.', visible: 'Manual redaction can miss sensitive content; inspect the exact destination, crop and prompt.' },
      { boundary: 'Browser → external AI provider', bytes: 'Only the explicitly approved PNG, prompt, model ID and provider API authorization; no filenames or original files.', protection: 'HTTPS transport encryption is not end-to-end secrecy from the provider: it receives plaintext pixels. In-memory keys, per-send consent, no proxy or automatic provider fallback.', visible: 'The provider sees approved pixels, request fields, IPs and timing; billing, retention, training policy and browser CORS apply.' },
    ],
    caveat: 'Redaction is not guaranteed anonymization. Built-in CSP permissions do not send requests. Editor subscriptions are not BYOK keys; real provider accounts/CORS remain uncertified.',
  },
] as const satisfies readonly PrivacyFlow[];

export type PrivacyFlowId = typeof privacyFlows[number]['id'];

export function getPrivacyFlow(id: PrivacyFlowId): PrivacyFlow {
  return privacyFlows.find(flow => flow.id === id)!;
}

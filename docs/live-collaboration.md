# Live share and collaboration

Live share lets a workspace owner (the **host**) invite up to seven guests to annotate the same images in real time, similar to VS Code Live Share. The host's encrypted vault is the only copy of the dataset. Guests see it through an end-to-end encrypted session and never store it.

## User flow

1. The host opens a workspace and clicks **Live share**. They can choose between the following modes:
   - **Private relay**: the default. All traffic passes through the signaling relay as ciphertext. Peers never learn each other's IP addresses.
   - **Direct (WebRTC)**: after the encrypted handshake, peers try a WebRTC data channel. This mode discloses IP addresses to the other peers and to the STUN server (`stun.cloudflare.com` by default; override with `VITE_ICE_SERVERS`). If no direct path appears within 15 s, the session stays on the relay.
2. **Start live session** creates an invite link: `https://easyannotate.online/#live=<roomId>.<roomKey>`. The secret is in the URL fragment, which browsers never send to a server. The app reads it before React mounts, then removes it from the address bar and history.
3. A guest opens the link, enters a display name, and clicks **Ask to join**. Both sides show a 6-digit verification code. The host compares the code out of band and clicks **Codes match · approve**, or **Decline**.
4. The guest gets the full editor with the host's gallery, classes, and images. Edits from everyone sync live. Gallery dots show which image each participant has open.
5. The host can remove a guest or stop the session. Guests can **Leave session**. If the host stops the session, closes the tab, or locks the workspace, every guest sees **Live session ended**.

The following are host-only:

- Pixel masks and erase
- Class and skeleton schema changes
- Image import and removal
- Export, encrypted backup, and restore
- Workspace security settings

Guests can create and edit boxes, polygons, lines, points, skeleton keypoints, image labels, attributes, and review state.

## Protocol

| Layer | Design |
|---|---|
| Invite | 128-bit random room ID plus a 256-bit room key, carried in the URL fragment only. |
| Handshake | Encrypted with AES-256-GCM under `HKDF(roomKey, roomId, "annotator/live/v1/signal")`. The relay cannot read names, keys, or session descriptions. |
| Session keys | Ephemeral ECDH P-256 per guest. HKDF-SHA-256 combines the ECDH secret with the room key and both public keys. It yields separate host→guest and guest→host AES-256-GCM keys, plus the 6-digit verification code. |
| Frames | Each frame is `[channel][64-bit counter][AES-GCM ciphertext]`, with a counter-derived IV. Receivers require strictly sequential counters per channel, so replayed, dropped, reordered, or tampered frames end the session. |
| Chunking | Plaintext is split into chunks of up to 16 KiB. Each message has a 24 MiB ceiling, and each peer may hold at most 4 partial messages. |
| Consistency | The host is authoritative. Guest edits are sent as annotation-level commands (at most 64 per edit). The host replays them on its current document, so concurrent edits to different annotations merge. Schema or mask changes from guests are refused. Guests apply the host's documents in revision order, and their local undo history is rebased onto them. |
| Admission | Host approval with code comparison is required. There are at most 8 participants per room, and each guest may have at most 4 in-flight requests. |

Room membership (who can open the room) is checked by the relay. Content confidentiality depends only on the invite secret plus code verification. A relay that substitutes keys produces mismatched verification codes.

## Signaling relay

The relay is a zero-knowledge WebSocket service. Its source is in [`services/signaling`](../services/signaling).

- [room.ts](../services/signaling/room.ts) contains the routing logic shared by both runtimes. It routes host↔guest messages only and enforces these limits:
  - 8 participants per room
  - 40,000-character frames
  - per-connection message and byte rate limits
  - a 12-hour room lifetime
  - closing the room when the host leaves
- [worker.ts](../services/signaling/worker.ts) is the production deployment: a Cloudflare Worker with one Durable Object per room. It checks `ALLOWED_ORIGINS` and is routed at `easyannotate.online/signal*`.
- [node-server.ts](../services/signaling/node-server.ts) runs the relay locally with `npm run signaling`.

The relay stores nothing, does not log message bodies, and sees only these:

- the room ID
- the role (host or guest)
- connection IPs and timing
- ciphertext sizes

Deployment steps are in [deploy/README.md](../deploy/README.md#live-share-signaling-relay).

## Limits and open items

- The host's tab must stay open. Guests do not keep a copy after the session ends, apart from whatever the browser holds in memory and anything they screenshot or copy.
- Removing a guest cannot revoke what they already saw. For future confidentiality, start a new session, which creates a new invite secret.
- There is no TURN server yet. In direct mode, peers behind symmetric NATs stay on the relay, which still works.
- Testing covers Chromium with up to 3 participants on one machine. Multi-network NAT testing and testing at 8 peers are still open.
- The protocol has unit tests and end-to-end tests but has **not** had an independent cryptographic review. Do not describe it as audited.

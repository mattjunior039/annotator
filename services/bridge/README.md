# Annotator MCP companion (GitHub Copilot and Google Antigravity)

A small local program that lets an AI editor label the images open in the
annotation website. Your editor starts it as a standard **stdio MCP server**; the
website talks to it over `http://127.0.0.1` only. It never reads files from
disk, has no shell/network/browser tools, and keeps everything in memory.

## Quick start

1. Install Node.js 22.12 or newer. Clone this repository and run `npm ci`.
2. Add the server to your editor:
   - **GitHub Copilot (VS Code):** open this repository folder in VS Code. The
     included [`.vscode/mcp.json`](../../.vscode/mcp.json) starts it automatically
     (allow it when VS Code asks). To use it from other folders, open the website's
     **AI editor → First-time setup**, enter this folder and merge the generated
     `servers` entry with **MCP: Open User Configuration**.
   - **Google Antigravity:** open **MCP Servers → Manage MCP Servers → View raw
     config** and merge the generated `mcpServers` entry from the website.
3. In the website, open a workspace, click **AI editor → Connect** and tell your
   editor: “Connect to the annotator with code 123456”.
4. Ask for the work, for example: “List the unannotated images, view them a few at
   a time, and draw a box around every person and car.”

Copilot uses port **47321** and Antigravity **47322**, so both can run at once.
Select the matching editor in the website before connecting. `BRIDGE_ORIGINS`
must list the website's exact origin (the generated configuration does this).
Chrome may ask to allow access to devices on your local network: allow it for the
annotation site. Never disable browser security.

## Tools

| Tool | Purpose |
| --- | --- |
| `bridge_pair` | Confirm the 6-digit code shown after clicking **Connect**. |
| `bridge_status` | Connection state, granted permissions, whether the tab is responding. |
| `bridge_revoke` | Disconnect and drop pending requests. |
| `list_images` | Opaque image IDs, sizes, review state, annotation counts, class names. Paginated, filterable by review state. |
| `get_annotations` | Annotations of up to 25 images: label, kind, box or points in original pixels, image revision. |
| `view_images` | Up to 6 images as JPEG (longest side ≤ 256–2048 px). Asks the user unless auto-share is on. |
| `annotate` | Add/update/remove boxes, polygons and whole-image labels on up to 50 images per call, by class name; unknown classes are created. `units: "normalized"` accepts 0–1 coordinates. Optional `expectedRevision` rejects stale edits. |

## Permissions and privacy

The website grants three independent permissions when connecting:

- **Read** (`metadata`): image IDs, sizes, review state, class names, annotation
  geometry. Never filenames, paths, EXIF/GPS, free-text attributes or mask pixels.
- **View images** (`pixels`): sanitized JPEG copies of the images the editor asks
  for, after you click **Allow** (or automatically if you enable auto-share).
- **Edit** (`propose`): annotation changes, applied after you review them or
  automatically if you enable auto-apply. Every batch can be undone from the
  website's activity list; edits to the open image also join its normal undo.

What you share reaches your editor and normally its cloud AI model; this
companion cannot control what the editor does with it. Edits pass the same
validation as manual edits (geometry inside the image, locked annotations are
protected) and are written to the encrypted local workspace. If a live session is
running, AI edits are shared with participants like the host's own edits.

## Security model

- Listens on `127.0.0.1` only. Every request must carry exactly one `Host:
  127.0.0.1:<port>` and an `Origin` from `BRIDGE_ORIGINS`; CORS allows only that
  origin, `POST`, `Authorization` and `Content-Type`.
- Pairing: the browser requests a code; the user tells the editor; the editor
  confirms it with `bridge_pair`; the browser then receives a random bearer held
  only in memory. Codes expire after 2 minutes and five wrong guesses invalidate
  them. Sessions last at most 8 hours; disconnect, lock or `bridge_revoke` end
  them immediately. Reconnecting replaces the previous browser session.
- Unauthenticated bodies are limited to 256 KiB; authenticated results (approved
  images) to 24 MiB. Editor requests time out after 150 seconds, under
  Antigravity's default 180-second tool limit.
- Browser results are validated against strict schemas before reaching the
  editor, so extra fields such as filenames are rejected rather than forwarded.
- No request contents, tokens or data are logged; startup errors print one
  constant line on stderr.

## Checks

```sh
npm run check:bridge   # companion typecheck
npm run test:bridge    # unit tests + real SDK stdio client
npm run test:integrations  # browser ↔ companion ↔ SDK for both editors
```

The browser suite pairs by code, declines and approves image requests, receives
JPEG image content through MCP, reviews, rejects and auto-applies multi-image
edits, rejects stale revisions, and undoes both per-image and per-batch. The flow
was also exercised manually with VS Code's own MCP client (Copilot agent mode).
Antigravity uses the same stdio protocol and configuration format, but the
Antigravity application itself was not launched in automated tests.

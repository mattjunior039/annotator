# Bounded local annotation companion

Opt-in companion launched separately by an editor. The website's **Local MCP companion**
panel supplies setup, explicit pairing, scoped disclosure and proposal review.
There are **no filesystem, image, media, network-fetch, shell, dense
mask, resource, prompt, cloud AI, or browser-evaluation tools**. Node loads its own
program/dependencies; the service never opens dataset files. It retains approved
data in RAM only.

## Start and connect

Install project dependencies and configure an MCP client to launch:

```json
{
  "command": "node",
  "args": ["--experimental-strip-types", "/absolute/installation/services/bridge/node-server.ts"],
  "env": {
    "BRIDGE_ORIGINS": "http://127.0.0.1:5173",
    "BRIDGE_PORT": "47321"
  }
}
```

Use an installation path for the program, **not** a dataset path. Node must meet
the project's `>=22.12.0` requirement. `npm run bridge` is also available for manual
launch but requires an MCP client on stdin/stdout, not an HTTP MCP client.

The port defaults to 47321 and must be an integer from 1024–65535. No host override
exists: listening is always `127.0.0.1`. An empty origin list fails closed.
`BRIDGE_ORIGINS` is a comma-separated list of exact serialized origins (no trailing
slash, credentials, paths, wildcards, opaque origins or whitespace). HTTPS is
supported as an origin; plain HTTP origins are allowed only for `localhost` and
`127.0.0.1`. Browser requests must address `http://127.0.0.1:47321`, not `localhost`.
One editor subprocess and one approved workspace per process are supported. A
second subprocess on the same port fails rather than attaching to another client.

MCP is **standard stdio using official SDK 1.32.1**, not arbitrary WebSockets or
Streamable HTTP. The HTTP listener serves only the separate browser protocol.
The MCP session itself is not a bearer credential: per-process stdin is inherited
from the launching editor, and disclosure requires a separate browser approval.
Stdout carries only MCP messages. Startup errors use one constant stderr message;
no request/data/token/exception logging exists.

Tested: official SDK 1.32.1 `Client` / `StdioClientTransport`, Node 26.10.0,
MCP initialization, tool discovery/calls, browser pairing, data disclosure,
proposal queue and revocation. VS Code/Copilot, Cursor and Antigravity
interoperability and real-browser mixed-content/local-network permission behavior
are **not yet certified**. Never disable browser security. An HTTPS UI may need
browser local-network permission or a separately reviewed secure loopback transport;
this implementation does not install certificates or introduce a proxy fallback.

## Disclosure model

Tools: `bridge_pair`, `bridge_status`, `bridge_revoke`, `annotation_metadata`,
`annotation_counts`, `propose_annotation_patch`. No dynamic tools.
Scopes: `metadata`, `counts`, `propose`; default authorization is none.

* `metadata`: approved opaque class/image/annotation IDs, image dimensions, boxes
  and review enums. No human-readable labels, arbitrary attributes, filenames,
  paths, image bytes, EXIF/GPS, credentials, encryption keys or masks.
* `counts`: counts over the approved snapshot, grouped by opaque class ID.
* `propose`: queue replacements for **existing bounding-box annotations only**,
  with `baseRevision`; no immediate mutation, new annotations, deletion, or
  image retargeting. Unsupported annotation geometries are intentionally absent.
* All IDs must be UUIDs generated for this disclosure session by the browser.
  Never encode a filename, path, label or key as an ID. The service cannot verify
  the provenance/meaning of otherwise schema-valid numeric values or UUIDs.

Authorization is **not actual file visibility**. Status explicitly reports
`fileVisibility: "not-observed"`. Snapshots are browser assertions about a selected,
approved subset, not disk inventories or proof that a file remains visible.
Loopback protects only this hop: an external editor/assistant may send disclosed
IDs, dimensions, coordinates or counts to its own cloud backend.

## Copilot and Antigravity website setup

1. Install this repository's dependencies in a trusted program folder using `npm ci`.
2. Open an image in the website, choose **Local MCP companion**, select your editor
   and expand **Set up Copilot or Antigravity**.
3. Enter this repository's absolute installation folder (not your dataset folder).
   The panel generates the correct configuration with the current website origin.
4. For GitHub Copilot in VS Code, open **MCP: Open User Configuration** and merge
   the generated `servers` object. The `annotator` entry uses `type: "stdio"`,
   `command`, `args` and `env`.
5. For Antigravity, open **MCP Servers → Manage MCP Servers → View raw config**
   and merge the generated `mcpServers` object with its `annotator` entry.
6. Restart/enable the MCP server in the editor. Ask the assistant to call
   `bridge_pair` with the panel's **MCP pairing parameters**. Manually enter its
   returned token into the website, select scopes, approve disclosure and pair.
7. The editor can inspect approved box metadata/counts and propose changes.
   Review and apply proposals in the website. Use **Revoke and clear** when done.

Copilot uses port **47321** and Antigravity uses **47322** so separate editor
subprocesses do not collide. Select the matching editor before pairing; the
website CSP permits only these two ports. These are standard MCP connections,
not embedded editor logins, subscription API access or website cloud API keys.

Official setup documentation: [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
and [Antigravity MCP](https://antigravity.google/docs/mcp).
Automated Chromium tests exercise both generated configurations using the actual
stdio SDK/companion, including pairing, review, undo and revocation. They do not
launch or certify either editor application, nor the deployed site's HTTPS local-network permissions.

## Browser integration contract

Browser messages use JSON `POST /pair` and `POST /message`. Both require an exact,
configured `Origin` and exact `Host: 127.0.0.1:<port>`. Missing/duplicate/unexpected
Host or Origin is rejected before parsing commands. Browser requests must use
`Content-Type: application/json`, no content encoding, no cookies, no query
parameters or URL credentials. CORS allows only the exact origin, POST,
Authorization and Content-Type (never wildcard credentials). Validated preflights
can opt into private-network access; this does not override browser permission.

1. The editor calls `bridge_pair` with
   `{ origin, workspaceId, scopes: ["counts", "metadata", "propose"] }`.
   It receives `{ token, expiresAt, workspaceId, scopes }`. The user copies the
   token into a trusted browser pairing UI; never place it in URLs, logs, browser
   storage, telemetry or clipboard history automatically. Pairing expires after
   60 seconds and is single-use. Reissuing a token invalidates the previous one.
2. The browser shows the exact editor/process workflow, workspace, requested
   scopes and cloud-backend warning, then requires an explicit approval gesture.
   It sends `/pair`:

   ```json
   {
     "type": "pair", "token": "<single-use-token>",
     "workspaceId": "<opaque-uuid>", "approved": true,
     "scopes": ["counts", "metadata", "propose"]
   }
   ```

   Scopes may be narrowed but not expanded. Approval must match origin/workspace.
   The response is `{ bearer, expiresAt }`; keep the bearer only in browser RAM.
   It is independent of the pairing token and expires absolutely after 15 minutes.
3. Every `/message` requires `Authorization: Bearer <bearer>`. A data message:

   ```json
   {
     "type": "snapshot",
     "snapshot": {
       "revision": 1,
       "classes": ["<opaque-class-uuid>"],
       "images": [{"id": "<opaque-image-uuid>", "width": 100, "height": 80}],
       "annotations": [{
         "id": "<opaque-annotation-uuid>", "imageId": "<opaque-image-uuid>",
         "classId": "<opaque-class-uuid>", "box": [1, 2, 30, 40],
         "review": "unreviewed"
       }]
     }
   }
   ```

   Box is pixel-coordinate `[x, y, width, height]`, finite, positive size and
   contained within its image. Review is `unreviewed | accepted | rejected`.
   References and IDs must be valid/unique. Unknown fields at every object depth
   are rejected, not silently forwarded. Revision is a nonnegative safe integer.
   The browser must serialize only the approved, currently visible subset and
   use a monotonically increasing bridge revision whenever that subset changes.
   Do not derive it only from a dataset revision if disclosure/visibility changes.
4. `{ "type": "status" }` returns authorization/data-availability state,
   pending proposals and a bounded audit of event enums/timestamps only.
   Poll while the approval UI is active and visibly indicate the external
   connection. Refresh an unchanged snapshot at most every 30 seconds; its data
   lease lasts 60 seconds. Same-revision changes and older revisions are rejected.
   New revisions discard old proposals. Expired leases discard snapshots/proposals
   while retaining authorization; explicit lock/revoke discards everything.
5. Editor proposals use:

   ```json
   {
     "baseRevision": 1,
     "operations": [{
       "type": "replace-box",
       "annotation": {
         "id": "<existing-annotation-uuid>", "imageId": "<same-image-uuid>",
         "classId": "<approved-class-uuid>", "box": [2, 2, 30, 40],
         "review": "accepted"
       }
     }]
   }
   ```

   The tool returns only `{ proposalId, baseRevision, state:
   "awaiting-browser-review" }`. Browser status supplies the queued operations.
   Before showing and again before applying a proposal, the browser **must**
   check lock state, actual file visibility, consent scope and current revision.
   Require explicit confirmation, route through existing domain command/schema
   validation, apply all operations transactionally, and register undo/provenance.
   The companion does not implement or claim to verify those browser actions.
6. After successful application, send `{ type: "review", proposalId,
   baseRevision, outcome: "applied", snapshot: <full-post-transaction-snapshot> }`.
   Its revision must increase. Alternatively send `{ type: "review", proposalId,
   baseRevision, outcome: "rejected" }` (no snapshot). Unknown/stale/previously
   reviewed proposals fail. Do not treat this acknowledgment as permission to
   apply an edit; the transaction must already have succeeded.
7. On lock, workspace/disclosure changes, disconnect, or consent withdrawal,
   send `{ "type": "lock" }` or `{ "type": "revoke" }`, clear the local bearer,
   discard proposals and disable approval UI. A missed unload message cannot
   instantly revoke: stop snapshot refreshes, rely on the 60-second lease and
   absolute session expiry, or explicitly revoke from the editor. Re-pair to
   change workspaces/scopes. The editor can always call `bridge_revoke`.

Responses/errors never echo invalid values. HTTP statuses: 400 invalid schema,
403 denied, 404 unsupported endpoint/query, 405 unsupported method, 409 stale
revision/data, 429 rate limit. Client code must fail closed on errors/timeouts,
not retry a mutation acknowledgment as a fresh edit.

Limits: 256 KiB inbound message bytes (stdio and HTTP), 5-second HTTP timeouts,
16 HTTP connections, 120 HTTP requests and 120 MCP tool executions per minute,
5 pairing requests per minute, 1,000 images/classes, 2,000 annotations, 100
operations/proposal and 20 queued proposals. Limits are shared per subprocess,
not keyed by untrusted headers. All normal operations are bounded and synchronous
in RAM; no remote operations or long-running tools exist.

## Checks and specification basis

```sh
npm run check:bridge
npm run test:bridge
```

The separate typecheck includes only this companion and its tests, allowing it to
be validated independently of browser development.

Reviewed official [MCP transport requirements (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices):
newline-delimited UTF-8 JSON-RPC/stdout purity for stdio; exact origin checking,
loopback-only binding and authentication for local listeners; explicit consent,
least privilege, unpredictable credentials, and session IDs not substituting for
authorization. This implementation deliberately avoids HTTP MCP/OAuth rather than
claiming a custom HTTP browser channel is MCP Streamable HTTP.

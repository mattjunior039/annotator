# Privacy-flow explorer

Import `PrivacyFlowExplorer` from `src/privacy` and render it wherever appropriate.
It is a self-contained section, not a modal: an integrating dialog must provide
its own focus management and close control. `initialFlow` optionally chooses an
initial explanation; it does not activate that capability.

The four native-radio views, labeled flow selector, keyboard-operable step
buttons, polite status region and complete table explain local storage, Live
share, encrypted file exchange, S3 snapshots/proposals, MCP and local/cloud AI paths. There is
no animation, automatic advance, diagram-only information or color-only status.
The table scrolls independently on narrow screens.

`flows.ts` is a typed, static explanatory inventory, **not** a runtime policy,
capability detector, network monitor or grant of permission. Implemented means
code exists, not that the current deployment/browser supports it or that a
session is active. Preconditions and build-time CSP restrictions remain
explicit. Continuous cloud sync remains planned; MCP and AI describe implemented
opt-in workflows with deployment and certification limits. Keep this inventory in
step with transport implementations and their privacy documentation when those
change. No runtime transport policy is introduced here.

The module imports only React, its own data and local CSS. It reads no workspace
data, performs no I/O, probes no network endpoints, starts no workers and changes
no CSP, storage or permissions. Documentation links navigate only on user action
and point to the repository because source Markdown is not a deployed app asset.
There is no new analytics, remote asset or model dependency.

See the [privacy contract](../../docs/privacy.md),
[Live share](../../docs/live-collaboration.md),
[persistent sharing](../../docs/persistent-sharing.md) and
[verification instructions](../../docs/verification.md).

Focused verification (from the repository root):

```sh
npm test -- src/privacy/flows.test.ts
npm test -- --config src/privacy/vitest.browser.config.ts
npm run check
```

The browser test uses installed Playwright Chromium and a bounded, in-process Vite
harness (no changes to App or Workspace). It is separate from the default unit
suite so CI can run unit tests before installing browser binaries. It verifies keyboard interaction, step
bounds/reset, all unavailable states, no requests during exploration, same-origin
asset loading under a self-only connection CSP, axe WCAG checks, the table and
narrow-screen overflow. This is UI verification, not packet capture or proof of
transport confidentiality.

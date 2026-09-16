# Browser integration tests

Build the real UI, then run the browser suite:

```sh
corepack pnpm --filter @super-system/web build
corepack pnpm test:e2e
```

The default browser is an installed Google Chrome. For Playwright's bundled Chromium instead:

```sh
corepack pnpm exec playwright install chromium
PLAYWRIGHT_BROWSER_CHANNEL=chromium corepack pnpm test:e2e
```

The harness starts the actual Fastify application on `127.0.0.1:4173`, uses password authentication, and serves `apps/web/dist`. Its durable store is a new temporary directory, removed when the server exits. It refuses to reuse an existing server on that port.

Only `provider.ts` supplies deterministic Letta responses. This module and the `/api/test-fixture/stats` endpoint exist solely in this harness; production code does not import them. The tests never connect to a real Letta server, use `.env` credentials, or mutate a remote agent.

The suite verifies sign-in and sign-out, durable chat and approval events through actual HTTP/SSE routes, reconnecting the browser without sending the prompt twice, memory conflict handling and revision history, schedule creation/deletion with timezones, file filtering, unsupported capabilities, persisted preferences, and phone navigation/layout.

These tests prove application integration. They do not replace compatibility verification against the user's deployed Letta version.

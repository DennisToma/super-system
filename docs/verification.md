# Verification

Implementation and checks were performed on macOS with Node.js 24, on the `codex/agent-control-workspace` branch.

## Control room expansion

The Skills, Config, Gateway, MCP manager, Usage, Agents and Office expansion was verified with:

- All five package typechecks and the web/API/desktop builds passing.
- 123 automated tests passing; the opt-in PostgreSQL integration test was skipped in this run (earlier real PostgreSQL evidence remains below).
- 10 browser workflows passing, including skill CRUD/assignment, MCP credential-preserving edits and discovery, Office task persistence/movement, agent configuration edits, usage CSV and all 13 pages at 390px width. The fixture verifies discovery does not call a tool and planning changes do not execute agents.
- MCP unit tests covering approvals, cancellation, transport failure/timeouts, secret redaction and late completion cleanup; real loopback HTTP discovery/tool execution and real stdio process cleanup tests. SSE uses transport mocks and has no live server verification.
- A bundled API startup and a separate production dependency deployment outside the repository, each answering its health endpoint. This caught and fixed an ESM bundling issue by retaining the MCP SDK as a runtime dependency.
- Read-only checks against the existing SSH-connected runtime: gateway capabilities/version, both agents, configuration projection, Office and persisted runs, plus unknown usage totals for older runs. Restarting the local API preserved both existing run records. No live agent configuration, skills, MCP settings or planning data were changed for these checks.
- Visual checks of the live Office and Gateway at desktop width, plus the Office at phone width. Browser fixture data remains separate from the user's workspace.

The current web JavaScript is about 180 KB compressed; Vite's chunk-size warning and upstream Zod annotation notices are non-blocking. Saved MCP credentials are protected by server-side storage/access, not application-level encryption. Gateway does not start/stop host services, and Office remains an explicit planning board.

## Earlier workspace checks

- Workspace installation and package resolution succeeded using the pinned pnpm version.
- All package TypeScript checks pass.
- API tests exercise authentication, encoded-route bypass protection, Host/Origin checks, idempotent sends, interrupted outcomes, cancellation and approval races, reconciliation, SSE replay, memory conflicts, and durable file-store restart behavior.
- Provider protocol fixtures exercise both adapter generations, pagination, streaming chunk boundaries, safe error mapping, resource operations, timeouts, and local transport shutdown.
- Electron tests exercise application URL validation, navigation policy, and renderer security options.
- Compose configuration, image build, and a local production-mode runtime were verified in Colima using an isolated project and generated test credentials. No public deployment was performed.

Integration evidence:

- `corepack pnpm typecheck`: all five packages pass.
- The Colima/PostgreSQL verification passed all 74 tests then present, including the opt-in live PostgreSQL test. The later live-connection fixes add coverage for blank environment values, local default conversations, scoped history pagination, and default-session identity checks; see the live evidence below for their latest checks.
- `corepack pnpm build`: web, bundled API and desktop builds pass. Vite reports a non-blocking initial bundle size warning (about 167 KB compressed).
- Browser tests use the real Fastify API and an isolated test-only provider. They cover login/logout and session reload, streamed text/tools, approval recovery across reload without duplicate execution, memory conflicts and revision history, routine creation/deletion with timezone, file filtering, capability explanations, theme persistence, and all six screens at 390px width.
- `corepack pnpm test:e2e`: all 6 browser workflows pass in the final suite. The chat reload/approval workflow also passed three consecutive targeted runs after fixing its readiness assertion.
- `corepack pnpm --filter @super-system/desktop package`: an unpacked macOS ARM64 application was created at `apps/desktop/release/mac-arm64/Super System.app`.
- The packaged app was launched through native macOS UI automation. Home and System navigation and light/dark appearance were inspected. After closing its window, the independent API health endpoint still returned success.
- The production dependency closure was copied with `pnpm deploy --prod --legacy`, launched outside the repository, and answered its health endpoint. This verifies package resolution, not the Docker image itself.
- The updated bundled API also starts with the pinned SDK and raw management-client imports. Its production static root and SPA fallback have a regression test.
- The actual Docker image builds and starts on the existing `colima-dark-factory` context. Both Compose services become healthy. HTTP checks against the internal upstream verify static HTML/assets, authentication including encoded routes, secure cookie flags, PostgreSQL persistence, and retained preferences/session validity across an application container restart. These checks do not exercise a public TLS reverse proxy.
- A real PostgreSQL 17 integration test creates a separate random database and removes it afterward. It verifies concurrent serialized writes, rollback, reopen persistence, exclusion of a second owner, and fail-closed reads/writes after forcibly terminating the owning database connection. A replacement store acquires ownership and reads the preserved state.

Independent API and provider reviews found and resolved encoded-route authentication bypass, cancellation/approval races, stale reconciliation, lost database ownership, early SDK cancellation, and management-session approval interference. Management reads now use a separate connection that never resumes a conversation or answers tool approvals.

## Live and environment limits

- **Read-only Hetzner connectivity is verified.** A user-authenticated SSH connection forwards a macOS loopback port to the existing App Server running as the Linux user `letta`. The installed runtime reports Letta Code 0.32.10 with a local backend. The separate `dennis` account is used for VM administration. No public endpoint or runtime upgrade was introduced.
- Two existing agents were discovered. Both agents' default histories load, older history pages have no overlapping message IDs, historical tool calls remain visible, and the existing MemFS entries (four for one agent and three for the other) are readable. The runtime reports no schedules for either agent. The live browser confirms the connected runtime and existing default history.
- Live inspection exposed and fixed two integration gaps: empty `.env` token values rejected by the SDK, and local CLI default histories omitted by the App Server conversation-list API. History now uses read-only protocol commands that retain the server's pagination metadata, without attaching a session or registering approval handlers.
- After these fixes, all package typechecks pass, all 77 regular automated tests pass, and the optional PostgreSQL test is skipped unless its dedicated test URL is supplied. The six browser workflows pass; the web, API, and desktop builds succeed. The live browser additionally verifies switching between both existing agents, loading older history, and displaying the first agent's four memory records. Matching agent names are distinguished by their ID suffixes.
- Live sending, tool approval/cancellation, memory editing, and schedule execution have not been exercised against the user's agents. No live conversation, memory edit, or schedule was created during these read-only checks. The installed 0.32.10 runtime remains unchanged; schedule mutation controls require the adapter's verified 0.32.11 minimum and remain unavailable.
- The SSH tunnel depends on the authenticated SSH connection. The remote App Server currently uses a dynamically assigned loopback port, which may change after its own restart. Local connection details and a reconnect command are stored privately in `.data/connection.md`, outside Git.
- The desktop shell is a local application build. Distribution signing, notarization, automatic updates, and production deployment are separate release steps.

## Provider-specific behavior

| Adapter | Confirmed implementation behavior | Live verification needed |
| --- | --- | --- |
| Legacy REST | Existing agent conversation fallback; core memory; available file/schedule endpoints; streamed message/tool mapping; UTC recurring schedules | Installed endpoint set, authentication, real event variants, remote cancellation and approval continuation |
| App Server | Remote SDK sessions; MemFS memory/files; supported schedules; permission prompts; isolated management commands; local default history and pagination | Sending, cancellation/approval, writes, and scheduling behavior on the actual runtime; read-only 0.32.10 local-backend connectivity is verified |

Legacy pause/run-now controls are unsupported. App Server schedule mutations and pause/run-now require a verified supported runtime version. Machine discovery is explicitly unsupported by both current adapters; App Server device inspection would require attaching to a conversation, so it is not performed by background diagnostics. Provider capability checks are read-only.

After an API restart, App Server conversation history may recover text without proving whether a run completed. The application preserves that uncertainty and offers explicit operator-reviewed release of the local send lock. Pending approvals may require recovery through the Letta runtime. This is separate from losing only the browser connection, which reattaches to the still-running application API.

Memory history covers writes made through this application. External concurrent writes cannot be made atomic without upstream conditional-update support. MemFS files are provider-side files, not arbitrary files on the desktop computer.

## Before using the actual agent

1. Identify the installed service through SSH, establish a local port forward if needed, then configure the exact provider mode, reachable URL, token and agent ID in a private `.env`.
2. Check System and read real conversations, memory and files without editing them.
3. Send one harmless, explicitly chosen message and inspect its streamed and persisted result.
4. Verify a browser reload preserves work, then separately test API restart and reconciliation.
5. Verify the actual installed runtime's approvals and schedules before relying on unattended work.

These steps do not require replacing or upgrading the existing Hetzner Letta installation.

## Repeating the PostgreSQL check

Set `SUPER_SYSTEM_TEST_DATABASE_URL` to an isolated PostgreSQL administrator connection, then run `corepack pnpm exec vitest run apps/api/src/store.postgres.test.ts`. The test needs permission to create/drop its random test database and terminate a session owned by the same database user. It does not use `DATABASE_URL` or the application's state database. Keep the test URL private and use a disposable local PostgreSQL instance.

# Verification

Implementation and checks were performed on macOS with Node.js 24, on the `codex/agent-control-workspace` branch.

## Local checks

- Workspace installation and package resolution succeeded using the pinned pnpm version.
- All package TypeScript checks pass.
- API tests exercise authentication, encoded-route bypass protection, Host/Origin checks, idempotent sends, interrupted outcomes, cancellation and approval races, reconciliation, SSE replay, memory conflicts, and durable file-store restart behavior.
- Provider protocol fixtures exercise both adapter generations, pagination, streaming chunk boundaries, safe error mapping, resource operations, timeouts, and local transport shutdown.
- Electron tests exercise application URL validation, navigation policy, and renderer security options.
- Compose configuration validates with non-production fixture settings. No deployment was performed.

Integration evidence:

- `corepack pnpm typecheck`: all five packages pass.
- `corepack pnpm test`: 73 tests across API, providers and Electron policy pass.
- `corepack pnpm build`: web, bundled API and desktop builds pass. Vite reports a non-blocking initial bundle size warning (about 167 KB compressed).
- Browser tests use the real Fastify API and an isolated test-only provider. They cover login/logout and session reload, streamed text/tools, approval recovery across reload without duplicate execution, memory conflicts and revision history, routine creation/deletion with timezone, file filtering, capability explanations, theme persistence, and all six screens at 390px width.
- `corepack pnpm test:e2e`: all 6 browser workflows pass in the final suite. The chat reload/approval workflow also passed three consecutive targeted runs after fixing its readiness assertion.
- `corepack pnpm --filter @super-system/desktop package`: an unpacked macOS ARM64 application was created at `apps/desktop/release/mac-arm64/Super System.app`.
- The packaged app was launched through native macOS UI automation. Home and System navigation and light/dark appearance were inspected. After closing its window, the independent API health endpoint still returned success.
- The production dependency closure was copied with `pnpm deploy --prod --legacy`, launched outside the repository, and answered its health endpoint. This verifies package resolution, not the Docker image itself.
- The updated bundled API also starts with the pinned SDK and raw management-client imports. Its production static root and SPA fallback have a regression test.

Independent API and provider reviews found and resolved encoded-route authentication bypass, cancellation/approval races, stale reconciliation, lost database ownership, early SDK cancellation, and management-session approval interference. Management reads now use a separate connection that never resumes a conversation or answers tool approvals.

## Live and environment limits

- **Hetzner connectivity has not been verified.** The existing Letta URL, installed runtime version, and local credentials location are still needed. No live agent conversation, memory edit, or schedule has been created.
- **Docker runtime and PostgreSQL integration are not yet verified here.** The local Docker daemon is unavailable. Compose parsing is distinct from successfully building and running the containers. The file-backed runtime is exercised locally; PostgreSQL ownership fencing still needs a live database test.
- The desktop shell is a local application build. Distribution signing, notarization, automatic updates, and production deployment are separate release steps.

## Provider-specific behavior

| Adapter | Confirmed implementation behavior | Live verification needed |
| --- | --- | --- |
| Legacy REST | Existing agent conversation fallback; core memory; available file/schedule endpoints; streamed message/tool mapping; UTC recurring schedules | Installed endpoint set, authentication, real event variants, remote cancellation and approval continuation |
| App Server | Remote SDK sessions; MemFS memory/files; supported schedules; permission prompts; isolated management commands | Remote protocol/runtime version, credentials, agent configuration, timezone and scheduling behavior |

Legacy pause/run-now controls are unsupported. App Server schedule mutations and pause/run-now require a verified supported runtime version. Machine discovery is explicitly unsupported by both current adapters; App Server device inspection would require attaching to a conversation, so it is not performed by background diagnostics. Provider capability checks are read-only.

After an API restart, App Server conversation history may recover text without proving whether a run completed. The application preserves that uncertainty and offers explicit operator-reviewed release of the local send lock. Pending approvals may require recovery through the Letta runtime. This is separate from losing only the browser connection, which reattaches to the still-running application API.

Memory history covers writes made through this application. External concurrent writes cannot be made atomic without upstream conditional-update support. MemFS files are provider-side files, not arbitrary files on the desktop computer.

## Before using the actual agent

1. Configure the exact provider mode, existing URL, token and agent ID in a private `.env`.
2. Check System and read real conversations, memory and files without editing them.
3. Send one harmless, explicitly chosen message and inspect its streamed and persisted result.
4. Verify a browser reload preserves work, then separately test API restart and reconciliation.
5. Verify the actual installed runtime's approvals and schedules before relying on unattended work.

These steps do not require replacing or upgrading the existing Hetzner Letta installation.

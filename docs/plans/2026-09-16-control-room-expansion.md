# Control room expansion

## Goal and scope

Add Skills, Config, Gateway, MCP manager, Usage, Agents, and Office to the existing browser/Electron workspace. Preserve existing agents and SSH connectivity. User requests the completed work pushed and merged into main, including the previously built workspace on this feature branch.

Reference: https://github.com/xaspx/hermes-control-interface (MIT, copyright 2026 David Bayendor). Reimplement the interaction ideas in the existing React design system; retain its license if copying implementation or assets. Office uses agents, a task board, and activity; no fabricated agent statuses or token estimates.

## Decisions

- Workspace skills are user-authored reusable instruction documents with explicit agent assignments. Enabled skills are included in prompts sent through this application. They are distinct from skills installed on the VPS, which the management API cannot enumerate.
- MCP connections are managed by this application's backend, with server-only credentials, explicit enablement/agent assignments, bounded discovery, and session-scoped tools. Transport can be stdio, HTTP, or SSE. Stdio runs where this API runs. Discovery does not execute tools. MCP tool execution requires approval.
- Agent configuration is read/written through the provider's management API with a revision check. Expose only supported fields; do not return raw provider objects or secrets.
- Gateway is diagnostics for the application-to-Letta path and controller capabilities. It must distinguish remote connection health from locally observed runs and unavailable process/channel telemetry. No unsupported start/stop buttons.
- Usage reports application-observed runs, duration, reported cost and tokens where actually provided. Missing usage stays unknown. Date and agent filters, daily aggregation, CSV export; no invented prices or historical billing claims.
- Office is a persistent planning board with task CRUD, assignment, status changes and a live activity/run feed. Moving a planning card does not start or cancel an agent. Explicit conversation links connect planning and agent work.
- Existing run identity, replay, cancellation and approval invariants remain intact. Backward-compatible file/PostgreSQL state hydration supports existing installations.

## Implementation units

1. Shared contracts, validation, and plan. Add typed control-room DTOs and optional provider management methods, run resource/usage contracts. Core schema tests cover invalid MCP configs and planning records.
2. Provider management and MCP execution. Agent config, read-only runtime diagnostics, reported usage, explicit session tools, bounded MCP discovery; unit tests prove no runtime attachment for management reads and approval before MCP execution.
3. Durable API features. Skills, MCP registry, task board, usage aggregation, gateway and config routes; state migration and resource resolution for runs; integration tests cover persistence, auth, conflicts, secret redaction and invalid inputs.
4. Shared UI. Seven pages, grouped scrollable navigation, real loading/error/empty states, capability-aware controls, responsive layout. Agent cards select agents; config saves; skills/MCP CRUD; Office board CRUD/filter; usage filters/export.
5. Verification and delivery. Typecheck, tests, build, browser workflows (desktop/mobile), read-only live smoke, independent code review. Record limits, commit named paths, push, create PR, merge main after checks, verify remote main contains result.

## Verification contract

- Old saved state opens without losing runs, preferences or revisions.
- Secret values never appear in MCP list, diagnostics, activity, errors, or run responses; edits preserve existing credentials unless explicitly replaced/cleared.
- Invalid config/paths/schema inputs fail before execution. MCP connections close after tests and runs; transport failure and timeout are finite.
- Approvals gate external MCP execution; denial never calls the server. Background management reads never take over a conversation.
- Skills apply only to their assigned agent's new application runs. Run retries preserve idempotency.
- Task/config updates protect stale edits. Deleting a planning task has no remote run side effect.
- Usage filters are timezone explicit and exclude unavailable measurements from totals with clear coverage counts.
- Browser tests exercise all seven screens and meaningful mutations with isolated fixtures, plus existing workflows. Live verification reads existing agents only.

## Done

All seven areas work against actual persisted/application/provider data, their boundaries are clearly explained, checks pass, documentation matches the behavior, and the requested changes are pushed and merged into main. External runtime configuration, upgrades, publishing websites, or modifying existing agents during verification are outside this implementation's test scope.

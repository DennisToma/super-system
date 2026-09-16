# Application API

All routes use `/api`. DTOs are defined in `packages/core/src/index.ts`. JSON errors use `{ error: { code, message } }`. No provider credentials are returned.

## Access

- `GET /auth/session` -> `{ authenticated, required }`
- `POST /auth/login` body `{ password }` -> `{ authenticated: true }` and HttpOnly cookie
- `POST /auth/logout` -> `{ ok: true }`

## Workspace

- `GET /connection` -> `Connection`; `POST /connection/check` -> `Connection`
- `GET /agents` -> `Agent[]`
- `GET /overview?agentId=...` -> `Overview`
- `GET /conversations?agentId=...&cursor=...` -> `Page<Conversation>`
- `POST /conversations` body `{ agentId, title? }` -> `Conversation`
- `GET /conversations/:id/messages?agentId=...&cursor=...` -> `Page<Message>`
- `POST /runs` body `{ requestId, agentId, conversationId, message }` -> `Run` (202; repeats return same run)
- `GET /runs?conversationId=...` -> `Run[]`
- `GET /runs/:id` -> `Run`
- `GET /runs/:id/events?after=0` -> SSE, event name `run`, JSON `RunEvent`; reconnect using sequence/Last-Event-ID
- `POST /runs/:id/cancel` -> `Run`
- `POST /runs/:id/approval` body `{ approvalId, approved }` -> `Run`
- `POST /runs/:id/reconcile` -> `Run`
- `POST /runs/:id/release` body `{ acknowledged: true }` -> `Run`; an operator-reviewed interrupted run keeps its uncertain status but gains `releasedAt`, allowing a new explicit message. This never cancels or resends provider work.
- `GET /activity` -> `Activity[]`

## Resources

- `GET /agents/:id/memory?query=...&cursor=...` -> `Page<MemoryItem>`
- `PATCH /agents/:id/memory/:memoryId` body `{ content, expectedVersion }` -> `MemoryItem`; 409 when changed since loading
- `GET /agents/:id/memory/:memoryId/history` -> `MemoryRevision[]` (only application-observed writes)
- `GET /agents/:id/files?cursor=...` -> `Page<AgentFile>`
- `GET /agents/:id/routines` -> `Routine[]`
- `POST /routines` body `CreateRoutineInput` -> `Routine`
- `DELETE /agents/:id/routines/:routineId` -> `{ ok: true }`
- `POST /agents/:id/routines/:routineId/run` -> `{ ok: true }`
- `POST /agents/:id/routines/:routineId/pause` body `{ paused }` -> `{ ok: true }`
- `GET /machines` -> `Machine[]`
- `GET /system` -> `SystemInfo`
- `GET /preferences` -> `Preferences`
- `PUT /preferences` body `Preferences` -> `Preferences`

The UI reads connection capabilities before showing mutating controls. Unsupported provider operations return 501; unavailable connections return 503. Connection checks themselves return the explicit connection state for onboarding.

Run events notify clients of durable changes. `GET /runs/:id` is the authoritative snapshot; clients refetch it on events and reconnection. Reconciliation may replace a partial response using provider history, so concatenating event text alone is not a complete reconstruction algorithm.

## Control room

Contracts and strict input schemas are in `packages/core/src/management.ts`.

- `GET /skills` -> `WorkspaceSkill[]`; `POST /skills` body `SkillInput` -> created skill (201).
- `PATCH /skills/:id` body `SkillInput & { expectedVersion }`; `DELETE /skills/:id` body `{ expectedVersion }`.
- `GET /mcp` -> `McpServer[]`; `POST /mcp` body `McpInput` -> created server (201).
- `PATCH /mcp/:id` body `McpInput & { expectedVersion }`; `DELETE /mcp/:id` body `{ expectedVersion }`.
- `POST /mcp/:id/test` -> `McpTestResult`; bounded discovery without a tool call.
- `GET /agents/:id/config` -> `AgentConfiguration`; `PATCH /agents/:id/config` body `AgentConfigPatch` -> saved configuration.
- `GET /gateway` -> `GatewayInfo`; diagnostics only.
- `GET /office` -> `OfficeSnapshot`; persisted tasks plus existing agents and recent application runs/activity.
- `POST /tasks` body `TaskInput` -> created task (201); `PATCH /tasks/:id` body `TaskInput & { expectedVersion }`; `DELETE /tasks/:id` body `{ expectedVersion }`.
- `GET /usage?days=30&agentId=...` -> `UsageReport`; `days` is 7, 30 or 90, grouped by start date in UTC.

MCP environment variables and headers are write-only. Responses indicate `hasCredentials`. Omitted credentials are preserved on edits; explicit replacement, `clearCredentials`, or a transport change replaces/clears them. Put secrets in these fields, never in command arguments or URLs. Version conflicts return 409. Task mutations never execute an agent. Run creation snapshots assigned, enabled resources; subsequent edits affect only new runs. Usage measurements are optional and unreported totals remain null.

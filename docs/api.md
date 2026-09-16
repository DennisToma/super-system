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

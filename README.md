# Super System

A personal workspace for the Letta agent you already run. Chat, review memory, manage supported routines, and inspect files and activity from the same interface in your browser or desktop app.

Super System connects to an existing Letta service, including a remote Hetzner VPS. It does not create a replacement agent or migrate your Letta installation.

## Start locally

Requires Node.js 24 and the pinned pnpm version.

```sh
corepack enable
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm dev
```

Open [the local workspace](http://127.0.0.1:5173). The application works in a clear disconnected setup state until you configure the existing server in `.env`:

```dotenv
LETTA_MODE=legacy
LETTA_BASE_URL=https://your-existing-letta-server.example.com
LETTA_API_KEY=your-existing-key
LETTA_AGENT_ID=your-existing-agent-id
```

Use `legacy` for Letta's REST server or `app-server` for the current remote App Server protocol. App Server authentication uses `LETTA_SERVER_TOKEN`. Credentials stay in the API process. Restart the API after changing configuration and check **System** before sending or editing anything.

For desktop access, keep the API and web server running and open a second terminal:

```sh
corepack pnpm dev:desktop
```

For an independently hosted application, set `SUPER_SYSTEM_URL` to its HTTPS address. The desktop shell does not start or stop the server; closing its window leaves remote work running. See [deployment instructions](docs/deployment.md) for Docker, PostgreSQL, HTTPS, authentication, and desktop packaging.

## Workspace

| Area | What it does |
| --- | --- |
| Home | Connection state, selected agent, recent work and application activity |
| Chat | Provider conversations, history, streamed replies and tools, approvals, cancellation and recovery |
| Memory | Search supported memory, edit with version checks, compare application-observed revisions |
| Routines | Provider schedules with creation, deletion, and supported pause/run controls |
| Files | Provider-visible files and reported context state |
| System | Connection diagnostics, capability support, runtime machines, theme and timezone |

Support depends on the installed Letta generation and version. Unsupported operations have explicit explanations. Production views never use demo data. Test fixtures live only under test code.

## Reliability and boundaries

The API owns active connections and persists application runs before executing them. Request IDs prevent duplicate application submissions. Event streams reconnect to persisted events and refresh the authoritative run snapshot. An uncertain send is never automatically retried.

After an API restart, unresolved work is marked interrupted until Letta confirms an outcome. Some App Server versions cannot report a definitive result after losing the original session. Inspect the provider conversation before explicitly releasing that local send lock. Releasing it does not cancel remote work or label it successful.

Letta owns agent messages, memory, files and schedules. This application stores its own run events, preferences and observed edit history. Memory checks detect changes since an editor loaded, but cannot provide an atomic cross-client write guarantee where the provider has no conditional-update API. Files listed by a remote agent do not grant it access to your Mac's filesystem.

Use a single API process. Local development uses a durable file store in `.data`; hosted deployments use PostgreSQL with an ownership lock. Hosted mode requires authentication, HTTPS, and secure cookies. The application fails closed if database ownership is lost.

## Development

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

The browser suite uses an isolated test provider and real application API. See [verification notes](docs/verification.md) for checks actually completed and the remaining live-server verification.

| Package | Responsibility |
| --- | --- |
| `apps/web` | React/Vite interface shared by browser and Electron |
| `apps/api` | Fastify authentication, persistence, run coordination and static assets |
| `apps/desktop` | Sandboxed Electron shell |
| `packages/core` | Transport-safe types and input schemas |
| `packages/provider-letta` | Legacy REST and remote App Server adapters |

[Written plan](docs/plans/2026-09-16-agent-control-workspace.md) · [Architecture](docs/architecture.md) · [API contract](docs/api.md) · [Deployment](docs/deployment.md)

The interface is an original implementation. Hermes Control Interface and Letta OSS UI informed the product discussion; no source from the unlicensed Letta OSS UI repository was copied.

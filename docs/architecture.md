# Architecture

See [the implementation plan](plans/2026-09-16-agent-control-workspace.md) for product decisions and verification criteria.

The browser and Electron display the same React application. The Fastify backend owns provider credentials, active agent connections, persistent application run records, and replayable events. Letta remains the authority for agent conversations, memory, attached files, and provider schedules.

## Package boundaries

- `apps/web`: browser-safe React interface. Uses application DTOs and HTTP/SSE only.
- `apps/api`: authentication, commands, persistence, run lifecycle, and static production assets.
- `apps/desktop`: Electron lifecycle around the configured web URL; never owns remote work.
- `packages/core`: JSON-safe data contracts, validation schemas, and provider interface.
- `packages/provider-letta`: explicit version-specific adapters. Upstream SDK types stay here.

## Data and capability rules

A missing connection is an onboarding state, never fabricated agent activity. Capabilities distinguish supported, unsupported, and unavailable operations. An unsupported action is disabled with a reason. A failed provider request never becomes a successful local mutation.

Application history records what this application observed. It does not claim a complete history of edits made elsewhere. A memory save compares against the version the editor loaded before sending changes; provider-side atomic concurrency support determines the strength of the guarantee.

The file store is for single-process local development. PostgreSQL provides transactional state for hosted use. Provider message history is read on demand, while application run events support reconnect replay.

## Desktop and remote machines

Desktop windows connect to the same service as browsers. Closing a window leaves server-owned sessions running. Choosing a local file does not grant a VPS access to local directories. A future local connector must declare and enforce its own filesystem permissions.

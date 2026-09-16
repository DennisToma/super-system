# Running Super System

Super System is a separate interface for the Letta service already running on Hetzner. Installing it does not install, upgrade, migrate, or replace Letta. The browser and desktop app connect to the Super System API; only that API receives Letta credentials.

## Local development

Use Node.js 24 and the pnpm version pinned in `package.json`:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm dev
```

Open `http://127.0.0.1:5173`. An empty Letta URL produces an explicit setup state. Set `LETTA_MODE`, `LETTA_BASE_URL`, `LETTA_API_KEY` or `LETTA_SERVER_TOKEN`, and the existing `LETTA_AGENT_ID` in `.env`, then restart the API. Select the adapter matching the installed server: `legacy` for REST or `app-server` for the current App Server. A reachable URL alone does not establish runtime compatibility.

The default host is loopback. Browser requests must use the configured `APP_ORIGIN`. Local application state lives in `.data`, or the directory specified by `APP_DATA_DIR`; it must remain on a persistent writable disk. The file store supports one API process. PostgreSQL is used for hosted deployments, but active provider connections still belong to one API process: run one application replica.

## Connecting to Letta through SSH

Letta does not need a public URL. If you currently access the Hetzner VPS through SSH, forward its existing Letta listening port to your Mac, then point the local Super System API at that forwarded address.

First identify the actual service and port on the VPS. `ss -ltn` lists listening TCP ports; if Letta runs in Docker there, `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` shows container images and published ports. SSH access itself does not establish whether the installed service is the legacy REST API or App Server.

For example, **only if the existing service listens on VPS port 8283**, run:

```sh
ssh -NT -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18283:127.0.0.1:8283 user@your-vps
```

Replace the SSH target and remote port with the actual values. Keep this terminal running, and set `LETTA_BASE_URL=http://127.0.0.1:18283` in the local `.env` if the service speaks HTTP. Retain its existing API key or server token and select the correct adapter. Restart the API and use **System → Check connection**. The local address is reachable only while the tunnel is running; the tunnel does not start Letta or bypass its authentication.

This setup assumes the Super System API runs directly on your Mac, as with `corepack pnpm dev`. A container's `127.0.0.1` refers to that container, so the same URL will not reach a tunnel bound to macOS loopback. Prefer the native local API for this SSH setup; running the API on the VPS beside Letta is another deployment option.

## Docker on macOS with Colima

Check the running profile and Docker context before using Compose:

```sh
colima list
docker context ls
```

If the selected context points to a stopped profile, either start that profile or explicitly select a running one for each command. For example, with the existing `dark-factory` profile:

```sh
docker --context colima-dark-factory compose build
docker --context colima-dark-factory compose up -d
```

These commands still use the hosted Compose configuration below, including its HTTPS origin and authentication requirements. Colima provides the local Docker runtime; it does not establish the connection to the Hetzner VPS.

## Desktop

Start the local API and frontend first, then run this in another terminal:

```sh
corepack pnpm dev:desktop
```

The first launch downloads the Electron runtime if it is not cached; an internet connection is required for that initial setup.

The shell reads the repository `.env` in development. It defaults to `http://127.0.0.1:5173`. To use the hosted application:

```sh
SUPER_SYSTEM_URL=https://workspace.example.com corepack pnpm dev:desktop
```

`SUPER_SYSTEM_URL` is the **Super System application URL**, not the Letta provider endpoint. HTTPS is required except for exact loopback hosts (`127.0.0.1`, `localhost`, or `::1`). Keep credentials out of the URL and log in through the application.

Create an unpacked desktop application for your current platform:

```sh
corepack pnpm --filter @super-system/desktop package
```

The output is under `apps/desktop/release`. The packaged application accepts `SUPER_SYSTEM_URL` or a `--server-url=https://workspace.example.com` launch argument. For example, on macOS:

```sh
open "apps/desktop/release/mac-arm64/Super System.app" --args --server-url=https://workspace.example.com
```

The output folder varies with platform and CPU architecture; use the folder printed by the packager. The desktop application must be fully quit before changing its launch configuration. The configured address is a launch setting, not a credential or a browser preference.

This creates a local unpacked build. Signed/notarized installers and automatic updates require distribution credentials and are not configured. The Electron shell uses a sandboxed renderer with no Node integration, preload bridge, or filesystem API. External HTTP(S) links open in the default browser. Camera, microphone, notifications, arbitrary downloads, and other browser permissions are denied. Closing a desktop window does not cancel agent work; explicit cancellation goes through the API. On macOS, use Quit to exit the application after closing its window.

## Hosted application with Docker Compose

Run the application beside the existing Letta service, with a separate database. The supplied Compose file publishes the application only on the host's loopback interface and does not publish PostgreSQL. Put an HTTPS reverse proxy in front of it.

Create a private `.env` on the server (never commit it), containing your connection details and these application settings:

```dotenv
APP_ORIGIN=https://workspace.example.com
APP_PASSWORD=replace-with-a-long-unique-password
SESSION_SECRET=replace-with-at-least-32-random-characters
POSTGRES_PASSWORD=replace-with-a-long-alphanumeric-password
LETTA_MODE=legacy
LETTA_BASE_URL=https://your-existing-letta.example.com
LETTA_API_KEY=your-existing-provider-key
LETTA_AGENT_ID=your-existing-agent-id
```

Generate independent secrets with a password manager or `openssl rand -hex 32`. Use a hex/alphanumeric PostgreSQL password because Compose interpolates it into a database URL. `LETTA_SERVER_TOKEN` is available for the App Server adapter. These secrets are only supplied to the API container; they are never compiled into the web bundle or desktop application.

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 app
```

Compose sets `HOST=0.0.0.0`, `PORT=3001`, `NODE_ENV=production`, `COOKIE_SECURE=true`, `STATIC_DIR`, and `APP_DATA_DIR`. `APP_ORIGIN`, `APP_PASSWORD`, `SESSION_SECRET`, and `POSTGRES_PASSWORD` must be supplied. Authentication and origin protections must remain enabled even if a private network or reverse proxy is also used. Changing `SESSION_SECRET` invalidates existing application login sessions.

For a reverse proxy running on the host, this Caddy configuration is sufficient once DNS points to the server:

```caddyfile
workspace.example.com {
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }
}
```

Preserve the original Host header, proxy `/api` and the frontend to the same origin, allow long-lived streaming responses, and disable response buffering for event streams. Use `APP_PORT` to change the host's loopback port if 3001 is already occupied. A containerized reverse proxy needs a shared Docker network and the `app:3001` upstream instead of the host's loopback address. Only publish HTTPS publicly.

Inside the application container, `localhost` refers to that container, not the host or the existing Letta container. Use an existing reachable HTTPS endpoint, or deliberately join the correct private Docker network and use its Letta service name. The application does not attach to your existing Letta networks automatically. Keep provider endpoints private where practical and do not expose a tokenless Letta service publicly.

The health check tests the application HTTP/auth endpoint. It does not prove Letta connectivity. Check **System** in the application for the configured provider status and capabilities before sending messages or editing data.

## Persistence and operations

The PostgreSQL volume contains application run records, event history, preferences, and observed memory revision history. Letta retains its own agent data in its existing storage. Back up both systems independently. Application history only covers operations observed through Super System.

To export application state while PostgreSQL is running:

```sh
docker compose exec -T postgres pg_dump -U super_system super_system > super-system.sql
```

Treat that export as private: conversation prompts and memory history may be present. Test restores against a separate database before depending on a backup. `docker compose down` retains named volumes; `docker compose down -v` deletes them.

Restarting or upgrading the application interrupts its live provider connections. Persisted unresolved runs are shown as interrupted and must be reconciled with Letta; they are never blindly resent. A completed remote action can outlive its local stream, so inspect history before manually sending the same request again.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Desktop says workspace unavailable | Start the API/frontend or verify the hosted application URL. The shell does not start either server. |
| Desktop refuses a URL | Use HTTPS for remote addresses. Embedded credentials and non-web protocols are rejected. |
| Login succeeds but the session disappears | Use HTTPS and the exact configured `APP_ORIGIN`; secure cookies are not sent over HTTP. |
| Host/origin request rejected | Preserve the public Host header at the reverse proxy and match `APP_ORIGIN` exactly, including its port. |
| Chat stops streaming through a proxy | Disable buffering and raise proxy idle timeouts; reconnect replays application events. |
| Letta is unavailable in Docker | Check container networking, the selected adapter, server authentication, and provider URL. |
| A feature is unavailable | Inspect System capabilities. Availability depends on the installed Letta runtime and its supported endpoints. |
| File-store permission error | Ensure `APP_DATA_DIR` is writable by the API process. The Docker application runs as the unprivileged `node` user. |
| A run is interrupted after restart | Reconcile and inspect provider history. Do not automatically resend uncertain work. |

See [verification notes](verification.md) for what has actually been tested against fixtures, the local application, and the real Hetzner service.

# Remote Access Setup

Use this when you want to open T3 Code from another device (phone, tablet, another laptop) or run the server on a remote cloud machine.

## Quick Start (remote mode)

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --mode remote --port 3773 --auth-token "$TOKEN"
```

`--mode remote` sets sensible defaults for remote access:

- Binds to `0.0.0.0` (all interfaces) instead of localhost.
- Disables browser auto-open.
- Disables "Open in editor" (the server can't launch editors on the client machine).
- Hides editor buttons in the client UI.

All other features (conversation, diffs, terminal, git actions, checkpoints) work unchanged over the network.

## CLI ↔ Env option map

The T3 Code CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                        | Env var               | Notes                                                                                |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `--mode <web\|desktop\|remote>` | `T3CODE_MODE`         | Runtime mode. `remote` binds 0.0.0.0, disables browser + editor.                     |
| `--port <number>`               | `T3CODE_PORT`         | HTTP/WebSocket port.                                                                 |
| `--host <address>`              | `T3CODE_HOST`         | Bind interface/address.                                                              |
| `--base-dir <path>`             | `T3CODE_HOME`         | Base directory.                                                                      |
| `--dev-url <url>`               | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target.                                                   |
| `--no-browser`                  | `T3CODE_NO_BROWSER`   | Disable auto-open browser.                                                           |
| `--auth-token <token>`          | `T3CODE_AUTH_TOKEN`   | WebSocket auth token. Use this for standard CLI and remote-server flows.             |
| `--bootstrap-fd <fd>`           | `T3CODE_BOOTSTRAP_FD` | Read a one-shot bootstrap envelope from an inherited file descriptor during startup. |

### Linear webhook env vars

These env vars are only needed when you want Linear to create or steer agent sessions remotely:

| Env var                           | Notes                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| `T3CODE_LINEAR_API_TOKEN`         | Linear API token used for issue lookups and posting agent activities. |
| `T3CODE_LINEAR_WEBHOOK_SECRET`    | Shared secret for direct Linear webhook signature verification.       |
| `T3CODE_LINEAR_VERIFICATION_MODE` | `direct` (default) or `proxy` for bearer-token verified proxy setups. |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
  - When you control the process launcher, prefer sending the auth token in a JSON envelope via `--bootstrap-fd <fd>`.
    With `--bootstrap-fd <fd>`, the launcher starts the server first, then sends a one-shot JSON envelope over the inherited file descriptor. This allows the auth token to be delivered without putting it in process environment or command line arguments.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## 1) LAN access (phone, tablet, second laptop)

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --mode remote --port 3773 --auth-token "$TOKEN"
```

Then open on your phone:

`http://<your-machine-ip>:3773/?token=<your-token>`

Example:

`http://192.168.1.42:3773/?token=abc123...`

Notes:

- `--mode remote` implies `--host 0.0.0.0 --no-browser` and disables editor features.
- Ensure your OS firewall allows inbound TCP on the selected port.
- Plain HTTP is acceptable on a trusted LAN. For internet-facing deployments, see section 3.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.

## 3) Cloud machine with TLS (reverse proxy)

When exposing the server over the public internet, **TLS is required**. The server speaks plain HTTP/WS, so place a TLS-terminating reverse proxy in front. The client auto-detects `wss://` from the page protocol — no extra configuration needed.

### Caddy (auto-TLS with Let's Encrypt)

```
# /etc/caddy/Caddyfile
t3.yourdomain.com {
    reverse_proxy localhost:3773
}
```

```bash
# On the cloud machine:
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --mode remote --port 3773 --auth-token "$TOKEN"

# Caddy auto-provisions a Let's Encrypt certificate.
sudo caddy start
```

Open in browser: `https://t3.yourdomain.com/?token=<your-token>`

### nginx

```nginx
server {
    listen 443 ssl;
    server_name t3.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/t3.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/t3.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3773;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> The `Upgrade` and `Connection` headers are required for WebSocket proxying.

### Cloudflare Tunnel (no open ports)

```bash
# Install cloudflared and authenticate
cloudflared tunnel login
cloudflared tunnel create t3code

# Route traffic
cloudflared tunnel route dns t3code t3.yourdomain.com

# Run tunnel (points to local server)
cloudflared tunnel --url http://localhost:3773 run t3code
```

This exposes the server with Cloudflare-managed TLS without opening any inbound ports on the machine.

## 4) What works and what doesn't in remote mode

| Feature                        | Remote status | Notes                                      |
| ------------------------------ | ------------- | ------------------------------------------ |
| Conversation / turns           | Works         | WebSocket RPC, location-agnostic           |
| Git diffs per turn             | Works         | Computed server-side, rendered client-side |
| Terminal                       | Works         | PTY streamed as WebSocket events           |
| Git actions (commit, push, PR) | Works         | Executed on server filesystem              |
| Worktrees                      | Works         | Created on server, thread tracks path      |
| File search                    | Works         | Server scans its own filesystem            |
| Attachments (images)           | Works         | Uploaded as base64 data URLs               |
| Open in editor                 | Disabled      | Would launch editor on server, not client  |
| Folder picker (desktop)        | N/A           | Only available in Electron, not browser    |
| Browser auto-open              | Disabled      | Server can't open browser on client        |

## 5) Folder selection in browser mode

The Electron folder picker is not available in a browser. Instead, type the project path directly in the sidebar's "Add project" input field. The path must exist on the **server** machine (that's where the code lives).

## 6) API keys and agent credentials

AI provider credentials (Codex API key, Claude API key, etc.) must be available on the **server** machine. Set them in the server's shell environment before starting:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
bun run --cwd apps/server start -- --mode remote --port 3773 --auth-token "$TOKEN"
```

## 7) Linear webhook setup

Use this if you want Linear agent-session events to create or continue work in T3 Code.

### Server-side setup

Set the Linear credentials before starting the remote server:

```bash
export T3CODE_LINEAR_API_TOKEN="lin_api_..."
export T3CODE_LINEAR_WEBHOOK_SECRET="whsec_..."
export T3CODE_LINEAR_VERIFICATION_MODE="direct"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --mode remote --port 3773 --auth-token "$TOKEN"
```

The server enables the Linear integration automatically when any of the Linear env vars are present.

### Settings file setup

Add Linear project mappings to the server settings file so incoming issues know which workspace root and base branch to use:

```json
{
  "linearProjectMappings": {
    "defaultWorkspaceRoot": "/srv/projects/default-repo",
    "mappings": [
      {
        "teamKey": "ENG",
        "labelName": "t3-code",
        "workspaceRoot": "/srv/projects/ai.code",
        "baseBranch": "main"
      }
    ]
  }
}
```

Notes:

- `workspaceRoot` must exist on the server machine.
- `baseBranch` is optional, but setting it keeps worktree creation predictable.
- The first matching `teamKey` + `labelName` mapping wins. If none match, the server falls back to `defaultWorkspaceRoot`.

### Linear app / webhook setup

Configure your Linear webhook target as:

`https://<your-domain>/webhook/linear`

For direct verification mode, use the same signing secret in Linear and `T3CODE_LINEAR_WEBHOOK_SECRET`.

Expected flow:

- A Linear agent-session `created` event creates or reuses a T3 Code thread for the issue.
- A `prompted` event sends the next user message into that thread.
- A stop signal interrupts and stops the running thread session.
- The T3 Code server posts agent activity updates back to Linear while the thread runs.

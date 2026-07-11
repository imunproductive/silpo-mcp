# Deploying silpo-mcp (Coolify / Docker)

The remote HTTP server (`dist/http.js`) that backs the Claude connector runs as
a Docker container. The repo ships a `Dockerfile`; any Docker host works —
these instructions assume **Coolify**, whose proxy terminates HTTPS.

## Setup in Coolify

1. Create a new **Application** from this git repository. Build pack:
   **Dockerfile**.
2. **Port**: set exposed port to `3000`.
3. **Domain**: assign your public HTTPS domain. Prefer a real domain (proxied
   through Cloudflare if you want to keep the origin IP private — note that
   `sslip.io`-style domains encode the server IP, and issued certificates are
   recorded in public Certificate Transparency logs).
4. **Persistent storage**: add a volume mounted at **`/data`** — this holds
   `state.json` (OAuth clients + tokens) and `session.json` (Silpo address,
   basket, cabinet token, cart). Without it every redeploy logs everyone out.
5. **Environment variables** (see `.env.example`):
   - `SILPO_MCP_BASE_URL` — the public HTTPS URL from step 3 (required)
   - `SILPO_MCP_PASSWORD` — login password (required)
   - `SILPO_MCP_TOKEN_TTL` — optional
   - `SILPO_MCP_STATE_FILE` / `SILPO_MCP_SESSION_FILE` — already default to
     `/data/*.json` in the image; no need to set.

## Deploying changes

Push to the connected branch and hit **Deploy** in Coolify (or enable
auto-deploy via webhook). The image is built from the `Dockerfile`
(multi-stage: `npm ci` → `tsc` → prod-deps-only runtime).

## Restoring / migrating state

To move an existing deployment, copy `state.json` and `session.json` into the
container's `/data` volume and restart:

```bash
docker cp state.json <container>:/data/
docker cp session.json <container>:/data/
docker exec -u root <container> chown node:node /data/state.json /data/session.json
docker restart <container>
```

## Notes / gotchas

- The unauthenticated `GET /` route returns 200 and is used as the Docker
  `HEALTHCHECK`; Coolify can use the same URL for its health check.
- **Slow shutdown**: the process can take a while to exit on SIGTERM; the
  container's stop grace period may kill it — harmless, state is already
  persisted to `/data` on every change.
- If you change the public domain, update `SILPO_MCP_BASE_URL` to match — it is
  the OAuth issuer, and Claude validates it.

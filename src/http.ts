#!/usr/bin/env node
/**
 * Remote (HTTP) entry point for the Silpo MCP server.
 *
 * Serves the MCP Streamable-HTTP transport at POST/GET/DELETE /mcp, protected by
 * OAuth 2.1 (see oauth.ts). This is what Claude's remote "custom connector" talks
 * to. Run behind an HTTPS reverse proxy (Caddy/nginx) — Claude requires https.
 *
 * Required env: SILPO_MCP_BASE_URL, SILPO_MCP_PASSWORD.
 * Optional env: SILPO_MCP_PORT, SILPO_MCP_TOKEN_TTL,
 *               SILPO_OAUTH_CLIENT_ID / SILPO_OAUTH_CLIENT_SECRET / SILPO_OAUTH_REDIRECT_URIS.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { buildServer } from "./index.js";
import { loadConfig, SilpoOAuthProvider } from "./oauth.js";
import { enableSessionAutosave } from "./session.js";

const config = loadConfig();
const provider = new SilpoOAuthProvider(config);

// Persist the Silpo session (address, basketId, cabinet token, carts) alongside
// the OAuth state so it survives restarts/deploys/reboots.
const sessionFile =
  process.env.SILPO_MCP_SESSION_FILE ?? join(dirname(config.stateFile), "session.json");
enableSessionAutosave(sessionFile);
const baseUrl = new URL(config.baseUrl);
const mcpUrl = new URL("/mcp", baseUrl);

const app = express();

// Behind Caddy (or any reverse proxy): trust the first proxy hop so client IPs
// (X-Forwarded-For) are read correctly by the rate limiter.
app.set("trust proxy", 1);

// Standard MCP OAuth endpoints + discovery metadata (/authorize, /token,
// /register, /revoke, /.well-known/*). Must be mounted at the root.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: ["silpo"],
    resourceName: "Silpo MCP",
  }),
);

// Our custom login form target (posts the password + OAuth params).
app.post("/login", express.urlencoded({ extended: false }), provider.handleLogin);

app.get("/", (_req, res) => {
  res.type("text").send("Silpo MCP server. MCP endpoint: /mcp (OAuth-protected).");
});

// --- protected MCP endpoint --------------------------------------------------

const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});

// One transport per MCP session; a fresh server instance is wired per session.
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", bearer, express.json(), async (req, res) => {
  try {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports[sid] : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session" },
          id: null,
        });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      const server = buildServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling /mcp POST:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET (SSE stream) and DELETE (session teardown) for an established session.
async function handleSessionRequest(req: express.Request, res: express.Response) {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const transport = sid ? transports[sid] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", bearer, handleSessionRequest);
app.delete("/mcp", bearer, handleSessionRequest);

app.listen(config.port, () => {
  console.error(
    `Silpo MCP (remote) listening on :${config.port}\n` +
      `  Public base URL : ${config.baseUrl}\n` +
      `  MCP endpoint    : ${mcpUrl.toString()} (OAuth 2.1 protected)\n` +
      `  DCR enabled     : yes  |  Static client: ${config.staticClient ? "yes" : "no"}`,
  );
});

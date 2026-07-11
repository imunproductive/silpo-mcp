/**
 * Self-contained OAuth 2.1 authorization server for the remote (HTTP) Silpo MCP
 * server. Implements the SDK's `OAuthServerProvider` so `mcpAuthRouter` can wire
 * up the standard /authorize, /token, /register and /revoke endpoints plus the
 * discovery metadata that Claude's remote connector needs.
 *
 * Access is gated by a single shared password (env SILPO_MCP_PASSWORD): the
 * browser-based authorization step shows a login page, and only a correct
 * password yields an authorization code. This is what stops random people who
 * find your server URL from using it.
 *
 * All state is in-memory (fine for single-user self-hosting); tokens and codes
 * are lost on restart, which just means re-authorizing.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Request, Response } from "express";

import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface HttpConfig {
  /** Public base URL of this server, e.g. https://silpo.example.com (no trailing slash). */
  baseUrl: string;
  /** Shared login password gating authorization. */
  password: string;
  /** Port to listen on. */
  port: number;
  /** Access-token lifetime in seconds. */
  tokenTtl: number;
  /** File where issued clients/tokens are persisted (survives restarts). */
  stateFile: string;
  /** Optional pre-registered static client (for Claude's Client ID/Secret fields). */
  staticClient?: { clientId: string; clientSecret: string; redirectUris?: string[] };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const baseUrl = (env.SILPO_MCP_BASE_URL ?? "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "SILPO_MCP_BASE_URL is required (public https URL of this server, e.g. https://silpo.example.com).",
    );
  }
  const password = env.SILPO_MCP_PASSWORD ?? "";
  if (!password) {
    throw new Error("SILPO_MCP_PASSWORD is required (login password that gates access).");
  }
  const staticClient =
    env.SILPO_OAUTH_CLIENT_ID && env.SILPO_OAUTH_CLIENT_SECRET
      ? {
          clientId: env.SILPO_OAUTH_CLIENT_ID,
          clientSecret: env.SILPO_OAUTH_CLIENT_SECRET,
          redirectUris: env.SILPO_OAUTH_REDIRECT_URIS?.split(",").map((s) => s.trim()),
        }
      : undefined;
  return {
    baseUrl,
    password,
    port: Number(env.SILPO_MCP_PORT ?? env.PORT ?? 3000),
    // Default: 30 days. Tokens are password-gated and persisted, so a long
    // lifetime avoids frequent re-authorization for a personal server.
    tokenTtl: Number(env.SILPO_MCP_TOKEN_TTL ?? 2592000),
    stateFile: env.SILPO_MCP_STATE_FILE ?? join(process.cwd(), ".oauth-state.json"),
    staticClient,
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export class SilpoOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, AuthCode>();
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, Omit<TokenRecord, "expiresAt">>();

  constructor(private config: HttpConfig) {
    this.load();
    if (config.staticClient) {
      const c = config.staticClient;
      this.clients.set(c.clientId, {
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uris: c.redirectUris ?? [],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }
  }

  // --- persistence (survives restarts/deploys) --------------------------------

  private load(): void {
    try {
      if (!existsSync(this.config.stateFile)) return;
      const data = JSON.parse(readFileSync(this.config.stateFile, "utf8"));
      this.clients = new Map(data.clients ?? []);
      this.accessTokens = new Map(data.accessTokens ?? []);
      this.refreshTokens = new Map(data.refreshTokens ?? []);
    } catch (e) {
      console.error("Failed to load OAuth state (starting fresh):", e);
    }
  }

  private persist(): void {
    try {
      const dir = dirname(this.config.stateFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {
        clients: [...this.clients.entries()],
        accessTokens: [...this.accessTokens.entries()],
        refreshTokens: [...this.refreshTokens.entries()],
      };
      writeFileSync(this.config.stateFile, JSON.stringify(data), { mode: 0o600 });
    } catch (e) {
      console.error("Failed to persist OAuth state:", e);
    }
  }

  // --- clients store (with Dynamic Client Registration enabled) ---------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => {
        // The register handler has already assigned client_id/secret at runtime,
        // even though the parameter type omits them.
        const full = client as OAuthClientInformationFull;
        this.clients.set(full.client_id, full);
        this.persist();
        return full;
      },
    };
  }

  // --- authorization: render a login page -------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(this.loginPage(client.client_id, params, ""));
  }

  /** Custom POST /login handler: validate password, mint code, redirect back. */
  handleLogin = async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const clientId = String(body.client_id ?? "");
    const redirectUri = String(body.redirect_uri ?? "");
    const codeChallenge = String(body.code_challenge ?? "");
    const state = body.state ? String(body.state) : undefined;
    const scopes = body.scope ? String(body.scope).split(/\s+/).filter(Boolean) : [];
    const resource = body.resource ? String(body.resource) : undefined;
    const password = String(body.password ?? "");

    const client = this.clients.get(clientId);
    if (!client || !codeChallenge) {
      res.status(400).send("Invalid authorization request.");
      return;
    }
    // Guard against open redirects: redirect_uri must be one the client registered.
    if (client.redirect_uris?.length && !client.redirect_uris.includes(redirectUri)) {
      res.status(400).send("redirect_uri does not match a registered value.");
      return;
    }
    if (!safeEqual(password, this.config.password)) {
      res
        .status(401)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .send(
          this.loginPage(
            clientId,
            { redirectUri, codeChallenge, state, scopes, resource: resource ? new URL(resource) : undefined },
            "Невірний пароль. Спробуйте ще раз.",
          ),
        );
      return;
    }

    const code = randomUUID();
    this.codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      scopes,
      resource,
      expiresAt: Date.now() + 60_000,
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.redirect(target.toString());
  };

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = this.codes.get(authorizationCode);
    if (!rec) throw new InvalidGrantError("Unknown authorization code");
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode);
    if (!rec) throw new InvalidGrantError("Unknown authorization code");
    this.codes.delete(authorizationCode);
    if (rec.expiresAt < Date.now()) throw new InvalidGrantError("Authorization code expired");
    if (rec.clientId !== client.client_id) throw new InvalidGrantError("Client mismatch");
    if (redirectUri && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    return this.issueTokens(client.client_id, rec.scopes, resource?.toString() ?? rec.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.refreshTokens.get(refreshToken);
    if (!rec) throw new InvalidGrantError("Unknown refresh token");
    if (rec.clientId !== client.client_id) throw new InvalidGrantError("Client mismatch");
    // Do NOT rotate the refresh token: keep it stable so retries / repeated
    // refreshes always succeed. Only mint a fresh access token.
    const accessToken = randomBytes(32).toString("hex");
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: scopes?.length ? scopes : rec.scopes,
      resource: resource?.toString() ?? rec.resource,
      expiresAt: Date.now() + this.config.tokenTtl * 1000,
    });
    this.persist();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.tokenTtl,
      refresh_token: refreshToken,
      scope: (scopes?.length ? scopes : rec.scopes).join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.accessTokens.get(token);
    if (!rec) throw new InvalidTokenError("Token not recognized");
    if (rec.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      throw new InvalidTokenError("Token expired");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.accessTokens.delete(request.token);
    this.refreshTokens.delete(request.token);
    this.persist();
  }

  // --- helpers ----------------------------------------------------------------

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.config.tokenTtl * 1000,
    });
    this.refreshTokens.set(refreshToken, { clientId, scopes, resource });
    this.persist();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.tokenTtl,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private loginPage(clientId: string, params: AuthorizationParams, error: string): string {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const hidden = (name: string, value: string | undefined) =>
      value ? `<input type="hidden" name="${name}" value="${esc(value)}">` : "";
    return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Silpo MCP — вхід</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f4f5;display:grid;place-items:center;height:100vh;margin:0}
  form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);width:320px}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input[type=password]{width:100%;padding:.6rem;border:1px solid #d4d4d8;border-radius:8px;box-sizing:border-box}
  button{margin-top:1rem;width:100%;padding:.6rem;background:#16a34a;color:#fff;border:0;border-radius:8px;font-size:1rem;cursor:pointer}
  .err{color:#dc2626;font-size:.85rem;margin-top:.5rem}
  .hint{color:#71717a;font-size:.8rem;margin-top:1rem}
</style></head>
<body>
<form method="post" action="${esc(this.config.baseUrl)}/login">
  <h1>🛒 Silpo MCP — авторизація</h1>
  ${hidden("client_id", clientId)}
  ${hidden("redirect_uri", params.redirectUri)}
  ${hidden("code_challenge", params.codeChallenge)}
  ${hidden("state", params.state)}
  ${hidden("scope", params.scopes?.join(" "))}
  ${hidden("resource", params.resource?.toString())}
  <input type="password" name="password" placeholder="Пароль доступу" autofocus required>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <button type="submit">Увійти</button>
  <div class="hint">Доступ до вашого приватного Silpo MCP сервера.</div>
</form>
</body></html>`;
  }
}

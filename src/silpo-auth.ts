/**
 * Silpo cabinet-token refresh.
 *
 * The cabinet access token (used for order history, loyalty, personal cart) is
 * a 24h OIDC access token from Silpo's IdentityServer at `auth.silpo.ua`. Silpo
 * issues NO refresh token (scope `public-my openid`, no `offline_access`); the
 * web app instead renews silently via a hidden iframe, replaying the
 * authorization-code + PKCE flow with `prompt=none` and relying on the
 * `.AspNetCore.Identity.Application` session cookie held at `auth.silpo.ua`.
 *
 * We reproduce exactly that: given the session cookie, mint a fresh PKCE pair,
 * hit `/connect/authorize?prompt=none` to obtain a one-time `code`, then
 * exchange it at `/connect/token` for a new 24h access token. Only that single
 * cookie is required — no Cloudflare cookies, and it works from a server IP.
 *
 * If a response re-issues the session cookie, we capture and persist the new
 * value. When the cookie stops working, the user pastes a fresh one.
 */

import { createHash, randomBytes } from "node:crypto";

const AUTH_ORIGIN = "https://auth.silpo.ua";
const CLIENT_ID = "silpo--site--spa";
const REDIRECT_URI = "https://silpo.ua/silent-refresh-angular.html";
const SCOPE = "public-my openid";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

/** The only cookie the silent-refresh flow needs. */
export const AUTH_COOKIE_NAME = ".AspNetCore.Identity.Application";

const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class AuthRefreshError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AuthRefreshError";
  }
}

/** Unix-seconds `exp` from a JWT, or null if unparseable. */
export function jwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/** Seconds until the token expires (negative if already expired), or null. */
export function secondsUntilExpiry(token: string): number | null {
  const exp = jwtExp(token);
  return exp === null ? null : exp - Math.floor(Date.now() / 1000);
}

/**
 * Normalize whatever the user pasted into a `Cookie` header value. Accepts a
 * bare cookie value, a `name=value` pair, or a full cookie string; extracts the
 * `.AspNetCore.Identity.Application` value and returns just that pair.
 */
export function normalizeAuthCookie(input: string): string {
  const raw = input.trim();
  const marker = `${AUTH_COOKIE_NAME}=`;
  const idx = raw.indexOf(marker);
  if (idx !== -1) {
    const after = raw.slice(idx + marker.length);
    const value = after.split(";")[0].trim();
    return `${AUTH_COOKIE_NAME}=${value}`;
  }
  // Bare value (no name=): assume it's the cookie value itself.
  return `${AUTH_COOKIE_NAME}=${raw.split(";")[0].trim()}`;
}

export interface RefreshedToken {
  accessToken: string;
  expiresIn: number;
  /**
   * A rotated `.AspNetCore.Identity.Application` cookie, if the server re-issued
   * one in the response. Persisting it lets the stored cookie stay current when
   * the session is used regularly.
   */
  authCookie?: string;
}

/** Pull a rotated identity cookie out of a response's Set-Cookie headers. */
function rotatedAuthCookie(headers: Headers): string | undefined {
  const list =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const c of list) {
    if (c.startsWith(`${AUTH_COOKIE_NAME}=`)) {
      const value = c.slice(AUTH_COOKIE_NAME.length + 1).split(";")[0].trim();
      if (value) return `${AUTH_COOKIE_NAME}=${value}`;
    }
  }
  return undefined;
}

/**
 * Exchange the session cookie for a fresh cabinet access token via the silent
 * (`prompt=none`) authorization-code + PKCE flow.
 */
export async function refreshCabinetToken(authCookie: string): Promise<RefreshedToken> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const authorizeUrl =
    `${AUTH_ORIGIN}/connect/authorize?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      nonce: b64url(randomBytes(12)),
      state: b64url(randomBytes(12)),
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "none",
    }).toString();

  const authRes = await fetch(authorizeUrl, {
    redirect: "manual",
    headers: {
      accept: "text/html",
      referer: "https://silpo.ua/",
      "user-agent": USER_AGENT,
      cookie: authCookie,
    },
  });

  // Capture a rotated session cookie if the sliding window refreshed it.
  let rotated = rotatedAuthCookie(authRes.headers);

  const location = authRes.headers.get("location");
  if (authRes.status !== 302 || !location) {
    throw new AuthRefreshError(
      "Silent authorize did not redirect — the session cookie is likely expired. " +
        "Paste a fresh cookie via set_auth_cookie.",
      authRes.status,
    );
  }
  // On an expired session IdentityServer redirects back with ?error=login_required.
  const params = new URL(location).searchParams;
  const err = params.get("error");
  if (err) {
    throw new AuthRefreshError(
      `Silent authorize failed (${err}) — session cookie expired; paste a fresh one.`,
    );
  }
  const code = params.get("code");
  if (!code) throw new AuthRefreshError("Silent authorize returned no authorization code.");

  const tokenRes = await fetch(`${AUTH_ORIGIN}/connect/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://silpo.ua",
      referer: "https://silpo.ua/",
      "user-agent": USER_AGENT,
      cookie: authCookie,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code_verifier: verifier,
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  // The token response is later in the flow, so prefer its rotated cookie.
  rotated = rotatedAuthCookie(tokenRes.headers) ?? rotated;

  const body = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  } | null;

  if (!tokenRes.ok || !body?.access_token) {
    throw new AuthRefreshError(
      `Token exchange failed: ${body?.error ?? `HTTP ${tokenRes.status}`}`,
      tokenRes.status,
    );
  }
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? 86400,
    authCookie: rotated,
  };
}

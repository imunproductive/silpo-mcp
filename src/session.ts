/** Session and shopping list state (optionally persisted to disk). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DeliveryType } from "./silpo-api.js";
import { DEFAULT_COMPANY_ID } from "./silpo-api.js";

export interface DeliveryAddress {
  label: string;
  latitude: number;
  longitude: number;
}

export interface Timeslot {
  start: string;
  end: string;
}

export interface ShoppingListItem {
  slug: string;
  title: string;
  quantity: number;
  price?: number;
  comment?: string;
  checked: boolean;
}

export interface Session {
  companyId: string;
  address?: DeliveryAddress;
  branchId?: string;
  deliveryType?: DeliveryType;
  timeslot?: Timeslot;
  authToken?: string;
  basketId?: string;
  shoppingList: ShoppingListItem[];
}

export const session: Session = {
  companyId: DEFAULT_COMPANY_ID,
  shoppingList: [],
};

/** Branch is required for most catalogue endpoints. */
export function requireBranch(): string {
  if (!session.branchId) {
    throw new Error(
      "No delivery branch selected yet. Call set_delivery_address first " +
        "(with an address or latitude/longitude) so a Silpo store can be resolved.",
    );
  }
  return session.branchId;
}

export function requireToken(): string {
  if (!session.authToken) {
    throw new Error(
      "This action needs authorization. Call set_auth_token with a Bearer token " +
        "from your Silpo cabinet (id.silpo.ua) first.",
    );
  }
  return session.authToken;
}

// ---------------------------------------------------------------------------
// persistence (remote mode) — survive restarts/deploys/reboots
// ---------------------------------------------------------------------------

/** Fields worth persisting across restarts (everything except derived state). */
const PERSIST_KEYS = [
  "address",
  "branchId",
  "deliveryType",
  "timeslot",
  "authToken",
  "basketId",
  "shoppingList",
] as const;

function serializeSession(): string {
  const out: Record<string, unknown> = {};
  const s = session as unknown as Record<string, unknown>;
  for (const k of PERSIST_KEYS) out[k] = s[k];
  return JSON.stringify(out);
}

export function loadSession(file: string): void {
  try {
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const s = session as unknown as Record<string, unknown>;
    for (const k of PERSIST_KEYS) {
      if (data[k] !== undefined) s[k] = data[k];
    }
  } catch (e) {
    console.error("Failed to load session state (starting fresh):", e);
  }
}

/**
 * Load persisted session, then autosave on change. The Silpo cabinet token and
 * cart end up on disk, so the file is written 0600 (owned by the service user).
 */
export function enableSessionAutosave(file: string, intervalMs = 4000): void {
  loadSession(file);
  let last = serializeSession();
  const save = () => {
    try {
      const cur = serializeSession();
      if (cur === last) return;
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(file, cur, { mode: 0o600 });
      last = cur;
    } catch (e) {
      console.error("Failed to persist session state:", e);
    }
  };
  const timer = setInterval(save, intervalMs);
  timer.unref?.();
  process.on("SIGTERM", save);
  process.on("SIGINT", save);
  process.on("beforeExit", save);
}

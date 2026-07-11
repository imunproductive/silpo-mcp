/**
 * Silpo API client.
 *
 * Thin wrapper over the reverse-engineered Silpo storefront API
 * (host: sf-ecom-api.silpo.ua). Endpoints and payload shapes were derived
 * from real browser traffic (see silpo.ua.har). No official SDK exists.
 */

export const ECOM_BASE = "https://sf-ecom-api.silpo.ua";
export const EXTERNAL_BASE = "https://sf-external-api.silpo.ua";
/** Account/ecom API — used for order history that includes line items. */
export const ORDERS_BASE = "https://ecom-api.silpo.ua";
/** CDN that serves product artwork (the bare filenames in a product's `media`). */
export const IMAGES_BASE = "https://images.silpo.ua";

/** Company id used by the public silpo.ua storefront. */
export const DEFAULT_COMPANY_ID = "1ec88c5d-a050-669c-8467-570a157f3e31";

export type DeliveryType =
  | "LongDelivery"
  | "DeliveryHome"
  | "SelfPickup"
  | "NovaPoshta"
  | "B2B"
  | "PreOrder";

export const ALL_DELIVERY_TYPES: DeliveryType[] = [
  "DeliveryHome",
  "SelfPickup",
  "LongDelivery",
  "B2B",
  "PreOrder",
  "NovaPoshta",
];

export interface Polygon {
  id: string;
  branchId: string;
  name: string;
  deliveryType: DeliveryType;
  geometry?: unknown;
  containsData?: { type?: string } | null;
}

export interface ProductListItem {
  id: string;
  title: string;
  slug: string;
  price: number;
  oldPrice: number | null;
  displayPrice?: number;
  displayOldPrice?: number | null;
  ratio?: string;
  displayRatio?: string;
  stock?: number;
  brandTitle?: string | null;
  externalProductId?: number;
  sectionSlug?: string;
  icon?: string;
  promotions?: Array<{ id: string; type?: string }>;
  weighted?: boolean;
  addToBasketStep?: number;
}

export interface ProductList {
  limit: number;
  offset: number;
  total: number;
  items: ProductListItem[];
}

export class SilpoApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "SilpoApiError";
  }
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | string[]>;
  body?: unknown;
  /** Bearer token (without the "Bearer " prefix, or with — both accepted). */
  token?: string;
  base?: string;
}

function buildQuery(
  query?: Record<string, string | number | boolean | undefined | string[]>,
): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${key}[]=${encodeURIComponent(v)}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export async function silpoRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const base = opts.base ?? ECOM_BASE;
  const url = `${base}${path}${buildQuery(opts.query)}`;

  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": "uk,en;q=0.9",
    origin: "https://silpo.ua",
    referer: "https://silpo.ua/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) {
    const t = opts.token.trim();
    headers["authorization"] = t.toLowerCase().startsWith("bearer ") ? t : `Bearer ${t}`;
  }

  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
    throw new SilpoApiError(`Silpo API error: ${msg}`, res.status, parsed);
  }

  return parsed as T;
}

/** ISO-8601 with an explicit +00:00 offset, as the storefront sends. */
export function isoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/**
 * Build a CDN URL for a product image. A product's `media`/`icon` fields hold
 * bare filenames (e.g. "13dd5e89-….png"); the storefront renders them through
 * an on-the-fly resizer at images.silpo.ua. `size` is "WIDTHxHEIGHT" — the CDN
 * only serves a fixed set of dimensions (300x300 and 600x600 are known-good;
 * larger sizes 307-redirect). `webp` yields the smallest payload.
 */
export function productImageUrl(
  filename: string,
  size = "600x600",
  format: "webp" | "png" = "webp",
): string {
  const segments = ["products", size];
  if (format === "webp") segments.push("webp");
  return `${IMAGES_BASE}/${segments.join("/")}/${filename}`;
}

/** Fetch binary image data and return it base64-encoded with its MIME type,
 *  ready to drop into an MCP `image` content block. */
export async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url, {
    headers: {
      accept: "image/webp,image/png,image/*,*/*",
      referer: "https://silpo.ua/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new SilpoApiError(`Image fetch failed: HTTP ${res.status}`, res.status);
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0] ?? "image/webp";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mimeType };
}

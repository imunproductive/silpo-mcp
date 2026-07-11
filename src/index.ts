#!/usr/bin/env node
/**
 * Silpo MCP server.
 *
 * Exposes the Silpo (Сільпо) online-supermarket storefront API as MCP tools:
 * delivery-address/zone resolution, product search, categories, promotions,
 * product details, delivery time slots, the Silpo cart, a shopping list,
 * recipes and (with a cabinet token/cookie) order history and loyalty balance.
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ALL_DELIVERY_TYPES,
  ECOM_BASE,
  EXTERNAL_BASE,
  ORDERS_BASE,
  fetchImageAsBase64,
  productImageUrl,
  silpoRequest,
  SilpoApiError,
  type DeliveryType,
  type Polygon,
  type ProductList,
  type ProductListItem,
} from "./silpo-api.js";
import {
  requireBranch,
  session,
  type ShoppingListItem,
} from "./session.js";
import {
  AuthRefreshError,
  normalizeAuthCookie,
  refreshCabinetToken,
  secondsUntilExpiry,
} from "./silpo-auth.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function json(obj: unknown) {
  return text(JSON.stringify(obj, null, 2));
}

function fail(err: unknown) {
  const msg =
    err instanceof SilpoApiError
      ? `${err.message} (status ${err.status})`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text" as const, text: `❌ ${msg}` }], isError: true };
}

/**
 * Refresh `session.authToken` in place when it is missing or within `skewSec`
 * of expiry and a refresh cookie is available. Also persists any rotated
 * session cookie the server hands back, keeping the stored cookie current.
 * Pass `skewSec = Infinity` to force a refresh regardless of the current token.
 */
async function refreshAuthIfStale(skewSec = 120): Promise<void> {
  const left = session.authToken ? secondsUntilExpiry(session.authToken) : null;
  const stale = !session.authToken || left === null || left <= skewSec;
  if (stale && session.authCookie) {
    const res = await refreshCabinetToken(session.authCookie);
    session.authToken = res.accessToken;
    if (res.authCookie) session.authCookie = res.authCookie;
  }
}

/**
 * Global cabinet-token accessor. Returns a token that is valid for at least the
 * next `skewSec` seconds, transparently refreshing via the stored session
 * cookie when needed. Throws when no token or cookie is available. Use this
 * everywhere a required token is needed.
 */
async function getToken(skewSec = 120): Promise<string> {
  await refreshAuthIfStale(skewSec);
  if (!session.authToken) {
    throw new Error(
      "This action needs authorization. Call set_auth_cookie (recommended — " +
        "auto-refreshes) or set_auth_token with a Bearer token from id.silpo.ua.",
    );
  }
  return session.authToken;
}

/**
 * Optional variant for endpoints where auth is not required (the cart works
 * anonymously): returns a fresh token if we hold credentials, else undefined.
 */
async function getTokenOptional(skewSec = 120): Promise<string | undefined> {
  await refreshAuthIfStale(skewSec);
  return session.authToken;
}

/**
 * Run an authenticated call; if it 401s and we hold a refresh cookie, force a
 * token refresh once and retry. `run` receives the current token.
 */
async function withAuthRetry<T>(run: (token: string) => Promise<T>): Promise<T> {
  const token = await getToken();
  try {
    return await run(token);
  } catch (e) {
    if (e instanceof SilpoApiError && e.status === 401 && session.authCookie) {
      await refreshAuthIfStale(Infinity);
      if (session.authToken) return run(session.authToken);
    }
    throw e;
  }
}

function formatProduct(p: ProductListItem): string {
  const price = p.displayPrice ?? p.price;
  const old = p.displayOldPrice ?? p.oldPrice;
  const ratio = p.displayRatio ?? p.ratio ?? "";
  const priceStr = old ? `${price}₴ (було ${old}₴)` : `${price}₴`;
  const stock =
    typeof p.stock === "number" ? `, в наявності: ${p.stock}` : "";
  const brand = p.brandTitle ? ` [${p.brandTitle}]` : "";
  return `• ${p.title}${brand} — ${priceStr}${ratio ? ` / ${ratio}` : ""}${stock}\n  slug: ${p.slug}`;
}

function formatProductList(list: ProductList): string {
  if (!list.items?.length) return "Нічого не знайдено.";
  const header = `Знайдено ${list.total} товар(ів), показано ${list.items.length}:`;
  return [header, ...list.items.map(formatProduct)].join("\n");
}

/** Query params shared by catalogue endpoints (timeslot + branch). */
function timeslotParams(): Record<string, string | undefined> {
  if (!session.timeslot) return {};
  return {
    timeslotStart: session.timeslot.start,
    timeslotEnd: session.timeslot.end,
  };
}

/**
 * Ensure a delivery timeslot is selected before a catalogue query.
 *
 * For `LongDelivery` (and similar) branches the backend reports per-item
 * `stock` *relative to a delivery timeslot*: with no timeslot every product
 * comes back as `stock: 0`, which — combined with the default `inStock=true`
 * filter — makes an in-stock category look empty. The storefront always sends a
 * concrete slot, so we mirror that by auto-selecting the first available slot
 * for the current branch when none has been chosen yet. Best-effort: on any
 * failure we leave the timeslot unset and let the query proceed as before.
 */
async function ensureTimeslot(): Promise<void> {
  if (session.timeslot || !session.branchId) return;
  try {
    const data = await silpoRequest<{
      items: Array<{ datePeriod: { start: string; end: string }; isAvailable: boolean }>;
    }>(`/v3/delivery/branches/${session.branchId}/time-slots`, {
      query: { deliveryTypes: [currentDeliveryType()] },
    });
    const slot = data.items?.find((s) => s.isAvailable) ?? data.items?.[0];
    if (slot) {
      session.timeslot = { start: slot.datePeriod.start, end: slot.datePeriod.end };
    }
  } catch {
    /* no slots reachable — proceed without one */
  }
}

function currentDeliveryType(): DeliveryType {
  return session.deliveryType ?? "LongDelivery";
}

/** Best-effort geocoding via OpenStreetMap Nominatim (Silpo autocomplete
 *  is not publicly reachable). Turns free-text address into coordinates. */
async function geocode(
  query: string,
): Promise<Array<{ label: string; latitude: number; longitude: number }>> {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "5",
      "accept-language": "uk",
      countrycodes: "ua",
    }).toString();
  const res = await fetch(url, {
    headers: { "user-agent": "silpo-mcp/1.0 (https://github.com/MIt9/silpo-mcp)" },
  });
  if (!res.ok) throw new Error(`Geocoding failed: HTTP ${res.status}`);
  const data = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
  }>;
  return data.map((d) => ({
    label: d.display_name,
    latitude: Number(d.lat),
    longitude: Number(d.lon),
  }));
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

/**
 * Build a fully-wired Silpo MCP server instance (all tools registered).
 * Used by both the stdio entry point and the remote HTTP transport.
 *
 * NOTE: session/cart state lives in the module-level `session` singleton and is
 * therefore shared across all server instances created here. That is intentional
 * for single-user self-hosting (stdio, or a password-gated personal remote host).
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "silpo-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

// ===========================================================================
// Session configuration
// ===========================================================================

// NOTE: search_address is disabled — it relied on OpenStreetMap geocoding as a
// fallback (Silpo's own address autocomplete is not yet captured). Re-enable once
// the native endpoint is known. set_delivery_address still accepts coordinates.
/*
server.tool(
  "search_address",
  "Пошук адреси / автодоповнення за текстом. Повертає варіанти з координатами, " +
    "які можна передати в set_delivery_address.",
  { query: z.string().describe("Адреса текстом, напр. 'Вінниця, вулиця Лисенка, 12'") },
  async ({ query }) => {
    try {
      const results = await geocode(query);
      if (!results.length) return text("Адрес не знайдено. Спробуйте уточнити запит.");
      return text(
        results
          .map(
            (r, i) =>
              `${i + 1}. ${r.label}\n   координати: ${r.latitude}, ${r.longitude}`,
          )
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);
*/

server.tool(
  "set_delivery_address",
  "Встановити адресу доставки (текстом або координатами). Визначає магазин (branch) " +
    "та тип доставки за координатами через API Сільпо.",
  {
    query: z
      .string()
      .optional()
      .describe("Адреса текстом (буде геокодовано у координати)"),
    latitude: z.number().optional().describe("Широта"),
    longitude: z.number().optional().describe("Довгота"),
  },
  async ({ query, latitude, longitude }) => {
    try {
      let lat = latitude;
      let lon = longitude;
      let label = query ?? "";

      if (lat === undefined || lon === undefined) {
        if (!query) {
          return fail(
            new Error("Вкажіть або координати (latitude/longitude), або адресу (query)."),
          );
        }
        const geo = await geocode(query);
        if (!geo.length) return text("Не вдалося визначити координати для цієї адреси.");
        lat = geo[0].latitude;
        lon = geo[0].longitude;
        label = geo[0].label;
      }

      const polygon = await silpoRequest<Polygon>("/v1/polygons/contains", {
        query: { latitude: lat, longitude: lon },
      });

      session.address = { label: label || `${lat}, ${lon}`, latitude: lat, longitude: lon };
      session.branchId = polygon.branchId;
      session.deliveryType = polygon.deliveryType;

      return text(
        `✅ Адресу встановлено: ${session.address.label}\n` +
          `Магазин: ${polygon.name}\n` +
          `branchId: ${polygon.branchId}\n` +
          `Тип доставки: ${polygon.deliveryType}`,
      );
    } catch (e) {
      if (e instanceof SilpoApiError && e.status === 404) {
        return text(
          "На жаль, за цими координатами доставка недоступна (адреса поза зоною доставки Сільпо).",
        );
      }
      return fail(e);
    }
  },
);

server.tool(
  "get_current_address",
  "Переглянути поточну адресу доставки та обраний магазин.",
  {},
  async () => {
    if (!session.address) return text("Адресу доставки ще не встановлено.");
    return json({
      address: session.address,
      branchId: session.branchId,
      deliveryType: session.deliveryType,
    });
  },
);

server.tool(
  "set_auth_token",
  "Встановити токен авторизації (Bearer з кабінету id.silpo.ua) для особистих функцій: " +
    "кошик, історія замовлень, баланс бонусів.",
  { token: z.string().describe("Токен доступу (з або без префікса 'Bearer ')") },
  async ({ token }) => {
    session.authToken = token.trim().replace(/^bearer\s+/i, "");
    const left = secondsUntilExpiry(session.authToken);
    const note =
      left === null
        ? ""
        : left <= 0
          ? " ⚠️ Токен уже прострочений."
          : ` Дійсний ще ~${Math.round(left / 3600)} год.`;
    return text(
      `✅ Токен авторизації збережено для цієї сесії.${note}\n` +
        "Порада: set_auth_cookie автоматично оновлюватиме токен без ручного вводу.",
    );
  },
);

server.tool(
  "set_auth_cookie",
  "Зберегти cookie сесії Сільпо (.AspNetCore.Identity.Application) для " +
    "автоматичного оновлення токена кабінету. Візьміть його в DevTools → " +
    "Application → Cookies для auth.silpo.ua. Можна вставити саме значення, " +
    "пару name=value або повний рядок cookie.",
  { cookie: z.string().describe("Значення cookie .AspNetCore.Identity.Application") },
  async ({ cookie }) => {
    try {
      const normalized = normalizeAuthCookie(cookie);
      const res = await refreshCabinetToken(normalized);
      session.authCookie = res.authCookie ?? normalized;
      session.authToken = res.accessToken;
      const { expiresIn } = res;
      return text(
        `✅ Cookie збережено; токен кабінету оновлено (дійсний ~${Math.round(
          expiresIn / 3600,
        )} год). Надалі оновлюватиметься автоматично.`,
      );
    } catch (e) {
      if (e instanceof AuthRefreshError) return fail(e);
      return fail(e);
    }
  },
);

server.tool(
  "set_basket_id",
  "Вказати існуючий ID кошика Сільпо (uuid), щоб продовжити роботу з ним.",
  { basketId: z.string().describe("UUID кошика") },
  async ({ basketId }) => {
    session.basketId = basketId;
    // If the cart already carries an address/branch, restore it into the session.
    try {
      const cart = await silpoRequest<any>(
        `/v2/uk/shopping-cart/${encodeURIComponent(basketId)}`,
        { query: { strictValidation: false }, token: await getTokenOptional() },
      );
      if (cart?.address?.latitude && cart?.address?.longitude) {
        session.address = {
          label: cart.address.locality ?? cart.address.city ?? "з кошика",
          latitude: Number(cart.address.latitude),
          longitude: Number(cart.address.longitude),
        };
      }
      const branchId = cart?.shipments?.[0]?.branchId;
      if (branchId) session.branchId = branchId;
      if (cart?.deliveryType) session.deliveryType = cart.deliveryType;
      if (cart?.timeslot?.start && cart?.timeslot?.end) {
        session.timeslot = { start: cart.timeslot.start, end: cart.timeslot.end };
      }
      return text(
        `✅ Кошик ${basketId} підключено.` +
          (session.branchId ? `\nМагазин відновлено: ${session.branchId}` : "") +
          (session.address ? `\nАдреса: ${session.address.label}` : ""),
      );
    } catch (e) {
      return text(
        `✅ ID кошика збережено (${basketId}). ` +
          `Не вдалося одразу підвантажити кошик: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
    }
  },
);

server.tool("get_session_info", "Інформація про поточну сесію.", {}, async () => {
  return json({
    companyId: session.companyId,
    address: session.address ?? null,
    branchId: session.branchId ?? null,
    deliveryType: session.deliveryType ?? null,
    timeslot: session.timeslot ?? null,
    hasAuthToken: Boolean(session.authToken),
    authTokenExpiresInSec: session.authToken ? secondsUntilExpiry(session.authToken) : null,
    hasAuthCookie: Boolean(session.authCookie),
    basketId: session.basketId ?? null,
    shoppingListItems: session.shoppingList.length,
  });
});

// ===========================================================================
// Products & search
// ===========================================================================

server.tool(
  "search_products",
  "Пошук товарів за назвою або ключовими словами в обраному магазині.",
  {
    query: z.string().describe("Пошуковий запит, напр. 'молоко'"),
    limit: z.number().int().min(1).max(50).default(20).describe("Кількість результатів"),
  },
  async ({ query, limit }) => {
    try {
      const branch = requireBranch();
      await ensureTimeslot();
      const list = await silpoRequest<ProductList>(
        `/v1/uk/branches/${branch}/quick-search`,
        {
          query: {
            limit,
            search: query,
            sortBy: "productsList",
            sortDirection: "desc",
            deliveryType: currentDeliveryType(),
            ...timeslotParams(),
          },
        },
      );
      return text(formatProductList(list));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_categories",
  "Список категорій товарів. Можна фільтрувати за підрядком назви або parentId.",
  {
    search: z.string().optional().describe("Фільтр за підрядком назви категорії"),
    parentId: z.string().optional().describe("Показати підкатегорії цього parentId"),
    limit: z.number().int().min(1).max(500).default(60).describe("Максимум категорій"),
  },
  async ({ search, parentId, limit }) => {
    try {
      const branch = requireBranch();
      const data = await silpoRequest<{
        items: Array<{ id: string; title: string; slug: string; parentId: string }>;
      }>(`/v1/uk/branches/${branch}/categories`, {
        query: { deliveryType: currentDeliveryType() },
      });
      let items = data.items ?? [];
      if (parentId) items = items.filter((c) => c.parentId === parentId);
      if (search) {
        const q = search.toLowerCase();
        items = items.filter((c) => c.title.toLowerCase().includes(q));
      }
      items = items.slice(0, limit);
      if (!items.length) return text("Категорій не знайдено.");
      return text(
        items
          .map((c) => `• ${c.title}\n  slug: ${c.slug}\n  id: ${c.id}`)
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_category_products",
  "Товари у вибраній категорії (за slug), з сортуванням та пагінацією.",
  {
    category: z.string().describe("slug категорії, напр. 'moloko-4956'"),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
    sortBy: z
      .enum(["popularity", "price", "productsList", "createdAt"])
      .default("popularity"),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
    inStock: z.boolean().default(true),
    onlyPromo: z.boolean().default(false).describe("Лише товари з акцією"),
  },
  async ({ category, limit, offset, sortBy, sortDirection, inStock, onlyPromo }) => {
    try {
      const branch = requireBranch();
      await ensureTimeslot();
      const list = await silpoRequest<ProductList>(
        `/v1/uk/branches/${branch}/products`,
        {
          query: {
            limit,
            offset,
            category,
            includeChildCategories: true,
            deliveryType: currentDeliveryType(),
            sortBy,
            sortDirection,
            inStock,
            mustHavePromotion: onlyPromo || undefined,
            ...timeslotParams(),
          },
        },
      );
      return text(formatProductList(list));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_promotions",
  "Товари зі знижками (акції). Опційно в межах категорії.",
  {
    category: z.string().optional().describe("slug категорії для фільтрації"),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  async ({ category, limit, offset }) => {
    try {
      const branch = requireBranch();
      await ensureTimeslot();
      const list = await silpoRequest<ProductList>(
        `/v1/uk/branches/${branch}/products`,
        {
          query: {
            limit,
            offset,
            category,
            includeChildCategories: category ? true : undefined,
            deliveryType: currentDeliveryType(),
            sortBy: "popularity",
            sortDirection: "desc",
            inStock: true,
            mustHavePromotion: true,
            ...timeslotParams(),
          },
        },
      );
      return text(formatProductList(list));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_product",
  "Деталі товару за його slug.",
  { slug: z.string().describe("slug товару, напр. 'moloko-galychyna-...-815590'") },
  async ({ slug }) => {
    try {
      const branch = requireBranch();
      await ensureTimeslot();
      const product = await silpoRequest<any>(
        `/v1/uk/branches/${branch}/products/${encodeURIComponent(slug)}`,
        {
          query: { deliveryType: currentDeliveryType(), ...timeslotParams() },
        },
      );
      return json({
        id: product.id,
        title: product.title,
        slug: product.slug,
        price: product.displayPrice ?? product.price,
        oldPrice: product.displayOldPrice ?? product.oldPrice,
        ratio: product.ratio,
        displayRatio: product.displayRatio,
        addToBasketStep: product.addToBasketStep,
        stock: product.stock,
        brandTitle: product.brandTitle,
        guestProductRating: product.guestProductRating,
        guestProductRatingCount: product.guestProductRatingCount,
        description: product.description,
        sections: product.sections,
        externalProductId: product.externalProductId,
        promotions: product.promotions,
        media: product.media,
        // Full structured product specs: composition, allergens, country,
        // brand, nutrition, etc. Returned verbatim from the API.
        attributeGroups: product.attributeGroups,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_product_images",
  "Фото товару за slug — повертає самі зображення (не посилання), придатні для " +
    "показу. Бере файли з поля media товару та завантажує їх із CDN Сільпо.",
  {
    slug: z.string().describe("slug товару, напр. 'moloko-galychyna-...-815590'"),
    size: z
      .enum(["300x300", "600x600"])
      .default("600x600")
      .describe("Розмір зображення (CDN підтримує лише фіксовані розміри)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Максимальна кількість зображень"),
  },
  async ({ slug, size, limit }) => {
    try {
      const branch = requireBranch();
      await ensureTimeslot();
      const product = await silpoRequest<{ title?: string; media?: string[]; icon?: string }>(
        `/v1/uk/branches/${branch}/products/${encodeURIComponent(slug)}`,
        { query: { deliveryType: currentDeliveryType(), ...timeslotParams() } },
      );

      // Prefer the full media gallery; fall back to the single icon.
      const filenames = (product.media?.length ? product.media : product.icon ? [product.icon] : [])
        .filter((f): f is string => Boolean(f))
        .slice(0, limit);
      if (!filenames.length) return text(`Для товару «${slug}» немає зображень.`);

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: `🖼️ ${product.title ?? slug} — ${filenames.length} зображенн${
            filenames.length === 1 ? "я" : "я(нь)"
          }:`,
        },
      ];

      const failed: string[] = [];
      for (const filename of filenames) {
        try {
          const img = await fetchImageAsBase64(productImageUrl(filename, size));
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        } catch {
          failed.push(filename);
        }
      }

      if (content.length === 1) {
        return fail(new Error("Не вдалося завантажити жодного зображення товару."));
      }
      if (failed.length) {
        content.push({
          type: "text",
          text: `⚠️ Не вдалося завантажити: ${failed.join(", ")}`,
        });
      }
      return { content };
    } catch (e) {
      return fail(e);
    }
  },
);

// ===========================================================================
// Delivery
// ===========================================================================

server.tool(
  "check_delivery_zone",
  "Перевірити, чи потрапляють координати в зону доставки Сільпо.",
  { latitude: z.number(), longitude: z.number() },
  async ({ latitude, longitude }) => {
    try {
      const polygon = await silpoRequest<Polygon>("/v1/polygons/contains", {
        query: { latitude, longitude },
      });
      return text(
        `✅ Так, доставка можлива.\nМагазин: ${polygon.name}\n` +
          `branchId: ${polygon.branchId}\nТип доставки: ${polygon.deliveryType}`,
      );
    } catch (e) {
      if (e instanceof SilpoApiError && e.status === 404) {
        return text("❌ Ні, ці координати поза зоною доставки Сільпо.");
      }
      return fail(e);
    }
  },
);

server.tool(
  "get_delivery_modes",
  "Усі доступні типи доставки за координатами (звичайна, широка номенклатура тощо).",
  { latitude: z.number(), longitude: z.number() },
  async ({ latitude, longitude }) => {
    try {
      const modes = await silpoRequest<Polygon[]>("/v1/polygons/contains/all", {
        query: { latitude, longitude },
      });
      let wide: Polygon | null = null;
      try {
        wide = await silpoRequest<Polygon>("/v1/polygons/wide-assort/contains", {
          query: { latitude, longitude },
        });
      } catch {
        /* wide assortment not available here */
      }
      if (!modes?.length && !wide) return text("Немає доступних типів доставки за цими координатами.");
      const lines = (modes ?? []).map(
        (m) =>
          `• ${m.deliveryType} — ${m.name} (branchId: ${m.branchId}` +
          (m.containsData?.type ? `, ${m.containsData.type}` : "") +
          ")",
      );
      if (wide) lines.push(`• Широка номенклатура — ${wide.name} (branchId: ${wide.branchId})`);
      return text(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_time_slots",
  "Доступні слоти доставки для обраного магазину.",
  {
    deliveryTypes: z
      .array(z.string())
      .optional()
      .describe("Фільтр за типами доставки; за замовчуванням — всі"),
  },
  async ({ deliveryTypes }) => {
    try {
      const branch = requireBranch();
      const types = deliveryTypes?.length ? deliveryTypes : ALL_DELIVERY_TYPES;
      const data = await silpoRequest<{
        items: Array<{
          datePeriod: { start: string; end: string };
          isAvailable: boolean;
          delivery?: { type?: string };
        }>;
      }>(`/v3/delivery/branches/${branch}/time-slots`, {
        query: { deliveryTypes: types },
      });
      if (!data.items?.length) return text("Немає доступних слотів доставки.");
      return text(
        data.items
          .map((s) => {
            const mark = s.isAvailable ? "✅" : "⛔";
            const type = s.delivery?.type ? ` [${s.delivery.type}]` : "";
            return `${mark} ${s.datePeriod.start} → ${s.datePeriod.end}${type}`;
          })
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "set_delivery_slot",
  "Встановити бажаний час доставки (ISO-8601 з часовим поясом). Використовується " +
    "як timeslot у подальших запитах каталогу.",
  {
    start: z.string().describe("Початок, напр. '2026-07-02T10:00:00+00:00'"),
    end: z.string().describe("Кінець, напр. '2026-07-02T12:00:00+00:00'"),
  },
  async ({ start, end }) => {
    session.timeslot = { start, end };
    // If a server cart is active, persist the slot to it as well.
    if (session.basketId) {
      try {
        await patchServerCart(session.basketId, { timeslot: { start, end } });
        return text(`✅ Час доставки встановлено та збережено в кошику: ${start} → ${end}`);
      } catch (e) {
        return text(
          `✅ Час доставки встановлено локально: ${start} → ${end}\n` +
            `⚠️ Не вдалося записати в кошик: ${
              e instanceof Error ? e.message : String(e)
            }`,
        );
      }
    }
    return text(`✅ Час доставки встановлено: ${start} → ${end}`);
  },
);

server.tool("get_delivery_slot", "Переглянути обраний час доставки.", {}, async () => {
  if (!session.timeslot) return text("Час доставки ще не обрано.");
  return json(session.timeslot);
});

// ===========================================================================
// Shopping list (separate from cart)
// ===========================================================================

server.tool(
  "add_to_shopping_list",
  "Додати товар у список покупок (окремо від кошика).",
  {
    title: z.string().describe("Назва товару"),
    slug: z.string().optional(),
    quantity: z.number().positive().default(1),
    comment: z.string().optional(),
  },
  async ({ title, slug, quantity, comment }) => {
    session.shoppingList.push({
      slug: slug ?? title,
      title,
      quantity,
      comment,
      checked: false,
    });
    return text(`✅ Додано у список покупок: ${title} ×${quantity}`);
  },
);

server.tool("get_shopping_list", "Переглянути список покупок.", {}, async () => {
  if (!session.shoppingList.length) return text("Список покупок порожній.");
  const lines = session.shoppingList.map(
    (i, idx) =>
      `${i.checked ? "☑" : "☐"} ${idx + 1}. ${i.title} ×${i.quantity}` +
      (i.comment ? ` (${i.comment})` : ""),
  );
  return text(lines.join("\n"));
});

server.tool(
  "remove_from_shopping_list",
  "Видалити товар зі списку покупок (за назвою або slug).",
  { titleOrSlug: z.string() },
  async ({ titleOrSlug }) => {
    const before = session.shoppingList.length;
    session.shoppingList = session.shoppingList.filter(
      (i) => i.title !== titleOrSlug && i.slug !== titleOrSlug,
    );
    return text(
      session.shoppingList.length < before
        ? `✅ Видалено: ${titleOrSlug}`
        : `Не знайдено: ${titleOrSlug}`,
    );
  },
);

server.tool("clear_shopping_list", "Очистити список покупок.", {}, async () => {
  session.shoppingList = [];
  return text("✅ Список покупок очищено.");
});

server.tool(
  "set_shopping_list_item_checked",
  "Позначити пункт списку покупок як куплений / не куплений.",
  { titleOrSlug: z.string(), checked: z.boolean() },
  async ({ titleOrSlug, checked }) => {
    const item = session.shoppingList.find(
      (i) => i.title === titleOrSlug || i.slug === titleOrSlug,
    );
    if (!item) return text(`Не знайдено: ${titleOrSlug}`);
    item.checked = checked;
    return text(`✅ ${item.title}: ${checked ? "куплено" : "не куплено"}`);
  },
);

/**
 * Resolve a shopping-list item to a Silpo productId: exact product lookup by
 * slug first, then quick-search by title (items added by name only carry the
 * title as a pseudo-slug).
 */
async function resolveProductId(branch: string, item: ShoppingListItem): Promise<string> {
  if (item.slug && item.slug !== item.title) {
    try {
      const product = await silpoRequest<any>(
        `/v1/uk/branches/${branch}/products/${encodeURIComponent(item.slug)}`,
        { query: { deliveryType: currentDeliveryType(), ...timeslotParams() } },
      );
      if (product?.id) return product.id;
    } catch {
      /* fall back to search below */
    }
  }
  const list = await silpoRequest<ProductList>(`/v1/uk/branches/${branch}/quick-search`, {
    query: {
      limit: 1,
      search: item.title,
      sortBy: "productsList",
      sortDirection: "desc",
      deliveryType: currentDeliveryType(),
      ...timeslotParams(),
    },
  });
  const hit = list.items?.[0];
  if (!hit) throw new Error(`товар не знайдено за назвою «${item.title}»`);
  return hit.id;
}

server.tool(
  "shopping_list_to_cart",
  "Додати всі пункти списку покупок у кошик Сільпо (кожен товар знаходиться " +
    "за slug або назвою; кошик створюється автоматично, якщо його ще немає).",
  {},
  async () => {
    try {
      const branch = requireBranch();
      const id = await ensureBasket();
      const added: string[] = [];
      const failed: string[] = [];
      for (const item of session.shoppingList) {
        try {
          const productId = await resolveProductId(branch, item);
          const current = cartQuantityOf(await fetchServerCart(id), productId);
          await setServerCartQuantity(id, productId, current + item.quantity);
          added.push(`${item.title} ×${item.quantity}`);
        } catch (e) {
          failed.push(`${item.title}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      let out = `✅ Додано в кошик: ${added.length} з ${session.shoppingList.length}.`;
      if (added.length) out += `\n${added.map((s) => `• ${s}`).join("\n")}`;
      if (failed.length)
        out += `\n⚠️ Не вдалося додати:\n${failed.map((s) => `• ${s}`).join("\n")}`;
      return text(out);
    } catch (e) {
      return fail(e);
    }
  },
);

// ===========================================================================
// Cart (the real Silpo basket; created lazily on first add)
// ===========================================================================

function summarizeServerCart(cart: any): string {
  const products: any[] = (cart.shipments ?? []).flatMap((s: any) => s.products ?? []);
  const header =
    `Кошик ${cart.id}\n` +
    (cart.address?.locality ? `Адреса: ${cart.address.locality}\n` : "") +
    (cart.deliveryType ? `Доставка: ${cart.deliveryType}\n` : "") +
    (cart.timeslot ? `Час: ${cart.timeslot.start} → ${cart.timeslot.end}\n` : "");
  if (!products.length) return header + "Кошик порожній.";
  const lines = products.map(
    (p) =>
      `• ${p.productData?.title ?? p.slug} ×${p.quantity} — ${p.total}₴` +
      (p.comment ? ` (${p.comment})` : "") +
      `\n  productId: ${p.productId}`,
  );
  return header + lines.join("\n");
}

/** GET the current server cart (read model lives under /v2/uk/...). */
async function fetchServerCart(id: string): Promise<any> {
  return silpoRequest<any>(`/v2/uk/shopping-cart/${encodeURIComponent(id)}`, {
    query: { ignoreCache: false, strictValidation: false },
    token: await getTokenOptional(),
  });
}

function requireBasket(): string {
  if (!session.basketId) {
    throw new Error(
      "Кошик ще не створено. Додайте товар через add_to_cart (кошик створиться " +
        "автоматично) або викличте set_basket_id (наявний кошик) чи create_cart.",
    );
  }
  return session.basketId;
}

/**
 * Create a new basket on Silpo's side from the current session (address,
 * branch; auto-picks the first available timeslot if none chosen) and store
 * its id in the session.
 *
 * NOTE: POST /v2/shopping-cart is rate-limited by Silpo (HTTP 429) — callers
 * surface a hint to reuse an existing basket via set_basket_id.
 */
async function createBasket(): Promise<string> {
  requireBranch();
  if (!session.address) {
    throw new Error("Спочатку встановіть адресу доставки (set_delivery_address).");
  }
  // Creation requires a non-null timeslot.
  await ensureTimeslot();
  if (!session.timeslot) {
    throw new Error("Немає доступних слотів доставки — оберіть час через set_delivery_slot.");
  }
  const res = await silpoRequest<any>("/v2/shopping-cart", {
    method: "POST",
    body: buildCartPatchBody({ id: randomUUID() }),
    token: await getTokenOptional(),
  });
  if (!res?.id) throw new Error("Сервер не повернув id кошика.");
  session.basketId = res.id;
  return res.id;
}

/** Basket id for mutating cart ops — lazily creates the basket on first use. */
async function ensureBasket(): Promise<string> {
  return session.basketId ?? createBasket();
}

/** Friendly message for Silpo's basket-creation rate limit. */
function basketRateLimited(e: unknown) {
  if (e instanceof SilpoApiError && e.status === 429) {
    return text(
      "⚠️ Створення кошика тимчасово обмежене Сільпо (429, забагато запитів). " +
        "Спробуйте за кілька хвилин або скористайтеся наявним кошиком через set_basket_id.",
    );
  }
  return null;
}

/** Find the current quantity of a product already in the cart (0 if absent). */
function cartQuantityOf(cart: any, productId: string): number {
  for (const s of cart.shipments ?? []) {
    for (const p of s.products ?? []) {
      if (p.productId === productId) return Number(p.quantity) || 0;
    }
  }
  return 0;
}

/**
 * Set the absolute quantity of a product line. Mutations are async (HTTP 202,
 * empty body), so we always re-GET the cart afterwards to report state.
 * quantity 0 removes the line.
 */
async function setServerCartQuantity(
  id: string,
  productId: string,
  quantity: number,
): Promise<any> {
  if (quantity <= 0) return removeServerCartProduct(id, productId);
  await silpoRequest(`/v2/shopping-cart/${encodeURIComponent(id)}/products`, {
    method: "POST",
    body: {
      products: [
        {
          productId,
          quantity,
          modifications: [],
          branchId: requireBranch(),
          companyId: session.companyId,
        },
      ],
    },
    token: await getTokenOptional(),
  });
  return fetchServerCart(id);
}

/**
 * Remove a product line entirely. Silpo does NOT model removal as a quantity-0
 * upsert; it exposes a dedicated DELETE /v1/shopping-cart/{id}/removeProducts
 * with the product ids in the body. Like other mutations this returns 202 with
 * an empty body, so we re-GET the cart afterwards.
 */
async function removeServerCartProduct(id: string, productId: string): Promise<any> {
  await silpoRequest(`/v1/shopping-cart/${encodeURIComponent(id)}/removeProducts`, {
    method: "DELETE",
    body: { products: [{ productId, type: "product" }] },
    token: await getTokenOptional(),
  });
  return fetchServerCart(id);
}

/** Build the full cart-settings body for PATCH /v2/shopping-cart/{id}. */
function buildCartPatchBody(overrides: Record<string, unknown> = {}): any {
  const addr = session.address;
  return {
    address: addr
      ? {
          addressType: "flat",
          entrance: null,
          floor: null,
          flat: null,
          latitude: String(addr.latitude),
          longitude: String(addr.longitude),
          courrierComment: null,
          phone: null,
          country: null,
          postCode: null,
          region: null,
          district: null,
          locality: addr.label,
          city: "",
          street: "",
          house: "",
        }
      : undefined,
    certificates: [],
    deliveryType: currentDeliveryType(),
    feedbackChanges: "approvedChanges",
    feedbackContacts: "call",
    guestCompanyId: null,
    isAdultConfirmed: false,
    packageType: "UseSilpoBags",
    paymentType: "Unknown",
    promoCode: null,
    shipments: [{ companyId: session.companyId, branchId: requireBranch() }],
    timeslot: session.timeslot ?? null,
    bonusRequested: null,
    ...overrides,
  };
}

async function patchServerCart(id: string, overrides: Record<string, unknown> = {}) {
  return silpoRequest<any>(`/v2/shopping-cart/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: buildCartPatchBody(overrides),
    token: await getTokenOptional(),
  });
}

server.tool(
  "get_cart",
  "Переглянути кошик Сільпо (за basketId або збереженим у сесії).",
  { basketId: z.string().optional() },
  async ({ basketId }) => {
    try {
      const id = basketId ?? session.basketId;
      if (!id) return text("Кошик ще не створено — він з'явиться після першого add_to_cart.");
      return text(summarizeServerCart(await fetchServerCart(id)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "create_cart",
  "Створити новий кошик Сільпо вручну. Зазвичай не потрібно — add_to_cart " +
    "створює кошик автоматично. Потрібна встановлена адреса доставки.",
  {},
  async () => {
    try {
      const id = await createBasket();
      return text(
        `✅ Створено кошик: ${id}\n` +
          `Час доставки: ${session.timeslot!.start} → ${session.timeslot!.end}`,
      );
    } catch (e) {
      return basketRateLimited(e) ?? fail(e);
    }
  },
);

server.tool(
  "add_to_cart",
  "Додати товар у кошик Сільпо (додає до наявної кількості). Якщо кошика ще " +
    "немає, він створюється автоматично (потрібна адреса доставки).",
  {
    productId: z.string().describe("id товару (uuid) — беріть з search_products/get_product"),
    quantity: z.number().positive().default(1).describe("Скільки додати (кратно кроку товару)"),
  },
  async ({ productId, quantity }) => {
    try {
      const id = await ensureBasket();
      const current = cartQuantityOf(await fetchServerCart(id), productId);
      const cart = await setServerCartQuantity(id, productId, current + quantity);
      return text(`✅ Додано в кошик.\n${summarizeServerCart(cart)}`);
    } catch (e) {
      return basketRateLimited(e) ?? fail(e);
    }
  },
);

server.tool(
  "update_cart_item",
  "Встановити точну кількість товару в кошику (0 = видалити).",
  {
    productId: z.string().describe("id товару (uuid)"),
    quantity: z.number().min(0).describe("Нова абсолютна кількість"),
  },
  async ({ productId, quantity }) => {
    try {
      const id = requireBasket();
      const cart = await setServerCartQuantity(id, productId, quantity);
      return text(`✅ Кількість оновлено.\n${summarizeServerCart(cart)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "remove_from_cart",
  "Видалити товар із кошика.",
  { productId: z.string().describe("id товару (uuid)") },
  async ({ productId }) => {
    try {
      const id = requireBasket();
      const cart = await removeServerCartProduct(id, productId);
      return text(`✅ Видалено.\n${summarizeServerCart(cart)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool("clear_cart", "Видалити всі товари з кошика Сільпо.", {}, async () => {
  try {
    const id = requireBasket();
    const cart = await fetchServerCart(id);
    const products: any[] = (cart.shipments ?? []).flatMap((s: any) => s.products ?? []);
    if (!products.length) return text("Кошик уже порожній.");
    await silpoRequest(`/v1/shopping-cart/${encodeURIComponent(id)}/removeProducts`, {
      method: "DELETE",
      body: {
        products: products.map((p: any) => ({ productId: p.productId, type: "product" })),
      },
      token: await getTokenOptional(),
    });
    return text(`✅ Кошик очищено (видалено позицій: ${products.length}).`);
  } catch (e) {
    return fail(e);
  }
});

server.tool(
  "add_item_comment",
  "Додати коментар до товару в кошику (напр. 'нарізати', 'стиглі').",
  { productId: z.string().describe("id товару (uuid)"), comment: z.string() },
  async ({ productId, comment }) => {
    try {
      const id = requireBasket();
      await silpoRequest(
        `/v1/shopping-cart/${encodeURIComponent(id)}/products/${encodeURIComponent(productId)}/comment`,
        { method: "POST", body: { comment }, token: await getTokenOptional() },
      );
      return text(`✅ Коментар додано.\n${summarizeServerCart(await fetchServerCart(id))}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ===========================================================================
// Recipes
// ===========================================================================
// NOTE: recipe tools are disabled — they only read the small "active recipes
// group" (/v1/recipe/group/active), not Silpo's full recipe search/filters,
// which are not yet captured. Re-enable once the real endpoints are known.
/*
server.tool(
  "search_recipes",
  "Пошук рецептів на silpo.ua за назвою.",
  { query: z.string().optional().describe("Підрядок назви рецепту (порожній — усі активні)") },
  async ({ query }) => {
    try {
      const group = await silpoRequest<{
        name: string;
        recipes: Array<{
          id: string;
          name: string;
          slug: string;
          cookingTime: number;
          tags?: Array<{ name: string }>;
        }>;
      }>("/v1/recipe/group/active");
      let recipes = group.recipes ?? [];
      if (query) {
        const q = query.toLowerCase();
        recipes = recipes.filter((r) => r.name.toLowerCase().includes(q));
      }
      if (!recipes.length) return text("Рецептів не знайдено.");
      return text(
        recipes
          .map(
            (r) =>
              `• ${r.name} (${r.cookingTime} хв)` +
              (r.tags?.length ? ` — ${r.tags.map((t) => t.name).join(", ")}` : "") +
              `\n  slug: ${r.slug}`,
          )
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_recipe_filters",
  "Отримати доступні фільтри рецептів (час приготування, категорії тощо).",
  {},
  async () => {
    try {
      const group = await silpoRequest<any>("/v1/recipe/group/active");
      const tags = new Map<string, string>();
      let minTime = Infinity;
      let maxTime = 0;
      for (const r of group.recipes ?? []) {
        for (const t of r.tags ?? []) tags.set(t.id, t.name);
        if (typeof r.cookingTime === "number") {
          minTime = Math.min(minTime, r.cookingTime);
          maxTime = Math.max(maxTime, r.cookingTime);
        }
      }
      return json({
        group: group.name,
        tags: [...tags.entries()].map(([id, name]) => ({ id, name })),
        cookingTime: { min: minTime === Infinity ? null : minTime, max: maxTime || null },
      });
    } catch (e) {
      return fail(e);
    }
  },
);
*/

// ===========================================================================
// Account (auth required)
// ===========================================================================

server.tool(
  "get_orders_history",
  "Історія замовлень (потрібен токен авторизації).",
  { limit: z.number().int().min(1).max(50).default(10) },
  async ({ limit }) => {
    try {
      const data = await withAuthRetry((token) =>
        silpoRequest<any>("/v2/order-history/orders", {
          query: { limit, "filter[business]": "silpo" },
          token,
        }),
      );
      if (!data.items?.length) return text("Історія замовлень порожня.");
      return text(
        data.items
          .map(
            (o: any) =>
              `• Замовлення №${o.number} — ${o.status}, ${o.amount}₴\n` +
              `  дата: ${o.delivery?.timeSlot?.from ?? "?"}\n` +
              `  адреса: ${[o.address?.city, o.address?.street, o.address?.house]
                .filter(Boolean)
                .join(", ")}`,
          )
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_order_products",
  "Товари (позиції) з конкретного замовлення. За номером замовлення, або — " +
    "якщо не вказано — з останнього. Потрібна авторизація.",
  {
    orderNumber: z
      .string()
      .optional()
      .describe("Номер замовлення, напр. '35703530' (порожньо — останнє замовлення)"),
    searchLimit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(15)
      .describe("Скільки останніх замовлень переглянути в пошуках номера"),
  },
  async ({ orderNumber, searchLimit }) => {
    try {
      // The v3 store-front orders list already embeds each order's line items
      // under shipments[].items[], so no per-order fetch is needed.
      const data = await withAuthRetry((token) =>
        silpoRequest<any>("/v3/store-front/orders", {
          base: ORDERS_BASE,
          query: { limit: searchLimit, offset: 0, "filter[business]": ["silpo"] },
          token,
        }),
      );
      const orders: any[] = data.items ?? [];
      if (!orders.length) return text("Історія замовлень порожня.");
      const order = orderNumber
        ? orders.find((o) => String(o.number) === orderNumber)
        : orders[0];
      if (!order) {
        return text(
          `Замовлення №${orderNumber} не знайдено серед останніх ${orders.length}. ` +
            "Збільште searchLimit або перевірте номер.",
        );
      }

      const items: any[] = (order.shipments ?? []).flatMap((s: any) => s.items ?? []);
      const lines = items.map((i) => {
        const p = i.product ?? {};
        const flags = [
          i.removed ? "видалено" : null,
          i.added ? "додано" : null,
          i.replacements?.length ? "заміна" : null,
        ].filter(Boolean);
        return (
          `• ${p.title ?? "?"} ×${i.quantity} — ${i.subtotal}₴` +
          (flags.length ? ` (${flags.join(", ")})` : "") +
          (i.comment ? ` — «${i.comment}»` : "") +
          (p.id ? `\n  productId: ${p.id}` : "")
        );
      });
      const header =
        `Замовлення №${order.number} — ${order.status}, ${order.amount}₴ ` +
        `(${items.length} позицій)\n` +
        `дата: ${order.delivery?.timeSlot?.from ?? order.createdAt ?? "?"}`;
      return text(`${header}\n${lines.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_loyalty_balance",
  "Баланс бонусів та картка лояльності (потрібен токен авторизації).",
  {},
  async () => {
    try {
      const token = await getToken();
      const balance = await silpoRequest<any>("/v1/loyalty-processing/my/balance", {
        base: EXTERNAL_BASE,
        token,
      });
      let card: any = null;
      try {
        card = await silpoRequest<any>("/v1/my/loyalty/main-card", { token });
      } catch {
        /* card optional */
      }
      return json({
        balance: balance.balance,
        currency: balance.currency,
        accounts: balance.accounts,
        card: card
          ? { barcode: card.barcode, typeName: card.typeName, statusName: card.statusName }
          : null,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "silpo_suggest_from_history",
  "Пропозиції «як зазвичай» — товари на основі минулих покупок (потрібен токен).",
  { limit: z.number().int().min(1).max(50).default(20) },
  async ({ limit }) => {
    try {
      const branch = requireBranch();
      const data = await withAuthRetry((token) =>
        silpoRequest<ProductList>(
          `/v1/uk/branches/${branch}/my/orders/latest-products`,
          {
            query: { limit, deliveryType: currentDeliveryType() },
            token,
          },
        ),
      );
      return text(formatProductList(data));
    } catch (e) {
      return fail(e);
    }
  },
);

  return server;
}

// ===========================================================================
// bootstrap (stdio) — only when run directly, not when imported by http.ts
// ===========================================================================

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logging; stdout is the MCP transport.
  console.error(
    `Silpo MCP server running (ecom base: ${ECOM_BASE}). Waiting for requests…`,
  );
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error starting Silpo MCP server:", err);
    process.exit(1);
  });
}

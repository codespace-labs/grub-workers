import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { inferGenres, linkGenres }      from "../_shared/genre-mapper.ts";
import { isExcludedEvent, EXCLUDED_SKIP_REASON } from "../_shared/event-filter.ts";
import {
  emptySyncResult,
  toEventRow,
  validatePrice,
  type UnifiedEvent,
  type SyncResult,
} from "../_shared/normalizer.ts";
import {
  resolveEventLocation,
  stripTrailingCityFromEventName,
} from "../_shared/location-normalization.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const BASE_URL        = "https://tik.pe";
const EVENTS_API_URL  = `${BASE_URL}/events/api/get_events`;
const SOURCE          = "tikpe" as const;
const SCRAPER_VERSION = "2026-03-19.2";
const MIN_DATE        = new Date("2026-01-01T00:00:00-05:00");

const CATEGORY_FILTERS = [
  "Electronica",
  "Conciertos",
  "Fiestas",
] as const;

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Types ────────────────────────────────────────────────────────────────────

interface TikPeTicket {
  price?: string | number | null;
  sale_price?: string | number | null;
}

interface TikPeEventPayload {
  id: number;
  title?: string | null;
  description?: string | null;
  excerpt?: string | null;
  venue?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  slug?: string | null;
  thumbnail?: string | null;
  poster?: string | null;
  images?: string | null;
  category_name?: string | null;
  tickets?: TikPeTicket[] | null;
  publish?: number | null;
  status?: number | null;
}

interface TikPeEventsEnvelope {
  data?: TikPeEventPayload[];
  current_page?: number;
  last_page?: number;
}

interface TikPeEventsResponse {
  events?: TikPeEventsEnvelope;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#039;/gi, "'")
    .replace(/&aacute;/gi, "a")
    .replace(/&eacute;/gi, "e")
    .replace(/&iacute;/gi, "i")
    .replace(/&oacute;/gi, "o")
    .replace(/&uacute;/gi, "u")
    .replace(/&ntilde;/gi, "n")
    .replace(/&Aacute;/gi, "A")
    .replace(/&Eacute;/gi, "E")
    .replace(/&Iacute;/gi, "I")
    .replace(/&Oacute;/gi, "O")
    .replace(/&Uacute;/gi, "U")
    .replace(/&Ntilde;/gi, "N")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

function toAbsoluteStorageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${BASE_URL}/storage/${trimmed.replace(/^\/+/, "")}`;
}

function extractImageFromImagesField(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const first = parsed.find((value) => typeof value === "string" && value.trim().length > 0);
      return typeof first === "string" ? toAbsoluteStorageUrl(first) : null;
    }
  } catch {
    // ignore malformed JSON and continue with null
  }
  return null;
}

function buildTicketUrl(slug: string): string {
  return `${BASE_URL}/events/${encodeURIComponent(slug)}`;
}

function toIsoDate(dateRaw: string | null | undefined, timeRaw: string | null | undefined): string | null {
  if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return null;
  const time = timeRaw && /^\d{2}:\d{2}:\d{2}$/.test(timeRaw) ? timeRaw : "00:00:00";
  return `${dateRaw}T${time}-05:00`;
}

function parseNumeric(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = value.replace(/,/g, ".").trim();
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractPriceMin(tickets: TikPeTicket[] | null | undefined): number | null {
  if (!tickets?.length) return null;
  const values = tickets
    .flatMap((ticket) => [parseNumeric(ticket.sale_price), parseNumeric(ticket.price)])
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);

  if (!values.length) return null;
  return validatePrice(Math.min(...values));
}

async function fetchListingPage(category: string, page: number): Promise<TikPeEventsEnvelope> {
  const params = new URLSearchParams({
    page: String(page),
    category,
    search: "",
    start_date: "",
    end_date: "",
    price: "",
    city: "All",
    state: "All",
    country: "All",
  });

  const res = await fetch(`${EVENTS_API_URL}?${params.toString()}`, {
    headers: {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} leyendo ${category} página ${page}`);
  }

  const json = await res.json() as TikPeEventsResponse;
  return json.events ?? {};
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated" | "failed";

async function upsertEvent(event: UnifiedEvent): Promise<UpsertOutcome> {
  const loc = resolveEventLocation({
    rawVenue: event.venue ?? null,
    rawName: event.name,
    explicitCity: event.city,
  });

  const row = toEventRow(
    {
      ...event,
      name: stripTrailingCityFromEventName(event.name, loc.city),
      venue: event.venue ?? null,
      city: loc.city,
      country_code: loc.country_code,
    },
    null,
  );

  try {
    const { data: existing, error: selErr } = await supabase
      .from("events")
      .select("id, price_min, venue_id, is_active")
      .eq("ticket_url", row.ticket_url)
      .maybeSingle();

    if (selErr) throw new Error(`SELECT: ${selErr.message}`);

    const isUpdate = existing !== null;
    const writeRow = isUpdate
      ? {
        ...row,
        price_min: row.price_min ?? existing.price_min,
        venue_id: row.venue_id ?? existing.venue_id,
        is_active: existing.is_active,
      }
      : row;

    const { data: upserted, error: upsertErr } = await supabase
      .from("events")
      .upsert(writeRow, { onConflict: "ticket_url" })
      .select("id")
      .single();

    if (upsertErr || !upserted) throw new Error(`UPSERT: ${upsertErr?.message}`);

    await linkGenres(supabase, upserted.id, event.genre_slugs);
    return isUpdate ? "updated" : "inserted";
  } catch (err) {
    console.error(`[sync-tikpe] upsert error ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<SyncResult> {
  const result = emptySyncResult();
  console.log(`[sync-tikpe] version=${SCRAPER_VERSION}`);

  const allEvents: TikPeEventPayload[] = [];
  const seen = new Set<string>();
  let pagesFetched = 0;

  for (const category of CATEGORY_FILTERS) {
    const firstPage = await fetchListingPage(category, 1);
    const lastPage = Math.max(1, firstPage.last_page ?? 1);
    const pageOneEvents = firstPage.data ?? [];
    pagesFetched += 1;

    console.log(`[sync-tikpe] ${category}: página 1 con ${pageOneEvents.length} eventos, lastPage=${lastPage}`);

    for (const item of pageOneEvents) {
      const key = item.slug?.trim() || String(item.id);
      if (!seen.has(key)) {
        seen.add(key);
        allEvents.push(item);
      }
    }

    for (let page = 2; page <= lastPage; page++) {
      const nextPage = await fetchListingPage(category, page);
      const pageEvents = nextPage.data ?? [];
      pagesFetched += 1;
      console.log(`[sync-tikpe] ${category}: página ${page} con ${pageEvents.length} eventos`);

      for (const item of pageEvents) {
        const key = item.slug?.trim() || String(item.id);
        if (!seen.has(key)) {
          seen.add(key);
          allEvents.push(item);
        }
      }
    }
  }

  result.diagnostics = {
    discovered: allEvents.length,
    parsed: allEvents.length,
    detail_fetched: 0,
    skipped_reasons: {},
    pages_fetched: pagesFetched,
  };

  const markSkipped = (reason: string) => {
    result.skipped += 1;
    const bucket = result.diagnostics?.skipped_reasons ?? {};
    bucket[reason] = (bucket[reason] ?? 0) + 1;
    if (result.diagnostics) result.diagnostics.skipped_reasons = bucket;
  };

  for (const item of allEvents) {
    const slug = item.slug?.trim();
    const name = item.title?.trim();
    const date = toIsoDate(item.start_date, item.start_time);

    if (!slug || !name) {
      markSkipped("missing_identity");
      continue;
    }

    if (isExcludedEvent(name, item.venue ?? null)) {
      markSkipped(EXCLUDED_SKIP_REASON);
      continue;
    }

    if (!date || new Date(date) < MIN_DATE) {
      markSkipped(!date ? "invalid_date" : "before_min_date");
      continue;
    }

    const cover_url =
      toAbsoluteStorageUrl(item.poster) ??
      toAbsoluteStorageUrl(item.thumbnail) ??
      extractImageFromImagesField(item.images);

    const description = stripHtml(item.description) ?? stripHtml(item.excerpt);
    const city = item.city?.trim() || item.state?.trim() || "Lima";
    const genre_slugs = inferGenres(
      `${name} ${description ?? ""}`.trim(),
      item.category_name ?? "",
    );

    const event: UnifiedEvent = {
      source: SOURCE,
      ticket_url: buildTicketUrl(slug),
      external_slug: slug,
      name,
      date,
      start_time: item.start_time ?? null,
      venue: item.venue?.trim() || null,
      city,
      country_code: "PE",
      cover_url,
      price_min: extractPriceMin(item.tickets),
      price_max: null,
      lineup: [],
      description,
      genre_slugs,
      is_active: (item.publish ?? 1) === 1 && (item.status ?? 1) === 1,
      scraper_version: SCRAPER_VERSION,
    };

    const outcome = await upsertEvent(event);
    if (outcome === "failed") result.failed += 1;
    else result[outcome] += 1;
  }

  console.log(
    `[sync-tikpe] done — inserted:${result.inserted} updated:${result.updated} failed:${result.failed} skipped:${result.skipped}`,
  );
  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await run();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sync-tikpe]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// DEPLOY: supabase functions deploy sync-tikpe --no-verify-jwt
// FUENTE: endpoint JSON público de tik.pe (más estable que el listing SPA)

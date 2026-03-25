import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrapeHtml }                   from "../_shared/firecrawl.ts";
import { inferGenres, linkGenres }      from "../_shared/genre-mapper.ts";
import {
  emptySyncResult,
  toEventRow,
  parseShortDate,
  validatePrice,
  type UnifiedEvent,
  type SyncResult,
} from "../_shared/normalizer.ts";
import { upsertVenue }            from "../_shared/venue-upsert.ts";
import {
  resolveEventLocation,
  stripTrailingCityFromEventName,
} from "../_shared/location-normalization.ts";
import {
  buildSkippedNoChangeResult,
  shouldSkipRecentNoChangeRun,
} from "../_shared/sync-guard.ts";
import { isExcludedEvent, EXCLUDED_SKIP_REASON } from "../_shared/event-filter.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const LISTING_URLS    = [
  "https://www.vastiontickets.com/",
];
const SOURCE          = "vastion" as const;
const SCRAPER_VERSION = "2026-03-19.1";
const MIN_DATE        = new Date("2026-01-01T00:00:00-05:00");
const NO_CHANGE_COOLDOWN_MINUTES = 30;

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListingEvent {
  name:       string;
  venue_raw:  string | null;
  date_raw:   string;      // "04 ABR"
  cover_url:  string | null;
  ticket_url: string;
  slug:       string;
  price_min:  number | null;
  event_type: string;      // "Evento" | "Festival"
}

// ─── Listing parser ───────────────────────────────────────────────────────────

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripTags(value: string): string {
  return decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function absolutizeTicketUrl(href: string): string | null {
  if (href.startsWith("https://www.vastiontickets.com/evento/")) return href;
  if (href.startsWith("/evento/")) return `https://www.vastiontickets.com${href}`;
  return null;
}

function extractSlug(href: string): string | null {
  const absolute = absolutizeTicketUrl(href);
  if (!absolute) return null;
  return absolute.split("/evento/")[1] ?? null;
}

function parseListingHtml(html: string): ListingEvent[] {
  const chunks = html.split(/(?=<a[^>]+href="(?:https:\/\/www\.vastiontickets\.com)?\/evento\/)/i);
  const events: ListingEvent[] = [];
  const seen   = new Set<string>();

  for (const chunk of chunks) {
    const hrefM = chunk.match(/href="((?:https:\/\/www\.vastiontickets\.com)?\/evento\/[^"]+)"/i);
    if (!hrefM) continue;

    const ticket_url = absolutizeTicketUrl(hrefM[1]);
    const slug = extractSlug(hrefM[1]);
    if (!ticket_url || !slug) continue;
    if (seen.has(ticket_url)) continue;
    seen.add(ticket_url);

    const nameM = chunk.match(/class="event-title"[^>]*>([\s\S]*?)<\/h3>/i);
    const name = nameM ? stripTags(nameM[1]) : null;
    if (!name) continue;

    const dateM = chunk.match(/class="event-date-col"[^>]*>([\s\S]*?)<\/span>/i);
    if (!dateM) continue;
    const date_raw = stripTags(dateM[1]).toUpperCase();

    const venueM = chunk.match(/class="event-loc-col"[^>]*>([\s\S]*?)<\/span>/i);
    const venue = venueM ? stripTags(venueM[1]) : null;

    const priceM = chunk.match(/class="event-price"[^>]*>[\s\S]*?S\/\s*(\d+(?:[.,]\d{1,2})?)/i);
    const price  = priceM ? parseFloat(priceM[1].replace(",", ".")) : null;

    const imgM = chunk.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
    const badgeM = chunk.match(/class="event-badge"[^>]*>([\s\S]*?)<\/div>/i);

    events.push({
      name,
      venue_raw:  venue,
      date_raw,
      cover_url:  imgM?.[1] ?? null,
      ticket_url,
      slug,
      price_min:  price,
      event_type: badgeM ? stripTags(badgeM[1]) : "Evento",
    });
  }

  return events;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated" | "failed";

async function upsertEvent(event: UnifiedEvent): Promise<UpsertOutcome> {
  const loc = resolveEventLocation({ rawVenue: event.venue ?? null, rawName: event.name });

  const venue_id = loc.venue
    ? await upsertVenue(supabase, { name: loc.venue, city: loc.city, country_code: loc.country_code })
    : null;

  const row = toEventRow(
    { ...event, name: stripTrailingCityFromEventName(event.name, loc.city), venue: loc.venue, city: loc.city, country_code: loc.country_code },
    venue_id,
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
    console.error(`[sync-vastion] upsert error ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(options: { forceRefresh?: boolean } = {}): Promise<SyncResult> {
  const guard = await shouldSkipRecentNoChangeRun(supabase, {
    source: SOURCE,
    cooldownMinutes: NO_CHANGE_COOLDOWN_MINUTES,
    forceRefresh: options.forceRefresh,
  });
  if (guard.skip) {
    console.log(`[sync-vastion] skip sin cambios recientes (${guard.cooldownMinutes} min)`);
    return buildSkippedNoChangeResult(SOURCE, guard);
  }

  const result = emptySyncResult();
  console.log(`[sync-vastion] version=${SCRAPER_VERSION}`);

  const seenListings = new Set<string>();
  const listings: ListingEvent[] = [];

  for (const url of LISTING_URLS) {
    try {
      const { html, statusCode } = await scrapeHtml(url, {
        waitFor: 3500,
        actions: [
          { type: "scroll", direction: "down", amount: 1200 },
          { type: "wait", milliseconds: 800 },
          { type: "scroll", direction: "down", amount: 1200 },
          { type: "wait", milliseconds: 800 },
          { type: "scroll", direction: "down", amount: 1200 },
          { type: "wait", milliseconds: 800 },
        ],
      });
      if (statusCode >= 400) {
        console.warn(`[sync-vastion] ${url}: HTTP ${statusCode}`);
        continue;
      }

      const parsed = parseListingHtml(html);
      console.log(`[sync-vastion] ${url}: ${parsed.length} eventos parseados`);

      for (const listing of parsed) {
        if (seenListings.has(listing.ticket_url)) continue;
        seenListings.add(listing.ticket_url);
        listings.push(listing);
      }
    } catch (error) {
      console.error(`[sync-vastion] fallo leyendo ${url}:`, error);
    }
  }

  console.log(`[sync-vastion] ${listings.length} eventos únicos tras merge de listings`);
  result.diagnostics = {
    discovered: listings.length,
    parsed: listings.length,
    detail_fetched: 0,
    skipped_reasons: {},
  };

  const markSkipped = (reason: string) => {
    result.skipped += 1;
    const bucket = result.diagnostics?.skipped_reasons ?? {};
    bucket[reason] = (bucket[reason] ?? 0) + 1;
    if (result.diagnostics) result.diagnostics.skipped_reasons = bucket;
  };

  for (const listing of listings) {
    const date = parseShortDate(listing.date_raw);
    const genre_slugs = inferGenres(listing.name, listing.venue_raw ?? "");

    if (!date || new Date(date) < MIN_DATE) {
      markSkipped(!date ? "invalid_date" : "before_min_date");
      continue;
    }

    if (isExcludedEvent(listing.name, listing.venue_raw)) {
      markSkipped(EXCLUDED_SKIP_REASON);
      continue;
    }

    const event: UnifiedEvent = {
      source:          SOURCE,
      ticket_url:      listing.ticket_url,
      external_slug:   listing.slug,
      name:            listing.name,
      date,
      start_time:      null,
      venue:           listing.venue_raw,
      city:            "Lima",         // Vastion opera en Lima
      country_code:    "PE",
      cover_url:       listing.cover_url,
      price_min:       validatePrice(listing.price_min),
      price_max:       null,
      lineup:          [],
      description:     null,
      // Vastion = electrónica/festivales → inferGenres complementa con keywords del nombre
      genre_slugs,
      is_active:       true,
      scraper_version: SCRAPER_VERSION,
    };

    const outcome = await upsertEvent(event);
    if (outcome === "failed") result.failed += 1;
    else result[outcome] += 1;
  }

  console.log(`[sync-vastion] done — inserted:${result.inserted} updated:${result.updated} failed:${result.failed} skipped:${result.skipped}`);
  console.log(`[sync-vastion] créditos usados: 1 (listing completo, precio+venue incluidos)`);
  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }
  try {
    const body = await req.json().catch(() => ({})) as { force_refresh?: boolean };
    const result = await run({ forceRefresh: body.force_refresh === true });
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[sync-vastion]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

// DEPLOY: supabase functions deploy sync-vastion --no-verify-jwt
// SECRETS: FIRECRAWL_API_KEY
// CRÉDITOS: 1 por run (listing completo incluye precio y venue)
// NOTA: Vastion tiene pocos eventos (~3-5). Si en el futuro crecen,
//       revisar si hay paginación en vastiontickets.com/eventos

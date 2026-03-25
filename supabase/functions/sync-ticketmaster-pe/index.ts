import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrapeHtml, scrapeMarkdown }   from "../_shared/firecrawl.ts";
import { inferGenres, linkGenres }      from "../_shared/genre-mapper.ts";
import {
  emptySyncResult,
  toEventRow,
  parseTicketmasterPeDateTime,
  validatePrice,
  extractMinPriceFromMarkdown,
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

const LISTING_URL     = "https://www.ticketmaster.pe/page/categoria-conciertos";
const SOURCE          = "ticketmaster" as const;
const SCRAPER_VERSION = "2026-03-19.2";
const NO_CHANGE_COOLDOWN_MINUTES = 30;

// Detalle solo para precio (fecha y hora ya vienen del listing)
const DETAIL_BATCH_LIMIT = 0;
const DETAIL_THROTTLE_MS = 800;
const MIN_DATE           = new Date("2026-01-01T00:00:00-05:00");

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListingEvent {
  name:       string;
  venue_raw:  string | null;
  date_raw:   string;           // "Miercoles 20 de Mayo - 8:30 pm"
  cover_url:  string | null;
  ticket_url: string;
  slug:       string;
}

// ─── Listing parser ───────────────────────────────────────────────────────────

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&Aacute;/g, "Á")
    .replace(/&Eacute;/g, "É")
    .replace(/&Iacute;/g, "Í")
    .replace(/&Oacute;/g, "Ó")
    .replace(/&Uacute;/g, "Ú")
    .replace(/&uuml;/g, "ü")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&deg;/g, "°")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return Number.isFinite(num) ? String.fromCharCode(num) : "";
    });
}

function normalizeWhitespace(value: string): string {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseListingHtml(html: string): { events: ListingEvent[]; cardCount: number } {
  const anchorRe = /<a\s+href=['"]\.\.\/event\/([^'"]+)['"][\s\S]*?<img[^>]+src=['"]([^'"]+)['"][^>]*alt=['"]([^'"]*)['"][\s\S]*?<strong>([^<]+)<\/strong>\s*<span>([^<]+)<\/span>[\s\S]*?<\/a>/gi;
  const seen = new Set<string>();
  const events: ListingEvent[] = [];
  let cardCount = 0;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) !== null) {
    cardCount += 1;
    const slug = match[1].trim();
    const ticket_url = new URL(`../event/${slug}`, LISTING_URL).toString();
    if (seen.has(ticket_url)) continue;
    seen.add(ticket_url);

    const name = normalizeWhitespace(match[3]);
    const venue_raw = normalizeWhitespace(match[4]) || null;
    const date_raw = normalizeWhitespace(match[5]);
    const cover_url = match[2].trim() || null;

    if (!name || !date_raw) continue;

    events.push({
      name,
      venue_raw,
      date_raw,
      cover_url,
      ticket_url,
      slug,
    });
  }

  return { events, cardCount };
}

// ─── Detail page ──────────────────────────────────────────────────────────────

async function fetchPriceFromDetail(ticketUrl: string): Promise<number | null> {
  try {
    const { markdown } = await scrapeMarkdown(ticketUrl, { waitFor: 1500 }, 2);
    return extractMinPriceFromMarkdown(markdown);
  } catch {
    return null;
  }
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
      .select("id, price_min, start_time, venue_id, is_active")
      .eq("ticket_url", row.ticket_url)
      .maybeSingle();

    if (selErr) throw new Error(`SELECT: ${selErr.message}`);

    const isUpdate = existing !== null;
    const writeRow = isUpdate
      ? {
          ...row,
          price_min: row.price_min ?? existing.price_min,
          start_time: row.start_time ?? existing.start_time,
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
    console.error(`[sync-ticketmaster-pe] upsert error ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(detailLimit = DETAIL_BATCH_LIMIT, options: { forceRefresh?: boolean } = {}): Promise<SyncResult> {
  const guard = await shouldSkipRecentNoChangeRun(supabase, {
    source: SOURCE,
    cooldownMinutes: NO_CHANGE_COOLDOWN_MINUTES,
    forceRefresh: options.forceRefresh,
  });
  if (guard.skip) {
    console.log(`[sync-ticketmaster-pe] skip sin cambios recientes (${guard.cooldownMinutes} min)`);
    return buildSkippedNoChangeResult(SOURCE, guard);
  }

  const result = emptySyncResult();
  console.log(`[sync-ticketmaster-pe] version=${SCRAPER_VERSION}`);

  const { html } = await scrapeHtml(LISTING_URL, { waitFor: 2000 });
  const { events: listings, cardCount } = parseListingHtml(html);

  const todayLima = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
  todayLima.setHours(0, 0, 0, 0);

  const skippedReasons: Record<string, number> = {};
  const countSkip = (reason: string) => {
    result.skipped += 1;
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  };

  // Filtrar solo por fecha válida y mínima; el filtro editorial vive después.
  const valid = listings.filter((e) => {
    const { date } = parseTicketmasterPeDateTime(e.date_raw);
    if (!date) {
      countSkip("invalid_date");
      return false;
    }

    if (new Date(date) < MIN_DATE) {
      countSkip("before_min_date");
      return false;
    }

    return true;
  });

  const futureListings = valid.filter((e) => {
    const { date } = parseTicketmasterPeDateTime(e.date_raw);
    return date ? new Date(date) >= todayLima : false;
  });

  result.diagnostics = {
    discovered: listings.length,
    parsed: valid.length,
    detail_fetched: Math.min(futureListings.length, detailLimit),
    raw_cards: cardCount,
    future_listings: futureListings.length,
    skipped_reasons: skippedReasons,
  };

  console.log(
    `[sync-ticketmaster-pe] ${listings.length} descubiertos (${cardCount} cards crudas)` +
    ` → ${valid.length} válidos (${futureListings.length} futuros)`,
  );

  // Detalle solo futuros (solo precio — fecha y hora ya están en listing)
  const toEnrich = futureListings.slice(0, detailLimit);
  const priceMap = new Map<string, number | null>();

  for (const e of toEnrich) {
    priceMap.set(e.ticket_url, await fetchPriceFromDetail(e.ticket_url));
    await sleep(DETAIL_THROTTLE_MS);
  }

  for (const listing of valid) {
    const { date, start_time } = parseTicketmasterPeDateTime(listing.date_raw);
    if (!date) {
      countSkip("invalid_date");
      continue;
    }

    if (isExcludedEvent(listing.name, listing.venue_raw)) {
      countSkip(EXCLUDED_SKIP_REASON);
      continue;
    }

    const event: UnifiedEvent = {
      source:          SOURCE,
      ticket_url:      listing.ticket_url,
      external_slug:   listing.slug,
      name:            listing.name,
      date,
      start_time,
      venue:           listing.venue_raw,
      city:            "Lima",
      country_code:    "PE",
      cover_url:       listing.cover_url,
      price_min:       validatePrice(priceMap.get(listing.ticket_url) ?? null),
      price_max:       null,
      lineup:          [],
      description:     null,
      genre_slugs:     inferGenres(listing.name, listing.venue_raw ?? ""),
      is_active:       true,
      scraper_version: SCRAPER_VERSION,
    };

    const outcome = await upsertEvent(event);
    if (outcome === "failed") result.failed += 1;
    else result[outcome] += 1;
  }

  console.log(`[sync-ticketmaster-pe] done — inserted:${result.inserted} updated:${result.updated} failed:${result.failed} skipped:${result.skipped}`);
  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }
  try {
    const body        = await req.json().catch(() => ({}));
    const detailLimit = typeof body.detailLimit === "number" ? body.detailLimit : DETAIL_BATCH_LIMIT;
    const result      = await run(detailLimit, { forceRefresh: body.force_refresh === true });
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[sync-ticketmaster-pe]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

// DEPLOY: supabase functions deploy sync-ticketmaster-pe --no-verify-jwt
// SECRETS: FIRECRAWL_API_KEY (SUPABASE_URL y SERVICE_ROLE_KEY son automáticas)
// CRÉDITOS: 1 listing + hasta detailLimit detail pages por run

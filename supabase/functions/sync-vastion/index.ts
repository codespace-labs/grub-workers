import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrapeMarkdown }               from "../_shared/firecrawl.ts";
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

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const LISTING_URL     = "https://www.vastiontickets.com/";
const SOURCE          = "vastion" as const;
const SCRAPER_VERSION = "2026-03-19.1";
const MIN_DATE        = new Date("2026-01-01T00:00:00-05:00");

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
//
// Estructura del markdown de vastiontickets.com (post-normalización):
//
//   [![NAME](IMAGE_URL) Evento/Festival **NAME** DD ABR • VENUE Desde S/ PRICE](URL)
//
// Todos los eventos de Vastion son de música electrónica / festivales.
// Listing ya incluye venue y precio → NO se necesitan páginas de detalle.

function normalizeBreaks(md: string): string {
  return md
    .replace(/\\\\\n/g, " ")
    .replace(/\\\s+/g, " ")
    .replace(/\s{2,}/g, " ");
}

function parseListingMarkdown(markdown: string): ListingEvent[] {
  const clean  = normalizeBreaks(markdown);
  // Cada evento empieza con [![
  const chunks = clean.split(/(?=\[!\[)/);
  const events: ListingEvent[] = [];
  const seen   = new Set<string>();

  for (const chunk of chunks) {
    // Solo tarjetas de evento de Vastion (imagen de evento)
    if (!chunk.includes("vastiontickets.com/evento/") && !chunk.includes("duapass.com/images/eventos/")) continue;

    // cover + name alt
    const imgM = chunk.match(/\[!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/);
    if (!imgM) continue;

    // ticket_url + slug
    const urlM = chunk.match(/\]\((https:\/\/www\.vastiontickets\.com\/evento\/([^)]+))\)\s*$/);
    if (!urlM) continue;

    const ticket_url = urlM[1];
    if (seen.has(ticket_url)) continue;
    seen.add(ticket_url);

    // tipo: "Evento" o "Festival"
    const typeM = chunk.match(/\b(Evento|Festival)\b/);

    // nombre en bold (más confiable que alt text)
    const boldM = chunk.match(/\*\*([^*]+)\*\*/);
    const name  = boldM?.[1]?.trim() ?? imgM[1].trim();
    if (!name) continue;

    // fecha: "04 ABR", "18 ABR", "02 MAY"
    const dateM = chunk.match(/\b(\d{1,2}\s+[A-Z]{3})\b/);
    if (!dateM) continue;

    // venue: texto entre "•" y "Desde"
    const venueM = chunk.match(/•\s+([^D]+?)\s+Desde/);
    const venue  = venueM?.[1]?.trim() ?? null;

    // precio: "Desde S/ 70"
    const priceM = chunk.match(/[Dd]esde\s+S\/\s*(\d+(?:[.,]\d{1,2})?)/);
    const price  = priceM ? parseFloat(priceM[1].replace(",", ".")) : null;

    events.push({
      name,
      venue_raw:  venue,
      date_raw:   dateM[1],
      cover_url:  imgM[2],
      ticket_url,
      slug:       urlM[2],
      price_min:  price,
      event_type: typeM?.[1] ?? "Evento",
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
      .select("id, price_min, venue_id")
      .eq("ticket_url", row.ticket_url)
      .maybeSingle();

    if (selErr) throw new Error(`SELECT: ${selErr.message}`);

    const isUpdate = existing !== null;
    const writeRow = isUpdate
      ? { ...row, price_min: row.price_min ?? existing.price_min, venue_id: row.venue_id ?? existing.venue_id }
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

async function run(): Promise<SyncResult> {
  const result = emptySyncResult();
  console.log(`[sync-vastion] version=${SCRAPER_VERSION}`);

  // Vastion tiene login modal → waitFor alto para asegurar que cargue el listing
  const { markdown } = await scrapeMarkdown(LISTING_URL, { waitFor: 2500 });
  const listings     = parseListingMarkdown(markdown);

  console.log(`[sync-vastion] ${listings.length} eventos parseados`);

  for (const listing of listings) {
    const date = parseShortDate(listing.date_raw);

    if (!date || new Date(date) < MIN_DATE) {
      result.skipped += 1;
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
      genre_slugs:     inferGenres(listing.name, listing.venue_raw ?? ""),
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
    const result = await run();
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

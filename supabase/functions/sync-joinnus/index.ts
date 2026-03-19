import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrapeMarkdown }               from "../_shared/firecrawl.ts";
import { inferGenres, linkGenres }      from "../_shared/genre-mapper.ts";
import { isMusicalEvent }               from "../_shared/music-filter.ts";
import {
  emptySyncResult,
  toEventRow,
  parseShortDate,
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

const LISTING_URL     = "https://www.joinnus.com/descubrir/concerts";
const SOURCE          = "joinnus" as const;
const SCRAPER_VERSION = "2026-03-19.1";
const MIN_DATE        = new Date("2026-01-01T00:00:00-05:00");

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListingEvent {
  name:       string;
  city:       string;
  date_raw:   string;     // "20MAR"
  cover_url:  string | null;
  ticket_url: string;
  slug:       string;
  price_min:  number | null;
}

// ─── Listing parser ───────────────────────────────────────────────────────────
//
// Estructura del markdown de joinnus.com/descubrir/concerts:
//
//   [Ver detalle del evento](https://www.joinnus.com/events/concerts/lima-SLUG-ID)
//
//   ![NAME](https://cdn.joinnus.com/...)
//
//   20MAR
//
//   Lima
//
//   NAME
//
//   DesdeS/ 30.00
//
// Nota: algunos eventos premium usan prime.joinnus.com/landing/SLUG
// Precio ya disponible en listing → NO se necesitan páginas de detalle para precio.
// Venue no está en listing → se upsertea sin venue (enrich-artists lo puede completar).

function parseListingMarkdown(markdown: string): ListingEvent[] {
  const events: ListingEvent[] = [];
  const seen   = new Set<string>();

  // Dividir por separador de evento
  const blocks = markdown.split("[Ver detalle del evento]");

  for (const block of blocks.slice(1)) {
    // URL del evento
    const urlM = block.match(/^\(([^)]+)\)/);
    if (!urlM) continue;

    const ticket_url = urlM[1].trim();
    if (seen.has(ticket_url)) continue;
    seen.add(ticket_url);

    // Slug: última parte de la URL
    // joinnus.com/events/concerts/lima-SLUG-12345 → SLUG-12345
    // prime.joinnus.com/landing/SLUG               → SLUG
    const slugM = ticket_url.match(/\/([^/]+)$/);
    const slug  = slugM?.[1] ?? ticket_url;

    // cover + name (alt text)
    const imgM = block.match(/!\[([^\]]*)\]\((https:\/\/cdn\.joinnus\.com\/[^)]+|https:\/\/imagenes\.joinnus\.com\/[^)]+)\)/);
    const name = imgM?.[1]?.trim();
    if (!name) continue;

    // Fecha: "20MAR", "28JUN"
    const dateM = block.match(/\n\n(\d{1,2}[A-Z]{3})\n/);
    const date_raw = dateM?.[1] ?? "";
    if (!date_raw) continue;

    // Ciudad: línea después de la fecha
    const cityM = block.match(/\n\n\d{1,2}[A-Z]{3}\n\n([^\n]+)\n/);
    const city  = cityM?.[1]?.trim() ?? "Lima";

    // Precio: "DesdeS/ 30.00" o "Desde S/ 30.00"
    const priceM = block.match(/[Dd]esde\s*S\/\s*(\d+(?:[.,]\d{1,2})?)/);
    const rawPrice = priceM ? parseFloat(priceM[1].replace(",", ".")) : null;
    // Joinnus muestra el precio real del sitio → aceptar cualquier valor > 0
    const price_min = rawPrice && rawPrice > 0 ? rawPrice : null;

    if (!isMusicalEvent(name)) continue;

    events.push({ name, city, date_raw, cover_url: imgM?.[2] ?? null, ticket_url, slug, price_min });
  }

  return events;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated" | "failed";

async function upsertEvent(event: UnifiedEvent): Promise<UpsertOutcome> {
  const loc = resolveEventLocation({ rawVenue: null, rawName: event.name, explicitCity: event.city });

  const row = toEventRow(
    { ...event, name: stripTrailingCityFromEventName(event.name, loc.city), venue: null, city: loc.city, country_code: loc.country_code },
    null,
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
    console.error(`[sync-joinnus] upsert error ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<SyncResult> {
  const result = emptySyncResult();
  console.log(`[sync-joinnus] version=${SCRAPER_VERSION}`);

  // Joinnus es una SPA React → waitFor alto para garantizar render completo
  const { markdown } = await scrapeMarkdown(LISTING_URL, { waitFor: 3000 });
  const listings     = parseListingMarkdown(markdown);

  const todayLima = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
  todayLima.setHours(0, 0, 0, 0);

  console.log(`[sync-joinnus] ${listings.length} eventos parseados del listing`);

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
      start_time:      null,   // no disponible en listing; enrich-artists puede completar
      venue:           null,   // no disponible en listing
      city:            listing.city,
      country_code:    "PE",
      cover_url:       listing.cover_url,
      price_min:       listing.price_min,
      price_max:       null,
      lineup:          [],
      description:     null,
      genre_slugs:     inferGenres(listing.name),
      is_active:       true,
      scraper_version: SCRAPER_VERSION,
    };

    const outcome = await upsertEvent(event);
    if (outcome === "failed") result.failed += 1;
    else result[outcome] += 1;
  }

  console.log(`[sync-joinnus] done — inserted:${result.inserted} updated:${result.updated} failed:${result.failed} skipped:${result.skipped}`);
  console.log(`[sync-joinnus] créditos usados: 1 (solo listing, precio ya incluido)`);
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
    console.error("[sync-joinnus]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

// DEPLOY: supabase functions deploy sync-joinnus --no-verify-jwt
// SECRETS: FIRECRAWL_API_KEY
// CRÉDITOS: 1 por run (listing incluye precio, no se necesitan detail pages)
// NOTA: Joinnus no expone venue en el listing. Si se necesita, añadir detailLimit
//       igual que teleticket para enriquecer en batches.

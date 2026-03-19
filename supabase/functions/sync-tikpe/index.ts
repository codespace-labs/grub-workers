import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrapeMarkdown }               from "../_shared/firecrawl.ts";
import { inferGenres, linkGenres }      from "../_shared/genre-mapper.ts";
import {
  emptySyncResult,
  toEventRow,
  parseTikPeDate,
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

const BASE_URL        = "https://tik.pe/events";
const SOURCE          = "tikpe" as const;
const SCRAPER_VERSION = "2026-03-19.1";
const MIN_DATE        = new Date("2026-01-01T00:00:00-05:00");

// Categorías permitidas (en minúsculas, sin tildes)
const ALLOWED_CATEGORIES = new Set(["electronica", "conciertos"]);

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListingEvent {
  name:       string;        // puede estar truncado ("Nombre del evento")
  date_raw:   string;        // "25 mar. 2023"
  category:   string;        // "Electronica" | "Conciertos"
  city:       string;
  price_min:  number | null; // en PEN (= S/)
  ticket_url: string;
  slug:       string;
}

// ─── Listing parser ───────────────────────────────────────────────────────────
//
// Estructura del markdown de tik.pe/events?page=N:
//
//   25 mar. 2023
//
//   ##### [BBR & House Nation Pres. Alish...](https://tik.pe/events/bbr-house-nation-pres-alisha-uk)
//
//   Electronica
//
//   Lima
//
//   40.00 PEN
//   / GENERAL
//
// Múltiples eventos pueden compartir la misma línea de fecha.
// Los nombres vienen truncados con "..." — se almacenan limpios.
// Venue NO está en listing. Cover NO está en listing.
// Precio en PEN = S/. Se aplica validatePrice (umbral S/ 30).
// Categorías a incluir: Electronica, Conciertos. Se descartan Fiestas, etc.

function parseMaxPage(markdown: string): number {
  // Busca ?page=N en links de paginación
  const matches = [...markdown.matchAll(/[?&]page=(\d+)/g)];
  if (!matches.length) return 1;
  return Math.max(...matches.map((m) => parseInt(m[1], 10)));
}

function normalizeCategory(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function parseListingMarkdown(markdown: string): ListingEvent[] {
  const events: ListingEvent[] = [];
  const seen   = new Set<string>();

  // 1. Localizar todos los marcadores de fecha y su posición en el string
  //    Formato: "25 mar. 2023" o "4 abr. 2026"
  const DATE_RE = /\b(\d{1,2}\s+[a-z]+\.?\s+\d{4})\b/gi;
  const dateMarkers: Array<{ pos: number; raw: string }> = [];
  let dm: RegExpExecArray | null;
  while ((dm = DATE_RE.exec(markdown)) !== null) {
    dateMarkers.push({ pos: dm.index, raw: dm[1] });
  }

  // 2. Localizar cada bloque de evento por su heading Markdown (##### [...](URL))
  //    La línea siguiente es la categoría, luego la ciudad, luego el precio.
  const EVENT_RE =
    /#{1,6}\s+\[([^\]]+)\]\((https:\/\/tik\.pe\/events\/([^\s)]+))\)\s*\n+\s*([^\n]+)\s*\n+\s*([^\n]+)\s*\n+\s*([\d.]+)\s+PEN/g;
  let em: RegExpExecArray | null;

  while ((em = EVENT_RE.exec(markdown)) !== null) {
    const [, name_raw, ticket_url, slug, category_raw, city_raw, price_raw] = em;

    if (seen.has(ticket_url)) continue;
    seen.add(ticket_url);

    // Filtrar categorías no musicales
    const catNorm = normalizeCategory(category_raw);
    if (!ALLOWED_CATEGORIES.has(catNorm)) continue;

    // Fecha más cercana que aparece ANTES de este heading
    const pos = em.index;
    const nearestDate = [...dateMarkers].reverse().find((d) => d.pos < pos);
    if (!nearestDate) continue;

    // Nombre: limpiar truncamiento ("Nombre del eve..." → "Nombre del eve")
    const name = name_raw.trim().replace(/\.{3}$/, "").trim();
    if (!name) continue;

    const price = parseFloat(price_raw);

    events.push({
      name,
      date_raw:  nearestDate.raw,
      category:  category_raw.trim(),
      city:      city_raw.trim(),
      price_min: Number.isFinite(price) ? price : null,
      ticket_url,
      slug,
    });
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
    console.error(`[sync-tikpe] upsert error ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Página máxima a probar si la paginación no es detectable en el markdown.
// tik.pe tenía ~8 páginas en Mar-2026; 20 es un techo seguro sin desperdiciar créditos.
const MAX_PAGE_PROBE = 20;

async function run(): Promise<SyncResult> {
  const result = emptySyncResult();
  console.log(`[sync-tikpe] version=${SCRAPER_VERSION}`);

  // Paso 1: scrape página 1 — intenta detectar maxPage de los links de paginación.
  // tik.pe usa paginación JS-only → parseMaxPage devuelve 1 si no hay links en el markdown.
  const { markdown: page1Md } = await scrapeMarkdown(BASE_URL, { waitFor: 2500 });
  const detectedMax = parseMaxPage(page1Md);
  const maxPage     = detectedMax > 1 ? detectedMax : MAX_PAGE_PROBE;
  console.log(`[sync-tikpe] maxPage detectado=${detectedMax}, usando=${maxPage}`);

  let creditsUsed = 1;
  let allListings: ListingEvent[] = [];
  const page1Events = parseListingMarkdown(page1Md);

  // Paso 2: scrape desde la última página hacia la primera.
  // - Si la página retorna 0 eventos → hemos superado el máximo real → parar.
  // - Si todos los eventos son anteriores a MIN_DATE → parar (resto es más antiguo aún).
  for (let page = maxPage; page >= 2; page--) {
    const url = `${BASE_URL}?page=${page}`;
    const { markdown } = await scrapeMarkdown(url, { waitFor: 2500 });
    creditsUsed += 1;

    const pageEvents = parseListingMarkdown(markdown);
    console.log(`[sync-tikpe] página ${page}: ${pageEvents.length} eventos parseados`);

    // Página vacía → superamos el máximo real
    if (pageEvents.length === 0) {
      console.log(`[sync-tikpe] página ${page} vacía → max real encontrado`);
      continue; // sigue hacia páginas menores
    }

    allListings = allListings.concat(pageEvents);

    const allBeforeMinDate = pageEvents.every((e) => {
      const d = parseTikPeDate(e.date_raw);
      return !d || new Date(d) < MIN_DATE;
    });

    if (allBeforeMinDate) {
      console.log(`[sync-tikpe] página ${page} toda antes de MIN_DATE → deteniendo paginación`);
      break;
    }
  }

  allListings = allListings.concat(page1Events);

  // Deduplicar por ticket_url (por si las páginas extremas se solapan)
  const seen = new Set<string>();
  const listings = allListings.filter((e) => {
    if (seen.has(e.ticket_url)) return false;
    seen.add(e.ticket_url);
    return true;
  });

  console.log(`[sync-tikpe] ${listings.length} eventos únicos tras paginación`);

  for (const listing of listings) {
    const date = parseTikPeDate(listing.date_raw);

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
      start_time:      null,   // no disponible en listing
      venue:           null,   // no disponible en listing
      city:            listing.city || "Lima",
      country_code:    "PE",
      cover_url:       null,   // no disponible en listing
      price_min:       validatePrice(listing.price_min),
      price_max:       null,
      lineup:          [],
      description:     null,
      genre_slugs:     inferGenres(listing.name, listing.category),
      is_active:       true,
      scraper_version: SCRAPER_VERSION,
    };

    const outcome = await upsertEvent(event);
    if (outcome === "failed") result.failed += 1;
    else result[outcome] += 1;
  }

  console.log(`[sync-tikpe] done — inserted:${result.inserted} updated:${result.updated} failed:${result.failed} skipped:${result.skipped}`);
  console.log(`[sync-tikpe] créditos usados: ${creditsUsed} (${maxPage} páginas)`);
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
    console.error("[sync-tikpe]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

// DEPLOY: supabase functions deploy sync-tikpe --no-verify-jwt
// SECRETS: FIRECRAWL_API_KEY
// CRÉDITOS: hasta maxPage por run (1 por página scrapeada)
//           En la práctica: pocas páginas si la mayoría son de 2023/2024 (MIN_DATE las descarta).
// NOTA: Nombres en listing pueden estar truncados ("Nombre...").
//       Cover e imagen no están disponibles en listing.
//       Para enriquecer nombre/cover, implementar detail page fetch con detailLimit.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrapeMarkdown }               from "../_shared/firecrawl.ts";
import { inferGenres, linkGenres }      from "../_shared/genre-mapper.ts";
import { isMusicalEvent }               from "../_shared/music-filter.ts";
import {
  extractMinPriceFromMarkdown,
  emptySyncResult,
  toEventRow,
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

const LISTING_URL      = "https://teleticket.com.pe/conciertos";
const SOURCE           = "teleticket" as const;
const SCRAPER_VERSION  = "2026-03-19.1";

/**
 * Máximo de páginas de detalle por run.
 * 0  → solo listing, inserta todo sin precio/hora (para el primer run masivo).
 * 5  → enriquece 5 eventos por run (modo cron diario, seguro dentro del timeout).
 * Controlar también vía body: { "detailLimit": 5 }
 */
const DETAIL_BATCH_LIMIT = 0;
/** Delay entre páginas de detalle para no sobrecargar Teleticket. */
const DETAIL_THROTTLE_MS = 800;

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListingEvent {
  name:        string;
  venue_raw:   string | null;   // "VENUE - DISTRICT - CITY" tal como viene del listing
  category:    string;          // "Música" | "Teatro" | etc.
  date_raw:    string;          // "24 de mayo 2026" o "27 de marzo 2026 - 28 de marzo 2026"
  cover_url:   string | null;
  ticket_url:  string;
  slug:        string;          // "the-killers-lima-2026"
}

interface DetailData {
  start_time: string | null;    // "HH:MM:SS"
  price_min:  number | null;    // S/ validado
  venue_raw:  string | null;    // del campo "Recinto:" si existe
}

// ─── Listing parser ───────────────────────────────────────────────────────────
//
// Estructura del grid en el markdown de teleticket.com.pe/conciertos:
//
//   [![](https://cdn.teleticket.com.pe/images/eventos/EVENT_calugalistado.jpg)\\
//   \\
//   ![ticket](...)\\
//   \\
//   **VENUE - DISTRICT - CITY** / Música\\
//   \\
//   \\
//   **EVENT NAME**\\
//   \\
//   DATE_STRING](https://teleticket.com.pe/event-slug)
//
// Cada evento del grid empieza con `[![](https://cdn.teleticket` y las líneas
// están separadas por `\\` + newline (hard line breaks de markdown).
// Los eventos NO musicales (Teatro/Entretenimiento/etc.) se filtran aquí
// para no gastar créditos en sus páginas de detalle.

function normalizeMarkdownBreaks(md: string): string {
  return md
    .replace(/\\\\\n/g, " ")  // \\ + newline → espacio
    .replace(/\\\s+/g, " ")   // \ residual + whitespace → espacio
    .replace(/\s{2,}/g, " "); // multi-espacio → uno
}

function parseListingMarkdown(markdown: string): ListingEvent[] {
  // El grid empieza después del carrusel de banners, marcado por ‹›
  const gridStart = markdown.indexOf("‹›");
  const gridMd    = gridStart !== -1 ? markdown.slice(gridStart) : markdown;
  const clean     = normalizeMarkdownBreaks(gridMd);

  // Dividir por inicio de cada tarjeta de evento (imagen calugalistado = grid item)
  const chunks = clean.split(/(?=\[!\[\]\(https:\/\/cdn\.teleticket[^)]*calugalistado)/);

  const events: ListingEvent[] = [];
  const seen   = new Set<string>();

  for (const chunk of chunks) {
    if (!chunk.includes("calugalistado")) continue;

    // cover_url
    const coverM = chunk.match(/\[!\[\]\((https:\/\/cdn\.teleticket[^)]+)\)/);

    // venue_raw + category: **VENUE** / Música
    const venueM = chunk.match(
      /\*\*([^*]+)\*\*\s*\/\s*(Música|Teatro|Entretenimiento|Deportes|Otros)/,
    );

    // name: último **...** antes del cierre ](URL)
    const boldMatches = [...chunk.matchAll(/\*\*([^*]+)\*\*/g)];
    const nameM = boldMatches.length >= 2 ? boldMatches[boldMatches.length - 1] : null;

    // ticket_url: cierre ](https://teleticket.com.pe/slug)
    const urlM = chunk.match(/\]\((https:\/\/teleticket\.com\.pe\/([^)]+))\)\s*$/);

    if (!venueM || !nameM || !urlM) continue;

    // date_raw: texto entre el final del último **name** y el ](URL)
    const afterName  = chunk.slice((nameM.index ?? 0) + nameM[0].length);
    const dateM      = afterName.match(/^\s*([\d][^[]*?)(?:\s*\]\(https:\/\/teleticket)/);
    const date_raw   = dateM?.[1]?.trim() ?? "";

    const ticket_url = urlM[1];
    if (seen.has(ticket_url)) continue; // el carrusel repite algunos eventos
    seen.add(ticket_url);

    if (!date_raw) continue; // sin fecha no sirve

    events.push({
      name:       nameM[1].trim(),
      venue_raw:  venueM[1].trim(),
      category:   venueM[2],
      date_raw,
      cover_url:  coverM?.[1] ?? null,
      ticket_url,
      slug:       urlM[2],
    });
  }

  return events;
}

// ─── Date parser ──────────────────────────────────────────────────────────────
//
// Formatos observados en el listing:
//   "24 de mayo 2026"
//   "27 de marzo 2026 - 28 de marzo 2026"   → tomar primera fecha
//   "19 de marzo 2026 al 05 de abril 2026"  → tomar primera fecha
//   "30 de mayo 2026 al 31 de mayo 2026"    → tomar primera fecha

const MONTH_MAP: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, setiembre: 9, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function parseSpanishDate(raw: string): string | null {
  // Tomar solo la primera fecha en rangos ("27 de marzo 2026 - 28 de marzo 2026")
  const first = raw.split(/\s+-\s+|\s+al\s+/)[0].trim();

  const m = first
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/(\d{1,2})\s+de\s+([a-z]+)\s+(\d{4})/);

  if (!m) return null;

  const day   = parseInt(m[1], 10);
  const month = MONTH_MAP[m[2]];
  const year  = parseInt(m[3], 10);

  if (!month || day < 1 || day > 31) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00-05:00`;
}

// ─── Detail page parser ───────────────────────────────────────────────────────
//
// Solo se llama para eventos sin precio o sin hora — para ahorrar créditos.
//
// Campos extraídos del markdown de la página de detalle:
//
//   Precio:   tabla markdown con celdas "S/160.00", "S/188.00", etc.
//             → extractMinPriceFromMarkdown() toma el mínimo.
//
//   Hora:     "**Hora de inicio:** El evento podrá comenzar a las 09:00 p.m."
//             → regex determinista, nunca inferido.
//
//   Recinto:  "**Recinto:** Costa 21 - Costa Verde S/N - San Miguel, Lima Perú."
//             → venue más preciso que el del listing (tiene dirección completa).

async function fetchDetailData(ticketUrl: string): Promise<DetailData> {
  try {
    const { markdown } = await scrapeMarkdown(ticketUrl, { waitFor: 1500 }, 2);

    // ── Precio ────────────────────────────────────────────────────────────────
    const price_min = extractMinPriceFromMarkdown(markdown);

    // ── Hora de inicio ────────────────────────────────────────────────────────
    // Patrones: "09:00 p.m."  "8:00 pm"  "20:30 hrs"
    let start_time: string | null = null;
    const horaM = markdown.match(
      /[Hh]ora\s+de\s+inicio[^0-9]*(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i,
    );
    if (horaM) {
      let h    = parseInt(horaM[1], 10);
      const mi = horaM[2];
      const ap = horaM[3]?.replace(/\./g, "").toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      start_time = `${String(h).padStart(2, "0")}:${mi}:00`;
    }

    // ── Recinto ───────────────────────────────────────────────────────────────
    // "**Recinto:** Costa 21 - Costa Verde S/N - San Miguel, Lima Perú."
    let venue_raw: string | null = null;
    const recintoM = markdown.match(/[Rr]ecinto[^:]*:\*+\s*([^\n.]+)/);
    if (recintoM) {
      venue_raw = recintoM[1].trim().replace(/\*+/g, "").trim() || null;
    }

    return { start_time, price_min, venue_raw };
  } catch (err) {
    console.warn(`[sync-teleticket] detail fetch failed for ${ticketUrl}:`, err);
    return { start_time: null, price_min: null, venue_raw: null };
  }
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated" | "failed" | "skipped";

async function upsertEvent(event: UnifiedEvent): Promise<UpsertOutcome> {
  const resolvedLoc = resolveEventLocation({
    rawVenue: event.venue ?? null,
    rawName:  event.name,
  });

  const venue_id = resolvedLoc.venue
    ? await upsertVenue(supabase, {
        name:         resolvedLoc.venue,
        city:         resolvedLoc.city,
        country_code: resolvedLoc.country_code,
      })
    : null;

  const row = toEventRow(
    {
      ...event,
      name:         stripTrailingCityFromEventName(event.name, resolvedLoc.city),
      venue:        resolvedLoc.venue,
      city:         resolvedLoc.city,
      country_code: resolvedLoc.country_code,
    },
    venue_id,
  );

  try {
    // Buscar por ticket_url (clave de dedup para teleticket)
    const { data: existing, error: selErr } = await supabase
      .from("events")
      .select("id, price_min, start_time, venue_id")
      .eq("ticket_url", row.ticket_url)
      .maybeSingle();

    if (selErr) throw new Error(`SELECT: ${selErr.message}`);

    const isUpdate = existing !== null;

    const writeRow = isUpdate
      ? {
          ...row,
          // No sobreescribir campos que ya tienen valor
          price_min:  row.price_min  ?? existing.price_min,
          start_time: row.start_time ?? existing.start_time,
          venue_id:   row.venue_id   ?? existing.venue_id,
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
    console.error(`[sync-teleticket] upsertEvent error ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(detailLimit = DETAIL_BATCH_LIMIT): Promise<SyncResult> {
  const result = emptySyncResult();

  console.log(`[sync-teleticket] version=${SCRAPER_VERSION}`);

  // ── 1. Scrape listing (1 crédito) ─────────────────────────────────────────
  const { markdown } = await scrapeMarkdown(LISTING_URL, { waitFor: 2500 });
  const listings     = parseListingMarkdown(markdown);

  // Ventana de fechas:
  //   MIN_DATE  → enero 2026: histórico para que usuarios marquen eventos asistidos
  //   todayLima → solo eventos futuros reciben página de detalle (precio + hora)
  //               los pasados no necesitan ese dato — ahorra créditos
  const MIN_DATE  = new Date("2026-01-01T00:00:00-05:00");
  const todayLima = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Lima" }),
  );
  todayLima.setHours(0, 0, 0, 0);

  const musicListings = listings.filter((e) => {
    if (e.category !== "Música") return false;
    if (!isMusicalEvent(e.name, e.venue_raw ?? "")) return false;
    const date = parseSpanishDate(e.date_raw);
    if (!date) return false;
    return new Date(date) >= MIN_DATE;
  });

  // Subdivisión: futuros (candidatos a detalle) vs. pasados (listing only)
  const futureListings = musicListings.filter((e) =>
    new Date(parseSpanishDate(e.date_raw)!) >= todayLima,
  );
  const pastListings = musicListings.filter((e) =>
    new Date(parseSpanishDate(e.date_raw)!) < todayLima,
  );

  console.log(
    `[sync-teleticket] listing: ${listings.length} total →`,
    `${futureListings.length} futuros, ${pastListings.length} pasados (desde ene-2026),`,
    `${listings.length - musicListings.length} descartados`,
  );

  // ── 2. Enriquecer con páginas de detalle (1 crédito c/u) ──────────────────
  // Solo eventos FUTUROS reciben detalle (precio + hora).
  // Eventos pasados no lo necesitan — el usuario solo quiere marcar "fui a este".
  const toEnrich = futureListings.slice(0, detailLimit);

  const detailMap = new Map<string, DetailData>();

  for (const listing of toEnrich) {
    const detail = await fetchDetailData(listing.ticket_url);
    detailMap.set(listing.ticket_url, detail);
    await sleep(DETAIL_THROTTLE_MS);
  }

  // ── 3. Construir UnifiedEvent y upsertear ─────────────────────────────────
  for (const listing of musicListings) {
    const date = parseSpanishDate(listing.date_raw)!;

    const detail   = detailMap.get(listing.ticket_url);
    // Preferir venue del Recinto (más preciso) si está disponible
    const venueRaw = detail?.venue_raw ?? listing.venue_raw;

    const event: UnifiedEvent = {
      source:          SOURCE,
      ticket_url:      listing.ticket_url,
      external_slug:   listing.slug,
      name:            listing.name,
      date,
      start_time:      detail?.start_time ?? null,
      venue:           venueRaw,
      city:            "Lima",           // resolveEventLocation lo corregirá si es otra ciudad
      country_code:    "PE",
      cover_url:       listing.cover_url,
      price_min:       detail?.price_min ?? null,
      price_max:       null,
      lineup:          [],
      description:     null,
      genre_slugs:     inferGenres(listing.name, listing.venue_raw ?? ""),
      is_active:       true,
      scraper_version: SCRAPER_VERSION,
    };

    const outcome = await upsertEvent(event);

    if (outcome === "skipped") result.skipped += 1;
    else result[outcome] += 1;
  }

  console.log(
    `[sync-teleticket] done — inserted: ${result.inserted},`,
    `updated: ${result.updated}, failed: ${result.failed}, skipped: ${result.skipped}`,
  );
  console.log(
    `[sync-teleticket] créditos usados: ~${1 + toEnrich.length}`,
    `(1 listing + ${toEnrich.length} detail de futuros, ${pastListings.length} pasados sin detalle)`,
  );

  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body        = await req.json().catch(() => ({}));
    const detailLimit = typeof body.detailLimit === "number" ? body.detailLimit : DETAIL_BATCH_LIMIT;
    const result      = await run(detailLimit);
    return new Response(JSON.stringify(result), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sync-teleticket]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});

// ─── DEPLOY ───────────────────────────────────────────────────────────────────
//
// supabase functions deploy sync-teleticket --no-verify-jwt
//
// SECRETS requeridos (Supabase Dashboard → Edge Functions → sync-teleticket):
//   FIRECRAWL_API_KEY=fc-...
//   (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY se inyectan automáticamente)
//
// CRON (8:30am UTC = 3:30am Lima):
//   SELECT cron.schedule(
//     'sync-teleticket-daily',
//     '30 8 * * *',
//     $$ SELECT net.http_post(
//       url     := current_setting('app.supabase_url') || '/functions/v1/sync-teleticket',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
//         'Content-Type',  'application/json'
//       ),
//       body := '{}'::jsonb
//     ) $$
//   );
//
// CRÉDITOS Firecrawl por run:
//   ~1 (listing) + hasta 40 (detail pages) = máx 41 créditos/run
//   En runs subsecuentes los eventos ya en DB se actualizan con ~5-10 nuevos/día

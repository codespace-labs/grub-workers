import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrapeMarkdown }               from "../_shared/firecrawl.ts";
import { inferGenres, linkGenres }      from "../_shared/genre-mapper.ts";
import {
  emptySyncResult,
  toEventRow,
  validatePrice,
  extractMinPriceFromMarkdown,
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

const SOURCE             = "passline" as const;
const SCRAPER_VERSION    = "2026-03-19.1";
const MIN_DATE           = new Date("2026-01-01T00:00:00-05:00");
const DETAIL_BATCH_LIMIT = 5;
const DETAIL_THROTTLE_MS = 800;

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Venues curadas ───────────────────────────────────────────────────────────
//
// El usuario seleccionó manualmente estas venues de electrónica/house/techno.
// Passline usa dos patrones de URL para páginas de organizador:
//   - passline.com/productora/SLUG  (ej: valetodo-downtown)
//   - passline.com/venue/SLUG       (ej: metronomo)
// El adapter intenta ambos y usa el que devuelva eventos.
//
// Si el slug no coincide, ver sección "VERIFICAR SLUGS" al final del archivo.

interface VenueConfig {
  displayName:   string;
  slug:          string;    // slug base; se intenta en /productora/ y /venue/
  defaultGenres: string[]; // géneros a asignar si inferGenres() no detecta nada eléctrico
}

// ─── Venues curadas con géneros por defecto ───────────────────────────────────
//
// Estos géneros se usan SOLO como fallback cuando el nombre del evento no
// contiene keywords reconocibles (ej: "Viernes 19 Abril - SISIFUZ").
// Si el nombre sí dice "Techno Night" o "Deep House Set", inferGenres() lo captura.
//
// Fuente de los géneros: conocimiento de cada venue:
//   - SISIFUZ        → electronica
//   - Baalsal        → electronica
//   - La Residencia  → electronica
//   - La Casona      → electronica (Central Beat Peru organiza aquí)
//   - Valetodo       → electronica + salsa + latin-bass (LGBTQI+, Miraflores, 20+ años)
//   - La Yunza       → electronica
//   - Espacio HNN    → electronica

const TARGET_VENUES: VenueConfig[] = [
  { displayName: "La Residencia Club",  slug: "la-residencia-club",  defaultGenres: ["electronica"]                    },
  { displayName: "La Casona de Camaná", slug: "la-casona-de-camana", defaultGenres: ["electronica"]                    },
  { displayName: "Valetodo Downtown",   slug: "valetodo-downtown",   defaultGenres: ["electronica", "salsa", "latin-bass"] },
  { displayName: "La Yunza",            slug: "la-yunza",            defaultGenres: ["electronica"]                    },
  { displayName: "Espacio HNN",         slug: "espacio-hnn",         defaultGenres: ["electronica"]                    },
  { displayName: "SISIFUZ",             slug: "sisifuz",             defaultGenres: ["electronica"]                    },
  { displayName: "Baalsal",             slug: "baalsal",             defaultGenres: ["electronica"]                    },
];

// Géneros electrónicos admitidos para estas venues
const ELECTRONIC_SLUGS = new Set(["techno", "house", "electronica"]);

// ─── Date parser (Passline) ───────────────────────────────────────────────────
//
// Passline mezcla formatos en los mismos eventos:
//   - Título: "Viernes 19 Abril - La Residencia Club"   → "19 Abril" (sin año)
//   - Cuerpo: "19 de Abril de 2026"                     → con año
//   - Cuerpo: "Sábado 19 de Abril"                      → sin año
//
// Intenta primero el formato con año (más confiable); si no, infiere el año.

const FULL_MONTH_MAP: Readonly<Record<string, number>> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, setiembre: 9, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function parsePasslineDate(text: string): { date: string | null; start_time: string | null } {
  const s = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  let date: string | null = null;

  // 1. Intenta "19 de Abril de 2026" o "19 abril 2026" (con año)
  const fullM = s.match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/);
  if (fullM) {
    const day   = parseInt(fullM[1], 10);
    const month = FULL_MONTH_MAP[fullM[2]];
    const year  = parseInt(fullM[3], 10);
    if (month && day >= 1 && day <= 31 && year >= 2020 && year <= 2100) {
      date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00-05:00`;
    }
  }

  // 2. Si no hay año, intenta "19 Abril" o "19 de Abril" → parseShortDate infiere año
  if (!date) {
    const shortM = s.match(/(\d{1,2})\s+(?:de\s+)?([a-z]{3,})\b/);
    if (shortM) {
      // reensamblar en formato "19ABR" para parseShortDate
      const abbrev = shortM[2].slice(0, 3).toUpperCase();
      date = parseShortDate(`${shortM[1]}${abbrev}`);
    }
  }

  // Hora: "11:00 pm" / "23:00" / "10:30 p.m."
  let start_time: string | null = null;
  const timeM = s.match(/(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/);
  if (timeM) {
    let h = parseInt(timeM[1], 10);
    const mi = timeM[2];
    const ap  = timeM[3]?.replace(/\./g, "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    start_time = `${String(h).padStart(2, "0")}:${mi}:00`;
  }

  return { date, start_time };
}

// ─── Organizer page parser ────────────────────────────────────────────────────
//
// Extrae URLs de eventos de passline.com/productora/SLUG o /venue/SLUG.
// Passline renderiza con JS → Firecrawl con waitFor expone los links.

function extractEventUrls(markdown: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  // Captura links a páginas de eventos
  const re = /https?:\/\/(?:www\.)?passline\.com\/eventos\/([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const url = `https://www.passline.com/eventos/${m[1]}`;
    if (!seen.has(url)) { seen.add(url); urls.push(url); }
  }
  return urls;
}

// ─── Detail page parser ───────────────────────────────────────────────────────

interface DetailData {
  name:       string | null;
  date:       string | null;
  start_time: string | null;
  venue_raw:  string | null;
  price_min:  number | null;
}

function parseDetailPage(markdown: string, fallbackVenue: string): DetailData {
  // Nombre: primer h1 o h2 (el título del evento)
  const titleM = markdown.match(/^#{1,2}\s+(.+)$/m);
  const name   = titleM?.[1]?.trim() ?? null;

  // Fecha + hora en el cuerpo de la página
  const { date, start_time } = parsePasslineDate(markdown);

  // Venue: buscar "Lugar:", "Recinto:", "Local:" o el fallback display name
  const venueM = markdown.match(/(?:Lugar|Recinto|Local|Venue)\s*:?\s*([^\n|]+)/i);
  const venue_raw = venueM?.[1]?.trim() ?? fallbackVenue;

  // Precio en Soles (S/ NNN o PEN NNN)
  // Passline puede usar "S/ 50", "S/50.00", "PEN 50.00"
  let price_min = extractMinPriceFromMarkdown(markdown);
  if (!price_min) {
    // Fallback: buscar "NNN.00 PEN" o "PEN NNN"
    const penM = markdown.match(/(?:PEN|pen)\s*([\d.]+)|([\d.]+)\s*(?:PEN|pen)/);
    if (penM) {
      const raw = parseFloat(penM[1] ?? penM[2]);
      if (Number.isFinite(raw)) price_min = validatePrice(raw);
    }
  }

  return { name, date, start_time, venue_raw, price_min };
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
      .select("id, price_min, venue_id, start_time")
      .eq("ticket_url", row.ticket_url)
      .maybeSingle();

    if (selErr) throw new Error(`SELECT: ${selErr.message}`);

    const isUpdate = existing !== null;
    const writeRow = isUpdate
      ? { ...row, price_min: row.price_min ?? existing.price_min, venue_id: row.venue_id ?? existing.venue_id, start_time: row.start_time ?? existing.start_time }
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
    console.error(`[sync-passline] upsert error ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Venue discovery ──────────────────────────────────────────────────────────
//
// Intenta /productora/SLUG primero, luego /venue/SLUG.
// Usa el primero que devuelva links de eventos.

async function getVenueEventUrls(venue: VenueConfig): Promise<{ urls: string[]; credits: number }> {
  const candidates = [
    `https://www.passline.com/productora/${venue.slug}`,
    `https://www.passline.com/venue/${venue.slug}`,
  ];

  for (const url of candidates) {
    try {
      const { markdown } = await scrapeMarkdown(url, { waitFor: 2500 });
      const urls = extractEventUrls(markdown);
      if (urls.length > 0) {
        console.log(`[sync-passline] ${venue.displayName}: ${urls.length} eventos en ${url}`);
        return { urls, credits: 1 };
      }
    } catch {
      // página no existe o vacía → probar el siguiente patrón
    }
  }

  console.warn(`[sync-passline] ${venue.displayName}: sin página de organizador (slug="${venue.slug}"). Ver VERIFICAR SLUGS.`);
  return { urls: [], credits: 0 };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(detailLimit = DETAIL_BATCH_LIMIT): Promise<SyncResult> {
  const result = emptySyncResult();
  console.log(`[sync-passline] version=${SCRAPER_VERSION}`);

  // 1. Descubrir URLs de eventos en cada venue
  const eventQueue: Array<{ url: string; venueName: string; defaultGenres: string[] }> = [];
  const seenUrls   = new Set<string>();
  let   credits    = 0;

  for (const venue of TARGET_VENUES) {
    const { urls, credits: c } = await getVenueEventUrls(venue);
    credits += c;
    for (const url of urls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        eventQueue.push({ url, venueName: venue.displayName, defaultGenres: venue.defaultGenres });
      }
    }
  }

  console.log(`[sync-passline] ${eventQueue.length} eventos únicos descubiertos en ${credits} créditos`);

  // 2. Scrape detail pages (limitado por detailLimit)
  const toProcess = eventQueue.slice(0, detailLimit);

  for (const { url: ticket_url, venueName, defaultGenres } of toProcess) {
    try {
      const { markdown } = await scrapeMarkdown(ticket_url, { waitFor: 2000 });
      credits += 1;

      const detail = parseDetailPage(markdown, venueName);

      if (!detail.name || !detail.date) {
        console.warn(`[sync-passline] sin nombre/fecha en ${ticket_url}`);
        result.skipped += 1;
        await sleep(DETAIL_THROTTLE_MS);
        continue;
      }

      if (new Date(detail.date) < MIN_DATE) {
        result.skipped += 1;
        await sleep(DETAIL_THROTTLE_MS);
        continue;
      }

      // Inferir géneros del nombre. Si no detecta ningún género electrónico,
      // usar los defaultGenres del venue (definidos por el usuario arriba).
      let genre_slugs = inferGenres(detail.name, detail.venue_raw ?? "");
      if (!genre_slugs.some((g) => ELECTRONIC_SLUGS.has(g))) {
        genre_slugs = [...new Set([...genre_slugs, ...defaultGenres])];
      }

      const slug = ticket_url.split("/eventos/")[1] ?? ticket_url;

      const event: UnifiedEvent = {
        source:          SOURCE,
        ticket_url,
        external_slug:   slug,
        name:            detail.name,
        date:            detail.date,
        start_time:      detail.start_time,
        venue:           detail.venue_raw,
        city:            "Lima",
        country_code:    "PE",
        cover_url:       null,
        price_min:       validatePrice(detail.price_min),
        price_max:       null,
        lineup:          [],
        description:     null,
        genre_slugs,
        is_active:       true,
        scraper_version: SCRAPER_VERSION,
      };

      const outcome = await upsertEvent(event);
      if (outcome === "failed") result.failed += 1;
      else result[outcome] += 1;

    } catch (err) {
      console.error(`[sync-passline] error en ${ticket_url}:`, err);
      result.failed += 1;
    }

    await sleep(DETAIL_THROTTLE_MS);
  }

  console.log(`[sync-passline] done — inserted:${result.inserted} updated:${result.updated} failed:${result.failed} skipped:${result.skipped}`);
  console.log(`[sync-passline] créditos usados: ${credits} (venue pages + ${toProcess.length} detail pages)`);
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
    const result      = await run(detailLimit);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[sync-passline]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

// DEPLOY: supabase functions deploy sync-passline --no-verify-jwt
// SECRETS: FIRECRAWL_API_KEY
//
// CRÉDITOS: hasta 7 (venue discovery) + detailLimit (detail pages) por run.
// Con detailLimit=25 y 7 venues → máximo ~32 créditos por run.
//
// VERIFICAR SLUGS — si un venue no encuentra eventos, buscar su URL real:
//   1. Ir a passline.com y buscar el evento más reciente de ese venue
//   2. En la página del evento, ver si hay un link "Ver más de [Venue]"
//   3. Ese link apunta a passline.com/productora/SLUG o passline.com/venue/SLUG
//   4. Actualizar TARGET_VENUES con el slug correcto
//
// Slugs confirmados por búsqueda web:
//   - valetodo-downtown  → passline.com/productora/valetodo-downtown ✓
//
// Slugs a verificar en primer run (revisar logs):
//   - la-residencia-club, la-casona-de-camana, la-yunza,
//     espacio-hnn, sisifuz, baalsal

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { upsertVenue } from "../_shared/venue-upsert.ts";
import {
  resolveEventLocation,
  stripTrailingCityFromEventName,
} from "../_shared/location-normalization.ts";

// ─── Env ──────────────────────────────────────────────────────────────────────

const TM_API_KEY                = Deno.env.get("TM_API_KEY")                ?? "";
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const SOURCE = "ticketmaster";
const SCRAPER_VERSION = "2026-03-18.4";
const MIN_VALID_PRICE_PEN = 30;

// ─── Types ────────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated" | "failed";

interface SyncResult {
  inserted: number;
  updated:  number;
  failed:   number;
}

// ── Ticketmaster API response shape ───────────────────────────────────────────

interface TmImage {
  ratio:  string;
  width:  number;
  url:    string;
}

interface TmPriceRange {
  min: number;
  max: number;
}

interface TmVenue {
  name: string;
  city: { name: string };
}

interface TmAttraction {
  name: string;
}

interface TmClassification {
  segment?:  { name: string };
  genre:     { name: string };
  subGenre?: { name: string };
}

interface TmEvent {
  id:               string;
  name:             string;
  url:              string;
  info?:            string;
  images:           TmImage[];
  priceRanges?:     TmPriceRange[];
  classifications?: TmClassification[];
  dates: {
    start: {
      dateTime?:  string; // ISO 8601 — preferred
      localDate:  string; // fallback
    };
  };
  _embedded?: {
    venues?:      TmVenue[];
    attractions?: TmAttraction[];
  };
}

interface TmApiResponse {
  _embedded?: {
    events: TmEvent[];
  };
  page: {
    totalPages:    number;
    number:        number;
    totalElements: number;
    size:          number;
  };
}

// ── Supabase row shape ────────────────────────────────────────────────────────

interface EventRow {
  name:          string;
  date:          string;
  venue:         string | null;
  venue_id:      string | null;
  city:          string;
  country_code:  string;
  ticket_url:    string;
  cover_url:     string | null;
  price_min:     number | null;
  price_max:     number | null;
  lineup:        string[];
  description:   string | null;
  is_active:     boolean;
  source:        string;
  external_slug: string | null;
}

// ── Normalized fetch result ───────────────────────────────────────────────────

interface FetchResult {
  events:      TmEvent[];
  totalPages:  number;
  currentPage: number;
}

// ─── Ticketmaster fetch ───────────────────────────────────────────────────────

const TM_BASE = "https://app.ticketmaster.com/discovery/v2/events.json";

async function fetchTicketmasterEvents(
  page: number,
  market = "PE",
  countryCode = "PE",
): Promise<FetchResult> {
  const now           = Date.now();
  const startDateTime = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const endDateTime   = new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const params = new URLSearchParams({
    apikey:             TM_API_KEY,
    countryCode,
    classificationName: "music",
    size:               "200",
    page:               String(page),
    sort:               "date,asc",
    startDateTime,
    endDateTime,
    ...(market !== countryCode ? { marketId: market } : {}),
  });

  const res = await fetch(`${TM_BASE}?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`Ticketmaster API error: ${res.status} ${res.statusText}`);
  }

  const data: TmApiResponse = await res.json();

  if (!data._embedded?.events) {
    return { events: [], totalPages: 0, currentPage: page };
  }

  return {
    events:      data._embedded.events,
    totalPages:  data.page.totalPages,
    currentPage: data.page.number,
  };
}

// ─── Genre inference ─────────────────────────────────────────────────────────

/** Maps a TM genre name to a Grub slug. Returns null if no match. */
function mapGenre(genre: string, subGenre?: string): string | null {
  switch (genre) {
    case "Techno":      return "techno";
    case "Tech House":  return "house";
    case "House":       return "house";
    case "Deep House":  return "house";
    case "Electronic":  return "electronica";
    case "EDM":         return "electronica";
    case "Dance":       return "electronica";
    case "Hip-Hop/Rap": return "hip-hop";
    case "R&B":         return "hip-hop";
    case "Rock":        return "rock";
    case "Metal":       return "rock";
    case "Punk":        return "rock";
    case "Blues":       return "rock";
    case "Alternative": return "indie";
    case "Indie Rock":  return "indie";
    case "Folk":        return "indie";
    case "Pop":         return "pop";
    case "K-Pop":       return "pop";
    case "Jazz":        return "jazz";
    case "Classical":   return "clasica";
    case "Opera":       return "clasica";
    case "Country":     return null;
    case "Latin": {
      switch (subGenre) {
        case "Salsa":     return "salsa";
        case "Cumbia":    return "cumbia";
        case "Reggaeton": return "reggaeton";
        default:          return "latin-bass";
      }
    }
    default: return null;
  }
}

/** Scans the event name for genre keywords and returns matching slugs. */
function slugsFromKeywords(name: string): string[] {
  const n = name.toLowerCase();
  const slugs: string[] = [];

  const rules: [RegExp, string][] = [
    [/techno/,              "techno"],
    [/house/,               "house"],
    [/reggaet/,             "reggaeton"],
    [/salsa/,               "salsa"],
    [/cumbia/,              "cumbia"],
    [/bachata/,             "bachata"],
    [/merengue/,            "merengue"],
    [/rock/,                "rock"],
    [/hip[\s-]hop|rap\b/,   "hip-hop"],
    [/trap/,                "trap"],
    [/\bindie\b/,           "indie"],
    [/electro|edm|rave/,    "electronica"],
    [/\bpop\b/,             "pop"],
    [/k[\s-]?pop|kpop/,     "kpop"],
    [/jazz/,                "jazz"],
    [/clasica|clasico|classical|sinfoni|orquesta|filarmoni|guitarra clasica/, "clasica"],
  ];

  for (const [re, slug] of rules) {
    if (re.test(n)) slugs.push(slug);
  }

  return slugs;
}

/**
 * Infers an array of Grub genre slugs from a TmEvent.
 * Order of precedence: genre → subGenre → keyword scan on event name.
 * Deduplicates the result; returns [] if nothing matches.
 */
function inferGenres(event: TmEvent): string[] {
  const classification = event.classifications?.[0];
  const genre    = classification?.genre?.name;
  const subGenre = classification?.subGenre?.name;

  const slugs = new Set<string>();

  // 1. Try primary genre (with optional subGenre for "Latin" branching)
  if (genre) {
    const slug = mapGenre(genre, subGenre);
    if (slug) slugs.add(slug);
  }

  // 2. Try subGenre independently if genre gave no match
  if (!slugs.size && subGenre) {
    const slug = mapGenre(subGenre);
    if (slug) slugs.add(slug);
  }

  // 3. Fallback: keyword scan on event name
  if (!slugs.size) {
    for (const s of slugsFromKeywords(event.name)) slugs.add(s);
  }

  return [...slugs];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Picks the 16_9 image with the largest width; falls back to images[0]. */
function pickCoverUrl(images: TmImage[]): string | null {
  if (!images.length) return null;

  const candidates = images.filter((img) => img.ratio === "16_9");
  const pool       = candidates.length ? candidates : images;

  return pool.reduce((best, img) => (img.width > best.width ? img : best)).url;
}

function normalizeScrapedPrice(value: number | null): number | null {
  if (value == null) return null;
  return value >= MIN_VALID_PRICE_PEN ? value : null;
}

const NON_MUSIC_KEYWORDS = [
  "estacionamiento",
  "parking",
  "el musical",
  "teatro",
  "comedia",
  "stand up",
  "standup",
  "stand-up",
  "monólogo",
  "monologo",
  "ballet",
  "danza",
  "show infantil",
  "espectáculo infantil",
  "espectaculo infantil",
  "magia",
  "circo",
];

function shouldImportTicketmasterEvent(event: TmEvent): boolean {
  const name = event.name.toLowerCase();
  const genre = event.classifications?.[0]?.genre?.name?.toLowerCase() ?? "";
  const segment = event.classifications?.[0]?.segment?.name?.toLowerCase() ?? "";

  // Ticketmaster Discovery already comes filtered by music, so trust that first.
  if (segment === "music" || genre === "music" || genre === "latin" || genre === "rock" || genre === "pop") {
    return !["estacionamiento", "parking"].some((kw) => name.includes(kw));
  }

  // Fallback only on the event name; venue names like "Teatro ..." can still host concerts.
  return !NON_MUSIC_KEYWORDS.some((kw) => name.includes(kw));
}

/** Extracts the event slug from a ticketmaster.pe URL. */
function extractSlug(url: string): string | null {
  try {
    // Handle affiliate URLs: ...?u=https://www.ticketmaster.pe/event/some-slug
    const uParam = new URL(url).searchParams.get("u");
    const target = uParam ?? url;
    const match  = target.match(/\/event\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Maps a TmEvent to the Supabase EventRow shape. */
async function mapToRow(event: TmEvent, countryCode = "PE"): Promise<EventRow> {
  const { dateTime, localDate } = event.dates.start;
  const resolvedLocation = resolveEventLocation({
    rawVenue: event._embedded?.venues?.[0]?.name ?? null,
    rawName: event.name,
    explicitCity: event._embedded?.venues?.[0]?.city?.name ?? null,
    countryCode,
  });
  const city = resolvedLocation.city;
  const country_code = resolvedLocation.country_code;
  const venue = resolvedLocation.venue;
  const venue_id = venue
    ? await upsertVenue(supabase, { name: venue, city, country_code })
    : null;

  return {
    name:          stripTrailingCityFromEventName(event.name, city),
    date:          dateTime ?? `${localDate}T00:00:00`,
    venue,
    venue_id,
    city,
    country_code,
    ticket_url:    event.url,
    cover_url:     pickCoverUrl(event.images),
    price_min:     normalizeScrapedPrice(event.priceRanges?.[0]?.min ?? null),
    price_max:     normalizeScrapedPrice(event.priceRanges?.[0]?.max ?? null),
    lineup:        event._embedded?.attractions?.map((a) => a.name) ?? [],
    description:   event.info ?? null,
    is_active:     true,
    source:        SOURCE,
    external_slug: extractSlug(event.url),
  };
}

// ─── Genre linking ────────────────────────────────────────────────────────────

/**
 * For each inferred slug, resolves the genre_id from `genres` and inserts
 * into `event_genres`. Unknown slugs are silently skipped.
 */
async function linkGenres(eventId: string, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    const { data: genre } = await supabase
      .from("genres")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (!genre) {
      console.warn(`[linkGenres] unknown slug "${slug}" — skipping`);
      continue;
    }

    const { error } = await supabase
      .from("event_genres")
      .insert({ event_id: eventId, genre_id: genre.id })
      .select()
      // ON CONFLICT DO NOTHING equivalent via ignoreDuplicates
      ;

    // Postgres unique-violation code: 23505 — treat as harmless
    if (error && error.code !== "23505") {
      console.error(`[linkGenres] insert failed for slug "${slug}":`, error.message);
    }
  }
}

// ─── Supabase upsert ─────────────────────────────────────────────────────────

async function upsertEvent(event: TmEvent, countryCode = "PE"): Promise<UpsertOutcome> {
  if (!shouldImportTicketmasterEvent(event)) {
    console.warn(`[sync-ticketmaster] skipping non-musical event: ${event.name}`);
    return "failed";
  }

  const row = await mapToRow(event, countryCode);

  // 1. Buscar por external_slug primero (detecta dups entre API y scraper web)
  let existing: {
    id: string;
    price_min: number | null;
    price_max: number | null;
    venue_id: string | null;
  } | null = null;

  if (row.external_slug) {
    const { data } = await supabase
        .from("events")
        .select("id, price_min, price_max, venue_id")
        .eq("external_slug", row.external_slug)
        .maybeSingle();
    existing = data;
  }

  // 2. Fallback: buscar por ticket_url
  if (!existing) {
      const { data, error: selectError } = await supabase
        .from("events")
        .select("id, price_min, price_max, venue_id")
        .eq("ticket_url", row.ticket_url)
        .maybeSingle();
    if (selectError) throw new Error(`SELECT failed for ${row.ticket_url}: ${selectError.message}`);
    existing = data;
  }

  const isUpdate = existing !== null;
  const writeRow = existing
    ? {
        ...row,
        price_min: row.price_min ?? existing.price_min,
        price_max: row.price_max ?? existing.price_max,
        venue_id: row.venue_id ?? existing.venue_id,
      }
    : row;

  const query = supabase.from("events");
  const { data: upserted, error: upsertError } = existing
    ? await query
        .update(writeRow)
        .eq("id", existing.id)
        .select("id")
        .single()
    : await query
        .upsert(writeRow, { onConflict: "ticket_url" })
        .select("id")
        .single();

  if (upsertError || !upserted) {
    throw new Error(`UPSERT failed for ${row.ticket_url}: ${upsertError?.message}`);
  }

  const slugs = inferGenres(event);
  if (slugs.length) {
    await linkGenres(upserted.id, slugs);
  }

  return isUpdate ? "updated" : "inserted";
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function run(market = "PE", countryCode = "PE"): Promise<SyncResult> {
  const result: SyncResult = { inserted: 0, updated: 0, failed: 0 };

  console.log(`[sync-ticketmaster] version=${SCRAPER_VERSION} market=${market} country=${countryCode}`);

  let page = 0;

  while (true) {
    const { events, totalPages, currentPage } = await fetchTicketmasterEvents(
      page,
      market,
      countryCode,
    );

    console.log(
      `[sync-ticketmaster][${countryCode}] page ${currentPage + 1}/${totalPages} — ${events.length} events`,
    );

    for (const event of events) {
      try {
        const outcome = await upsertEvent(event, countryCode);
        result[outcome] += 1;
      } catch (err) {
        console.error(`[sync-ticketmaster][${countryCode}] failed event ${event.id}:`, err);
        result.failed += 1;
      }
    }

    if (totalPages === 0 || currentPage >= totalPages - 1) break;
    page += 1;
  }

  return result;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const market      = (body.market      as string | undefined) ?? "PE";
    const countryCode = (body.countryCode as string | undefined) ?? "PE";

    const result = await run(market, countryCode);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sync-ticketmaster]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ─── DEPLOY ───────────────────────────────────────────────────────────────────
//
// supabase functions deploy sync-ticketmaster --no-verify-jwt
//
// VARIABLES DE ENTORNO (Supabase Dashboard → Edge Functions → sync-ticketmaster):
//   TM_API_KEY=tu_api_key_de_ticketmaster
//   (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son inyectadas automáticamente)
//
// SQL — correr UNA VEZ antes del primer deploy:
//   ALTER TABLE events
//   ADD CONSTRAINT events_ticket_url_unique UNIQUE (ticket_url);
//
// CRON DIARIO (Supabase SQL Editor — requiere pg_cron + pg_net habilitados):
//   SELECT cron.schedule(
//     'sync-ticketmaster-daily',
//     '0 8 * * *',  -- 8am UTC = 3am Lima (UTC-5)
//     $$
//     SELECT net.http_post(
//       url     := current_setting('app.supabase_url') || '/functions/v1/sync-ticketmaster',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
//         'Content-Type',  'application/json'
//       ),
//       body    := '{}'::jsonb
//     )
//     $$
//   );
//
// CURL DE PRUEBA:
//   curl -X POST https://TU_PROJECT_REF.supabase.co/functions/v1/sync-ticketmaster \
//     -H "Authorization: Bearer TU_ANON_KEY" \
//     -H "Content-Type: application/json"

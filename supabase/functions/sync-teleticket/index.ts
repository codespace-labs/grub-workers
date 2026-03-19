import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { upsertVenue } from "../_shared/venue-upsert.ts";
import {
  resolveEventLocation,
  stripTrailingCityFromEventName,
} from "../_shared/location-normalization.ts";

// ─── Env ──────────────────────────────────────────────────────────────────────

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Constants ────────────────────────────────────────────────────────────────

const TELETICKET_BASE_URL = "https://teleticket.com.pe/conciertos";
const SOURCE              = "teleticket";
const SCRAPER_VERSION     = "2026-03-18.4";
const MIN_VALID_PRICE_PEN = 30;
const DETAIL_BATCH_LIMIT  = 100;   // max events enriched per run (per page)
const DETAIL_THROTTLE_MS  = 500;   // ms between detail page fetches

// ─── Helper ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Types ────────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated" | "failed";

interface SyncResult {
  inserted: number;
  updated:  number;
  failed:   number;
}

interface RawEvent {
  name:       string;
  date:       string | null;
  venue:      string | null;
  ticket_url: string;
  cover_url:  string | null;
  price_min:  number | null;
  start_time: string | null;
}

interface EventDetail {
  start_time: string | null;
  price_min:  number | null;
}

interface FetchPageResult {
  html: string;
  status: number | null;
}

interface ParsedEventDate {
  isoDate: string;
  startsAt: string;
}

interface ListingDiagnostics {
  totalArticles: number;
  paginatorPages: number;
}

// ── Supabase row shape ────────────────────────────────────────────────────────

interface EventRow {
  name:        string;
  date:        string | null;
  venue:       string | null;
  venue_id:    string | null;
  city:        string;
  country_code:string;
  ticket_url:  string;
  cover_url:   string | null;
  price_min:   number | null;
  price_max:   null;
  start_time:  string | null;
  lineup:      string[];
  description: null;
  is_active:   boolean;
  source:      string;
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

/** Fetches the HTML of a Teleticket page and preserves HTTP status for callers. */
async function fetchTeleticketPage(url: string): Promise<FetchPageResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (compatible; grub-scraper/1.0; +https://grub.app)",
        "Accept":          "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-PE,es;q=0.9,en;q=0.7",
      },
    });

    if (!res.ok) {
      console.error(`[fetchTeleticketPage] HTTP ${res.status} ${res.statusText} — ${url}`);
      return { html: "", status: res.status };
    }

    return { html: await res.text(), status: res.status };
  } catch (err) {
    console.error("[fetchTeleticketPage] network error:", err);
    return { html: "", status: null };
  }
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** Decodes common HTML entities to plain text. */
function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&nbsp;/g, " ")
    .trim();
}

function normalizeScrapedPrice(value: number | null): number | null {
  if (value == null) return null;
  return value >= MIN_VALID_PRICE_PEN ? value : null;
}

function normalizeTeleticketEventUrl(rawHref: string | null | undefined): string | null {
  if (!rawHref) return null;

  const href = decodeHtml(rawHref.trim());
  const blockedPaths = new Set([
    "/",
    "/conciertos",
    "/deportes",
    "/teatro",
    "/entretenimiento",
    "/otros",
    "/todos",
    "/puntosventa",
  ]);

  try {
    const url = href.startsWith("http")
      ? new URL(href)
      : new URL(href, "https://teleticket.com.pe");

    if (url.hostname !== "teleticket.com.pe") return null;

    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    const normalizedPathLower = normalizedPath.toLowerCase();

    if (blockedPaths.has(normalizedPathLower)) return null;
    if (normalizedPathLower.startsWith("/account/")) return null;
    if (normalizedPathLower.startsWith("/cliente/")) return null;
    if (normalizedPathLower.startsWith("/landing/")) return null;

    url.pathname = normalizedPath;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseTeleticketDate(chunk: string): ParsedEventDate | null {
  const getDateMatch = chunk.match(/v-html="getDate\(\[\s*'(\d{4}-\d{2}-\d{2})'/i);
  const isoDate = getDateMatch?.[1] ?? null;

  if (!isoDate) return null;

  return {
    isoDate,
    startsAt: `${isoDate}T00:00:00-05:00`,
  };
}

function getListingDiagnostics(html: string): ListingDiagnostics {
  const totalArticles = Math.max(0, html.split("<article").length - 1);
  const pageMatches = [...html.matchAll(/class="page-link"[^>]*data-page="(\d+)"/g)];
  const paginatorPages = pageMatches.length
    ? Math.max(...pageMatches.map((match) => parseInt(match[1], 10)))
    : 1;

  return { totalArticles, paginatorPages };
}

/**
 * Parses the Teleticket listing HTML and returns an array of RawEvents.
 *
 * HTML structure (as of 2026-03):
 *   <article class="filtr-item event-item col-6" id="event_N">
 *     <a href="/event-slug">
 *       <div class="aspect__inner">
 *         <img src="https://cdn.teleticket.com.pe/..." class="img--evento">
 *       </div>
 *       <div class="evento--box">
 *         <p class="descripcion text-truncate">
 *           <strong>VENUE NAME - CITY</strong> / Música
 *         </p>
 *         <h3 title="EVENT NAME">EVENT NAME</h3>
 *         <p class="fecha" v-html="getDate(['2026-05-24', '', ''])">...</p>
 *       </div>
 *     </a>
 *   </article>
 *
 * Returns [] if the HTML lacks the expected structure.
 */
function parseEvents(html: string): RawEvent[] {
  const events: RawEvent[] = [];
  const parts = html.split('<article');
  for (let i = 1; i < parts.length; i++) {
    const chunk = '<article' + parts[i];
    const hrefMatch  = chunk.match(/href="([^"]+)"/);
    const nameMatch  = chunk.match(/<h3[^>]*title="([^"]+)"/) ?? chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const imgMatch   = chunk.match(/class="[^"]*aspect__inner[^"]*"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
    const venueMatch = chunk.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    const ticketUrl  = normalizeTeleticketEventUrl(hrefMatch?.[1]);
    const parsedDate = parseTeleticketDate(chunk);
    const name = nameMatch?.[1] ? decodeHtml(nameMatch[1].trim()) : null;

    if (!name || !ticketUrl || !parsedDate) continue;

    events.push({
      name,
      ticket_url:  ticketUrl,
      cover_url:   imgMatch?.[1]   ?? null,
      venue:       venueMatch?.[1] ? decodeHtml(venueMatch[1].trim()) : null,
      date:        parsedDate.startsAt,
      start_time:  null,
      price_min:   null,
    });
  }
  return events;
}

// ─── Event detail scraper ─────────────────────────────────────────────────────
//
// Fetches a single event page and extracts start_time + price_min.
// Never throws — returns nulls on any failure.
//
// Time patterns handled:
//   "19:00"  "8:00 pm"  "8:00PM"  "20:30 hrs"  "20:30 h"
//
// Price patterns handled (Soles):
//   "S/ 120"  "S/120.00"  "S/ 80.50"  "desde S/ 80"
//   Multiple prices → lowest value is stored as price_min.

async function fetchEventDetail(ticketUrl: string): Promise<EventDetail> {
  let html: string;
  try {
    const res = await fetch(ticketUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; grub-scraper/1.0; +https://grub.app)" },
    });
    if (!res.ok) return { start_time: null, price_min: null };
    html = await res.text();
  } catch {
    return { start_time: null, price_min: null };
  }

  // ── start_time ────────────────────────────────────────────────────────────
  // Match HH:MM optionally followed by am/pm/hrs/h (case-insensitive).
  let start_time: string | null = null;
  const timeMatch = html.match(/\b(\d{1,2}):(\d{2})\s*(?:hrs?|am|pm)?/i);
  if (timeMatch) {
    let hours   = parseInt(timeMatch[1], 10);
    const mins  = timeMatch[2];
    // Detect am/pm suffix in the full match
    const suffix = (timeMatch[0].match(/[ap]m/i) ?? [])[0]?.toLowerCase();
    if (suffix === "pm" && hours < 12) hours += 12;
    if (suffix === "am" && hours === 12) hours = 0;
    start_time = `${String(hours).padStart(2, "0")}:${mins}:00`;
  }

  // ── price_min ─────────────────────────────────────────────────────────────
  // Collect all "S/ NNN" amounts; take the minimum.
  let price_min: number | null = null;
  const priceRe = /S\/\s*(\d+(?:\.\d{1,2})?)/gi;
  let m: RegExpExecArray | null;
  const prices: number[] = [];
  while ((m = priceRe.exec(html)) !== null) {
    prices.push(parseFloat(m[1]));
  }
  if (prices.length) price_min = Math.min(...prices);

  return { start_time, price_min };
}

// ─── Genre inference ─────────────────────────────────────────────────────────

/**
 * Infers Grub genre slugs from a scraped event name via keyword matching.
 * Teleticket has no classification API — name is the only signal available.
 */
function inferGenresScraper(event: RawEvent): string[] {
  const n = event.name.toLowerCase();
  const slugs = new Set<string>();

  const rules: [RegExp, string][] = [
    [/techno/,                         "techno"],
    [/house/,                          "house"],
    [/reggaet/,                        "reggaeton"],
    [/salsa/,                          "salsa"],
    [/cumbia/,                         "cumbia"],
    [/vallenato/,                      "vallenato"],
    [/bachata/,                        "bachata"],
    [/merengue/,                       "merengue"],
    [/rock|metal/,                     "rock"],
    [/hip[\s-]hop|rap\b/,             "hip-hop"],
    [/trap/,                           "trap"],
    [/r&b|r\s*&\s*b|rnb|r\'n\'b/,    "rnb"],
    [/soul/,                           "rnb"],
    [/\bindie\b/,                       "indie"],
    [/electro|edm|rave/,               "electronica"],
    [/latin[\s-]bass|bass\b/,         "latin-bass"],
    [/jazz/,                           "jazz"],
    [/blues/,                          "rock"],
    [/folk/,                           "alternativo"],
    [/flamenco/,                       "alternativo"],
    [/k[\s-]?pop|kpop/,               "kpop"],
    [/\bpop\b/,                        "pop"],
  ];

  for (const [re, slug] of rules) {
    if (re.test(n)) slugs.add(slug);
  }

  // No fallback — si no hay keyword clara, dejar sin género para que enrich-artists lo resuelva

  return [...slugs];
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
      .insert({ event_id: eventId, genre_id: genre.id });

    // Postgres unique-violation code: 23505 — treat as harmless (ON CONFLICT DO NOTHING)
    if (error && error.code !== "23505") {
      console.error(`[linkGenres] insert failed for slug "${slug}":`, error.message);
    }
  }
}

// ─── Non-musical event filter ────────────────────────────────────────────────

/**
 * Positive signals: if any of these appear in name or venue the event is
 * treated as musical unconditionally, overriding any NON_MUSIC_KEYWORDS hit.
 */
const MUSIC_SIGNALS = [
  "concierto", "concert",
  "tour", "world tour",
  " live", "live show", "en vivo",
  "dj set", "dj session",
  "festival",
  "banda", "band",
  "tributo", "tribute",
  "techno", "house", "reggaeton", "salsa", "cumbia",
  "hip-hop", "hip hop", "rap",
  "indie", "rock", "metal",
  "edm", "rave", "electronica",
  "reggae", "cumbia", "merengue",
];

const NON_MUSIC_KEYWORDS = [
  "estacionamiento",
  // Teatro
  "el musical", "teatro", "arlequin", "obra de", "obra", "comedia",
  // Humor
  "humor", "imitaciones", "stand up", "standup", "stand-up", "comico", "monólogo", "monologo",
  // Ballet / danza
  "ballet", "danza", "cisnes", "lago de los",
  // Clásica institucional
  "temporada de abono", "ciclo cuerdas", "sinfonia alla",
  "sinfonía alla", "temporada sinfonica", "temporada",
  "clásicos de", "clasicos de",
  // Infantil / familia
  "fiesta en la granja", "show infantil", "espectáculo infantil", "espectaculo infantil",
  // Variedades
  "magia", "circo",
];

/**
 * Returns false if the event is clearly non-musical based on keyword matching.
 *
 * Logic:
 *  1. If name or venue contains any MUSIC_SIGNAL → musical (no further checks).
 *  2. If name or venue contains any NON_MUSIC_KEYWORD → not musical.
 *  3. Otherwise → musical (default open).
 *
 * Non-musical events are still upserted but with is_active = false for manual review.
 */
function isMusicalEvent(name: string, venue: string): boolean {
  const haystack = `${name} ${venue}`.toLowerCase();

  if (MUSIC_SIGNALS.some(kw => haystack.includes(kw))) return true;
  if (NON_MUSIC_KEYWORDS.some(kw => haystack.includes(kw))) return false;

  return true;
}

// ─── Supabase upsert ─────────────────────────────────────────────────────────

async function upsertEvent(event: RawEvent): Promise<UpsertOutcome> {
  if (!isMusicalEvent(event.name, event.venue ?? "")) {
    console.warn(`[sync-teleticket] skipping non-musical event: ${event.name}`);
    return "failed";
  }

  const resolvedLocation = resolveEventLocation({
    rawVenue: event.venue,
    rawName: event.name,
  });
  const venue_id = resolvedLocation.venue
    ? await upsertVenue(supabase, {
        name: resolvedLocation.venue,
        city: resolvedLocation.city,
        country_code: resolvedLocation.country_code,
      })
    : null;

  const row: EventRow = {
    name:        stripTrailingCityFromEventName(event.name, resolvedLocation.city),
    date:        event.date,
    venue:       resolvedLocation.venue,
    venue_id,
    city:        resolvedLocation.city,
    country_code: resolvedLocation.country_code,
    ticket_url:  event.ticket_url,
    cover_url:   event.cover_url,
    price_min:   normalizeScrapedPrice(event.price_min),
    price_max:   null,
    start_time:  event.start_time,
    lineup:      [],
    description: null,
    is_active:   isMusicalEvent(event.name, event.venue ?? ""),
    source:      SOURCE,
  };

  try {
    // Check existence first so we can distinguish insert vs update.
    const { data: existing, error: selectError } = await supabase
      .from("events")
      .select("id, price_min, start_time, venue_id")
      .eq("ticket_url", row.ticket_url)
      .maybeSingle();

    if (selectError) {
      throw new Error(`SELECT failed for ${row.ticket_url}: ${selectError.message}`);
    }

    const isUpdate = existing !== null;

    const writeRow: EventRow = existing
      ? {
          ...row,
          price_min:  row.price_min  ?? existing.price_min,
          start_time: row.start_time ?? existing.start_time,
          venue_id:   row.venue_id   ?? existing.venue_id,
        }
      : row;

    const { data: upserted, error: upsertError } = await supabase
      .from("events")
      .upsert(writeRow, { onConflict: "ticket_url" })
      .select("id")
      .single();

    if (upsertError || !upserted) {
      throw new Error(`UPSERT failed for ${row.ticket_url}: ${upsertError?.message}`);
    }

    // Link genres (non-fatal: errors are logged inside linkGenres)
    const slugs = inferGenresScraper(event);
    if (slugs.length) {
      await linkGenres(upserted.id, slugs);
    }

    return isUpdate ? "updated" : "inserted";
  } catch (err) {
    console.error(`[sync-teleticket] upsertEvent error for ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Page processor ───────────────────────────────────────────────────────────

/** Scrapes one Teleticket listing page and upserts all events found. */
async function processPage(
  url: string,
  result: SyncResult,
): Promise<void> {
  const { html } = await fetchTeleticketPage(url);

  if (!html) {
    console.warn(`[sync-teleticket] empty response, skipping page: ${url}`);
    return;
  }

  const diagnostics = getListingDiagnostics(html);
  const events = parseEvents(html);

  console.log(
    `[sync-teleticket] ${url} → ${events.length} eventos parseados`,
    `(articles=${diagnostics.totalArticles}, paginatorPages=${diagnostics.paginatorPages})`,
  );

  // Enrich up to DETAIL_BATCH_LIMIT events with hour + price from their detail page.
  // Remaining events are upserted with nulls for those fields.
  const toEnrich = events.slice(0, DETAIL_BATCH_LIMIT);
  const rest     = events.slice(DETAIL_BATCH_LIMIT);

  for (const event of toEnrich) {
    const detail = await fetchEventDetail(event.ticket_url);
    event.start_time = detail.start_time;
    event.price_min  = detail.price_min;
    await sleep(DETAIL_THROTTLE_MS);

    const outcome = await upsertEvent(event);
    result[outcome] += 1;
  }

  for (const event of rest) {
    const outcome = await upsertEvent(event);
    result[outcome] += 1;
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function run(): Promise<SyncResult> {
  const result: SyncResult = { inserted: 0, updated: 0, failed: 0 };

  console.log(`[sync-teleticket] version=${SCRAPER_VERSION}`);

  await processPage(TELETICKET_BASE_URL, result);

  console.log(
    `Sync completo — inserted: ${result.inserted}, updated: ${result.updated}, failed: ${result.failed}`,
  );

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
    const result = await run();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sync-teleticket]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ─── DEPLOY ───────────────────────────────────────────────────────────────────
//
// supabase functions deploy sync-teleticket --no-verify-jwt
//
// VARIABLES DE ENTORNO: ninguna adicional, usa las mismas de Supabase
// (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son inyectadas automáticamente)
//
// CRON — correr 30 minutos después que sync-ticketmaster (8:30am UTC):
// SELECT cron.schedule(
//   'sync-teleticket-daily',
//   '30 8 * * *',
//   $$
//   SELECT net.http_post(
//     url     := current_setting('app.supabase_url') || '/functions/v1/sync-teleticket',
//     headers := jsonb_build_object(
//       'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
//       'Content-Type',  'application/json'
//     ),
//     body    := '{}'::jsonb
//   )
//   $$
// );
//
// CURL DE PRUEBA:
// curl -X POST https://TU_PROJECT_REF.supabase.co/functions/v1/sync-teleticket \
//   -H "Authorization: Bearer TU_ANON_KEY" \
//   -H "Content-Type: application/json"
//
// NOTA: Si el parsing falla porque Teleticket cambió su HTML,
// revisar los selectores en parseEvents() con las DevTools del browser
// (inspeccionar elemento en teleticket.com.pe/conciertos)

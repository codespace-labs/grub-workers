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

const LISTING_URL    = "https://www.ticketmaster.pe/page/categoria-conciertos";
const EVENT_BASE_URL = "https://www.ticketmaster.pe/event";
const SOURCE         = "ticketmaster";
const SCRAPER_VERSION = "2026-03-18.4";
const MIN_VALID_PRICE_PEN = 30;
const DETAIL_THROTTLE_MS = 350;

// ─── Types ────────────────────────────────────────────────────────────────────

type UpsertOutcome = "inserted" | "updated" | "failed";

interface SyncResult {
  inserted: number;
  updated:  number;
  failed:   number;
}

interface RawEvent {
  name:          string;
  date:          string | null;
  venue:         string | null;
  ticket_url:    string;
  cover_url:     string | null;
  price_min:     number | null;
  start_time:    string | null;
  external_slug: string | null;
}

interface EventRow {
  name:          string;
  date:          string | null;
  venue:         string | null;
  venue_id:      string | null;
  city:          string;
  country_code:  string;
  ticket_url:    string;
  cover_url:     string | null;
  price_min:     number | null;
  price_max:     null;
  start_time:    string | null;
  lineup:        string[];
  description:   null;
  is_active:     boolean;
  source:        string;
  external_slug: string | null;
}

// ─── HTML helper ──────────────────────────────────────────────────────────────

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&nbsp;/g, " ")
    .trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function normalizeScrapedPrice(value: number | null): number | null {
  if (value == null) return null;
  return value >= MIN_VALID_PRICE_PEN ? value : null;
}

// ─── Date / time parser ───────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

function normalizeSpanishText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses a Spanish date+time string from the ticketmaster.pe listing span, e.g.:
 *   "Sábado 21 de Marzo - 08:00pm"
 *   "Miercoles 20 de Mayo - 8:30 pm"
 *   "Miércoles 18 de Marzo - 08:00pm"
 *
 * Returns ISO date string "YYYY-MM-DD" and "HH:MM:SS" time.
 * If the inferred date has already passed and no year was explicit, rolls to next year.
 */
function parseSpanishDateSpan(
  raw: string,
): { date: string | null; start_time: string | null } {
  const s = normalizeSpanishText(raw);

  // ── date ─────────────────────────────────────────────────────────────────────
  // Patterns:
  //   "21 de marzo"  "21 de marzo de 2026"
  //   "21 marzo 2026"
  //   "21/03/2026"   "21-03-2026"
  let date: string | null = null;
  let day: number | null = null;
  let monthNo: number | null = null;
  let year: number | null = null;

  const longDateMatch = s.match(/(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/);
  const shortDateMatch = s.match(/(\d{1,2})\s+([a-z]{3,10})(?:\s+(\d{4}))?/);
  const numericDateMatch = s.match(/(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?/);

  if (longDateMatch) {
    day = parseInt(longDateMatch[1], 10);
    monthNo = MONTHS[longDateMatch[2]] ?? null;
    year = longDateMatch[3] ? parseInt(longDateMatch[3], 10) : null;
  } else if (shortDateMatch) {
    day = parseInt(shortDateMatch[1], 10);
    monthNo = MONTHS[shortDateMatch[2]] ?? null;
    year = shortDateMatch[3] ? parseInt(shortDateMatch[3], 10) : null;
  } else if (numericDateMatch) {
    day = parseInt(numericDateMatch[1], 10);
    monthNo = parseInt(numericDateMatch[2], 10);
    year = numericDateMatch[3]
      ? parseInt(numericDateMatch[3].length === 2 ? `20${numericDateMatch[3]}` : numericDateMatch[3], 10)
      : null;
  }

  if (day && monthNo) {
    let resolvedYear = year ?? new Date().getFullYear();
    if (!year && new Date(resolvedYear, monthNo - 1, day) < new Date()) {
      resolvedYear += 1;
    }
    date = `${resolvedYear}-${String(monthNo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // ── time ─────────────────────────────────────────────────────────────────────
  // Patterns: "8:30 pm"  "08:00pm"  "9:00p.m."  "20:30"  "8pm"
  let start_time: string | null = null;
  const timeMatch = s.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/);

  if (timeMatch) {
    let h    = parseInt(timeMatch[1], 10);
    const m  = timeMatch[2] ?? "00";
    const ap = timeMatch[3]?.replace(/\./g, "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    start_time = `${String(h).padStart(2, "0")}:${m}:00`;
  }

  return { date, start_time };
}

// ─── Sørensen-Dice similarity ────────────────────────────────────────────────
//
// Ported from grub-scraper-dashboard.html (same algorithm, same threshold).
// Used to detect cross-source duplicates: same concert listed by both the
// Ticketmaster API (source: ticketmaster) and the ticketmaster.pe scraper.

function bigrams(str: string): Set<string> {
  const s = str.toLowerCase().replace(/\s+/g, " ").trim();
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}

/** Returns "YYYY-MM-DD" shifted by `days` from an ISO date string. */
function shiftDate(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Cross-source duplicate detection ────────────────────────────────────────

interface DuplicateCandidate {
  id:         string;
  name:       string;
  cover_url:  string | null;
  price_min:  number | null;
  start_time: string | null;
  venue:      string | null;
}

/**
 * Checks whether an event already exists in the DB from a different source
 * (e.g. imported via the Ticketmaster API) with:
 *   • date within ±1 day of `event.date`
 *   • Sørensen-Dice name similarity > 0.8
 *
 * Returns the best-matching candidate, or null if none found.
 */
async function findCrossSourceDuplicate(
  event: RawEvent,
): Promise<DuplicateCandidate | null> {
  if (!event.date) return null;

  const dateMin = shiftDate(event.date, -1);
  const dateMax = shiftDate(event.date,  1);

  const { data: candidates, error } = await supabase
    .from("events")
    .select("id, name, cover_url, price_min, start_time, venue")
    .neq("source", SOURCE)
    .gte("date", dateMin)
    .lte("date", dateMax + "T23:59:59.999Z");

  if (error) {
    console.error("[findCrossSourceDuplicate] query error:", error.message);
    return null;
  }

  if (!candidates?.length) return null;

  let bestScore  = 0;
  let bestMatch: DuplicateCandidate | null = null;

  for (const c of candidates) {
    const score = dice(event.name, c.name as string);
    if (score > 0.8 && score > bestScore) {
      bestScore = score;
      bestMatch = c as DuplicateCandidate;
    }
  }

  if (bestMatch) {
    console.log(
      `[sync-ticketmaster-pe] duplicate found: "${event.name}" ≈ "${bestMatch.name}"`,
      `(Dice=${bestScore.toFixed(2)}) — patching id=${bestMatch.id}`,
    );
  }

  return bestMatch;
}

/**
 * Patches only the fields that are null in the existing DB record but have
 * a value in the incoming scraped event (cover_url, price_min, start_time, venue).
 * Never overwrites data that is already present.
 */
async function patchMissingFields(
  existingId: string,
  event:      RawEvent,
): Promise<void> {
  const { data: row, error } = await supabase
    .from("events")
    .select("cover_url, price_min, start_time, venue")
    .eq("id", existingId)
    .single();

  if (error || !row) {
    console.error("[patchMissingFields] fetch error:", error?.message);
    return;
  }

  const patch: Record<string, unknown> = {};
  if (!row.cover_url  && event.cover_url)  patch.cover_url  = event.cover_url;
  if (!row.price_min  && event.price_min)  patch.price_min  = event.price_min;
  if (!row.start_time && event.start_time) patch.start_time = event.start_time;
  if (!row.venue      && event.venue)      patch.venue      = event.venue;

  if (Object.keys(patch).length === 0) return;

  const { error: updateErr } = await supabase
    .from("events")
    .update(patch)
    .eq("id", existingId);

  if (updateErr) {
    console.error("[patchMissingFields] update error:", updateErr.message);
  }
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

async function fetchListing(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (compatible; grub-scraper/1.0; +https://grub.app)",
        "Accept":          "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-PE,es;q=0.9,en;q=0.7",
      },
    });
    if (!res.ok) {
      console.error(`[sync-ticketmaster-pe] HTTP ${res.status} ${res.statusText} — ${url}`);
      return "";
    }
    return await res.text();
  } catch (err) {
    console.error("[sync-ticketmaster-pe] network error:", err);
    return "";
  }
}

function parseDateTimeFromHtml(html: string): { date: string | null; start_time: string | null } {
  const text = normalizeSpanishText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );

  const candidates = [
    ...text.matchAll(/\b\d{1,2}\s+de\s+[a-z]{3,10}(?:\s+de\s+\d{4})?(?:\s*[-|]\s*\d{1,2}(?::\d{2})?\s*[ap]?\s*\.?m?\.?)?/g),
    ...text.matchAll(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?(?:\s+\d{1,2}(?::\d{2})?\s*[ap]?\s*\.?m?\.?)?/g),
  ];

  for (const match of candidates) {
    const parsed = parseSpanishDateSpan(match[0]);
    if (parsed.date) return parsed;
  }

  return { date: null, start_time: null };
}

async function fetchEventDetail(ticketUrl: string): Promise<{ price_min: number | null; date: string | null; start_time: string | null }> {
  try {
    const res = await fetch(ticketUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; grub-scraper/1.0; +https://grub.app)",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-PE,es;q=0.9,en;q=0.7",
      },
    });

    if (!res.ok) return { price_min: null, date: null, start_time: null };

    const html = await res.text();
    const parsedDateTime = parseDateTimeFromHtml(html);
    const prices: number[] = [];
    const priceRe = /S\/\s*(\d+(?:[.,]\d{1,2})?)/gi;
    let match: RegExpExecArray | null;

    while ((match = priceRe.exec(html)) !== null) {
      prices.push(parseFloat(match[1].replace(",", ".")));
    }

    return {
      price_min: prices.length ? Math.min(...prices) : null,
      date: parsedDateTime.date,
      start_time: parsedDateTime.start_time,
    };
  } catch {
    return { price_min: null, date: null, start_time: null };
  }
}

/**
 * Parses the ticketmaster.pe listing HTML.
 *
 * HTML structure per event card (as of 2026-03):
 *
 *   <div role="listitem" class="grid_element">
 *     <a href='../event/{slug}'>
 *       <div class="image">
 *         <picture>
 *           <img src="https://cdn.getcrowder.com/images/..." alt="{name}">
 *         </picture>
 *       </div>
 *       <div class="information">
 *         <div class="details">
 *           <div class="item_title">{name}</div>
 *           <strong>{venue}</strong>
 *           <span>{fecha, ej: "Sábado 21 de Marzo - 08:00pm"}</span>
 *         </div>
 *       </div>
 *     </a>
 *   </div>
 */
function parseEvents(html: string): RawEvent[] {
  const events: RawEvent[] = [];
  const seen = new Set<string>();

  const parts = html.split('class="grid_element"');

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];

    // ── ticket_url ────────────────────────────────────────────────────────────
    // href='../event/some-slug'  or  href="../event/some-slug"
    const hrefMatch = chunk.match(/href=['"]\.\.\/(event\/[^'"]+)['"]/);
    if (!hrefMatch) continue;
    const slug       = hrefMatch[1].trim();
    const ticket_url = `${EVENT_BASE_URL}/${slug.replace(/^event\//, "")}`;

    // external_slug: la parte final de la URL, ej: "yuri-iconica-tour"
    const external_slug = slug.replace(/^event\//, "");

    // deduplicate (featured section repeats some events)
    if (seen.has(ticket_url)) continue;
    seen.add(ticket_url);

    // ── cover_url ─────────────────────────────────────────────────────────────
    const imgMatch  = chunk.match(/<img[^>]+src="([^"]+)"/);
    const cover_url = imgMatch?.[1] ?? null;

    // ── name ──────────────────────────────────────────────────────────────────
    const titleMatch = chunk.match(/class="item_title"[^>]*>([\s\S]*?)<\/div>/);
    const altMatch   = imgMatch
      ? imgMatch[0].match(/alt='([^']*)'/)
      : null;
    const rawName = titleMatch?.[1] ?? altMatch?.[1] ?? null;
    if (!rawName) continue;
    const name = decodeHtml(rawName);

    // ── venue ─────────────────────────────────────────────────────────────────
    const venueMatch = chunk.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    const venue      = venueMatch?.[1] ? decodeHtml(venueMatch[1]) : null;

    // ── date + start_time ─────────────────────────────────────────────────────
    // First <span> inside the chunk holds the date+time text
    const spanMatch      = chunk.match(/<span[^>]*>([\s\S]*?)<\/span>/);
    const dateTimeRaw    = spanMatch?.[1] ? decodeHtml(spanMatch[1]) : null;
    const { date, start_time } = dateTimeRaw
      ? parseSpanishDateSpan(dateTimeRaw)
      : { date: null, start_time: null };

    events.push({ name, date, venue, ticket_url, cover_url, price_min: null, start_time, external_slug });
  }

  return events;
}

// ─── Genre inference ──────────────────────────────────────────────────────────

function inferGenresScraper(event: RawEvent): string[] {
  const n = event.name.toLowerCase();
  const slugs = new Set<string>();

  const rules: [RegExp, string][] = [
    [/techno/,                      "techno"],
    [/house/,                       "house"],
    [/reggaet/,                     "reggaeton"],
    [/salsa/,                       "salsa"],
    [/cumbia/,                      "cumbia"],
    [/vallenato/,                   "vallenato"],
    [/bachata/,                     "bachata"],
    [/merengue/,                    "merengue"],
    [/rock|metal/,                  "rock"],
    [/hip[\s-]hop|rap\b/,          "hip-hop"],
    [/trap/,                        "trap"],
    [/r&b|r\s*&\s*b|rnb|r'n'b/,   "rnb"],
    [/soul/,                        "rnb"],
    [/\bindie\b/,                   "indie"],
    [/electro|edm|rave|circoloco|creamfields|awakenings|ultra\b/,   "electronica"],
    [/latin[\s-]bass|bass\b/,      "latin-bass"],
    [/jazz/,                        "jazz"],
    [/blues/,                       "rock"],
    [/folk/,                        "alternativo"],
    [/flamenco/,                    "alternativo"],
    [/k[\s-]?pop|kpop/,            "kpop"],
    [/\bpop\b/,                     "pop"],
  ];

  for (const [re, slug] of rules) {
    if (re.test(n)) slugs.add(slug);
  }

  // No fallback — si no hay keyword clara, dejar sin género para que enrich-artists lo resuelva

  return [...slugs];
}

// ─── Genre linking ────────────────────────────────────────────────────────────

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

    // 23505 = unique_violation — harmless (already linked)
    if (error && error.code !== "23505") {
      console.error(`[linkGenres] insert failed for slug "${slug}":`, error.message);
    }
  }
}

// ─── Non-musical event filter ─────────────────────────────────────────────────

const MUSIC_SIGNALS = [
  "concierto", "concert", "tour", "world tour",
  " live", "live show", "en vivo",
  "dj set", "dj session", "festival",
  "banda", "band", "tributo", "tribute",
  "techno", "house", "reggaeton", "salsa", "cumbia",
  "hip-hop", "hip hop", "rap", "indie", "rock", "metal",
  "edm", "rave", "electronica", "reggae", "merengue",
];

const NON_MUSIC_KEYWORDS = [
  "estacionamiento",
  "parking",
  "puntos de venta",
  "centro de ayuda",
];

function isMusicalEvent(name: string, venue: string): boolean {
  const haystack = `${name} ${venue}`.toLowerCase();
  const normalizedName = normalizeSpanishText(name);
  if (MUSIC_SIGNALS.some((kw) => haystack.includes(kw))) return true;
  if (NON_MUSIC_KEYWORDS.some((kw) => normalizedName.includes(kw))) return false;
  return true;
}

// ─── Supabase upsert ──────────────────────────────────────────────────────────

async function upsertEvent(event: RawEvent): Promise<UpsertOutcome> {
  if (!event.date) {
    console.warn(`[sync-ticketmaster-pe] skipping "${event.name}" — no date parsed`);
    return "failed";
  }

  if (!isMusicalEvent(event.name, event.venue ?? "")) {
    console.warn(`[sync-ticketmaster-pe] skipping non-musical event: ${event.name}`);
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
    name:          stripTrailingCityFromEventName(event.name, resolvedLocation.city),
    date:          event.date,
    venue:         resolvedLocation.venue,
    venue_id,
    city:          resolvedLocation.city,
    country_code:  resolvedLocation.country_code,
    ticket_url:    event.ticket_url,
    cover_url:     event.cover_url,
    price_min:     normalizeScrapedPrice(event.price_min),
    price_max:     null,
    start_time:    event.start_time,
    lineup:        [],
    description:   null,
    is_active:     isMusicalEvent(event.name, event.venue ?? ""),
    source:        SOURCE,
    external_slug: event.external_slug,
  };

  try {
    // ── Step 1: dedup por external_slug (detecta mismo evento desde API y scraper) ──
    let existing: {
      id: string;
      ticket_url: string | null;
      price_min: number | null;
      start_time: string | null;
      venue_id: string | null;
    } | null = null;

    if (event.external_slug) {
      const { data } = await supabase
        .from("events")
        .select("id, ticket_url, price_min, start_time, venue_id")
        .eq("external_slug", event.external_slug)
        .maybeSingle();
      existing = data;
    }

    // ── Step 2: fallback dedup por ticket_url ────────────────────────────────
    if (!existing) {
      const { data, error: selectErr } = await supabase
        .from("events")
        .select("id, ticket_url, price_min, start_time, venue_id")
        .eq("ticket_url", row.ticket_url)
        .maybeSingle();
      if (selectErr) throw new Error(`SELECT: ${selectErr.message}`);
      existing = data;
    }

    if (existing) {
      const writeRow: EventRow = {
        ...row,
        price_min: row.price_min ?? existing.price_min,
        start_time: row.start_time ?? existing.start_time,
        venue_id: row.venue_id ?? existing.venue_id,
      };

      const { data: updated, error: updateErr } = await supabase
        .from("events")
        .update(writeRow)
        .eq("id", existing.id)
        .select("id")
        .single();

      if (updateErr || !updated) throw new Error(`UPDATE: ${updateErr?.message}`);

      const slugs = inferGenresScraper(event);
      if (slugs.length) await linkGenres(updated.id, slugs);

      return "updated";
    }

    // ── Step 3: cross-source dedup (Sørensen-Dice ± 1 day) ──────────────────
    // The same concert may already be in the DB from the Ticketmaster API
    // (source: "ticketmaster"). If so, patch missing fields rather than insert.
    const dup = await findCrossSourceDuplicate(event);

    if (dup) {
      await patchMissingFields(dup.id, event);
      const slugs = inferGenresScraper(event);
      if (slugs.length) await linkGenres(dup.id, slugs);
      return "updated";
    }

    // ── Step 3: genuine new event — insert ───────────────────────────────────
    const { data: inserted, error: insertErr } = await supabase
      .from("events")
      .upsert(row, { onConflict: "ticket_url" })
      .select("id")
      .single();

    if (insertErr || !inserted) throw new Error(`INSERT: ${insertErr?.message}`);

    const slugs = inferGenresScraper(event);
    if (slugs.length) await linkGenres(inserted.id, slugs);

    return "inserted";
  } catch (err) {
    console.error(`[sync-ticketmaster-pe] upsertEvent error for ${event.ticket_url}:`, err);
    return "failed";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<SyncResult> {
  const result: SyncResult = { inserted: 0, updated: 0, failed: 0 };

  console.log(`[sync-ticketmaster-pe] version=${SCRAPER_VERSION}`);

  const html   = await fetchListing(LISTING_URL);
  const events = parseEvents(html);

  console.log(`[sync-ticketmaster-pe] parsed ${events.length} events`);

  for (const event of events) {
    if (event.price_min == null || !event.date || !event.start_time) {
      const detail = await fetchEventDetail(event.ticket_url);
      event.price_min = detail.price_min ?? event.price_min;
      event.date = event.date ?? detail.date;
      event.start_time = event.start_time ?? detail.start_time;
      await sleep(DETAIL_THROTTLE_MS);
    }

    const outcome = await upsertEvent(event);
    result[outcome] += 1;
  }

  console.log(
    `[sync-ticketmaster-pe] done — inserted: ${result.inserted},`,
    `updated: ${result.updated}, failed: ${result.failed}`,
  );

  return result;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status:  405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await run();
    return new Response(JSON.stringify(result), {
      status:  200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sync-ticketmaster-pe]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ─── DEPLOY ───────────────────────────────────────────────────────────────────
//
// supabase functions deploy sync-ticketmaster-pe --no-verify-jwt
//
// CURL DE PRUEBA:
// curl -X POST https://xmdoaikmmhdzdzxovwzn.supabase.co/functions/v1/sync-ticketmaster-pe \
//   -H "Authorization: Bearer TU_ANON_KEY" \
//   -H "Content-Type: application/json"
//
// NOTA: Si el parsing falla porque ticketmaster.pe cambió su HTML,
// revisar parseEvents() con DevTools en:
//   https://www.ticketmaster.pe/page/categoria-conciertos
// Inspeccionar elementos con class="grid_element", "item_title", etc.

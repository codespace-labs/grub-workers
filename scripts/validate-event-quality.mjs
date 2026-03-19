import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function readEnvFile() {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
    return Object.fromEntries(
      raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const idx = line.indexOf("=");
          return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const localEnv = readEnvFile();

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  localEnv.SUPABASE_URL ||
  localEnv.EXPO_PUBLIC_SUPABASE_URL ||
  "https://xmdoaikmmhdzdzxovwzn.supabase.co";

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  localEnv.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  localEnv.SUPABASE_ANON_KEY ||
  localEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL3htZG9haWttbWhkemR6eG92d3puLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJyZWYiOiJ4bWRvYWlrbW1oZHpkenhvdnd6biIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzczMTE3OTkzLCJleHAiOjIwODg2OTM5OTN9.86lVHb9Y_YE_dIrvO07fnErGvFyuZMORpCVJhJlDqmg";

const PAGE_SIZE = 1000;
const STRICT = process.argv.includes("--strict");

function normalizeText(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasVisibleVenue(event) {
  const venue = normalizeText(event.venue);
  return !!venue && venue !== "-" && venue !== "por anunciar";
}

const GENRE_SIGNAL_RULES = [
  { slug: "techno", patterns: [/\btechno\b/] },
  { slug: "house", patterns: [/\bhouse\b/, /\btech house\b/, /\bdeep house\b/] },
  { slug: "reggaeton", patterns: [/reggaet/] },
  { slug: "salsa", patterns: [/\bsalsa\b/] },
  { slug: "cumbia", patterns: [/\bcumbia\b/] },
  { slug: "rock", patterns: [/\brock\b/, /\bgrunge\b/] },
  { slug: "metal", patterns: [/\bmetal\b/, /\bdeathcore\b/, /\bdeath metal\b/] },
  { slug: "hip-hop", patterns: [/\bhip[\s-]?hop\b/, /\brap\b/] },
  { slug: "trap", patterns: [/\btrap\b/] },
  { slug: "indie", patterns: [/\bindie\b/] },
  { slug: "electronica", patterns: [/\belectro\b/, /\bedm\b/, /\brave\b/, /\belectronica\b/] },
  { slug: "pop", patterns: [/\bpop\b/] },
  { slug: "kpop", patterns: [/\bk[\s-]?pop\b/] },
  { slug: "jazz", patterns: [/\bjazz\b/] },
  { slug: "clasica", patterns: [/\bclasica\b/, /\bclasico\b/, /\bsinfonic/, /\borquesta\b/, /\bfilarmonic/] },
  { slug: "folklore", patterns: [/\bfolklore\b/, /\bcriollo\b/, /\bandino\b/] },
];

function inferGenreSignals(name) {
  const normalized = normalizeText(name);
  const slugs = new Set();

  for (const rule of GENRE_SIGNAL_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      slugs.add(rule.slug);
    }
  }

  return [...slugs];
}

function getGenreQualityIssues(event) {
  const signals = inferGenreSignals(event.name);
  if (!signals.length) return [];
  if (!event.genres.length) return ["missing-genre"];
  if (!signals.some((slug) => event.genres.includes(slug))) return ["genre-mismatch"];
  return [];
}

function hasLocationLeakInTitle(event) {
  const city = (event.city || "").trim();
  const name = (event.name || "").trim();
  if (!city || !name) return false;

  const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\s+-\\s*${escapedCity}\\s*$`, "i"),
    new RegExp(`\\s+en\\s+${escapedCity}\\s*$`, "i"),
    new RegExp(`\\s*\\(${escapedCity}\\)\\s*$`, "i"),
  ];

  return patterns.some((pattern) => pattern.test(name));
}

async function fetchAllEvents() {
  let offset = 0;
  const allEvents = [];

  while (true) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/events`);
    url.searchParams.set(
      "select",
      "id,name,date,venue,city,country_code,source,ticket_url,event_genres(genres(slug))",
    );
    url.searchParams.set("order", "date.asc.nullslast");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));

    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Supabase REST ${res.status} ${res.statusText}`);
    }

    const batch = await res.json();
    allEvents.push(
      ...batch.map((event) => ({
        ...event,
        genres: (event.event_genres || []).map((row) => row.genres?.slug).filter(Boolean),
      })),
    );

    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allEvents;
}

function printExamples(title, rows) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  rows.slice(0, 15).forEach((row) => {
    console.log(
      `- ${row.name} | city=${row.city || "—"} | venue=${row.venue || "—"} | genres=${row.genres.join(", ") || "—"}`,
    );
  });
}

async function main() {
  const events = await fetchAllEvents();
  const missingGenre = events.filter((event) => !event.genres.length);
  const genreIssues = events.filter((event) => getGenreQualityIssues(event).length > 0);
  const titleLocation = events.filter(hasLocationLeakInTitle);
  const noVenue = events.filter((event) => !hasVisibleVenue(event));

  console.log(`[validate-event-quality] total=${events.length}`);
  console.log(`[validate-event-quality] missingGenre=${missingGenre.length}`);
  console.log(`[validate-event-quality] genreIssues=${genreIssues.length}`);
  console.log(`[validate-event-quality] titleLocation=${titleLocation.length}`);
  console.log(`[validate-event-quality] noVisibleVenue=${noVenue.length}`);

  printExamples("Eventos con género dudoso", genreIssues);
  printExamples("Eventos con ciudad pegada al título", titleLocation);
  printExamples("Eventos sin venue visible", noVenue);

  if (STRICT && (genreIssues.length || titleLocation.length)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[validate-event-quality] error:", error.message);
  process.exitCode = 1;
});

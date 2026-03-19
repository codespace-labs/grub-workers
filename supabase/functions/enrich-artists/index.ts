import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Env ──────────────────────────────────────────────────────────────────────

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// ─── Constants ────────────────────────────────────────────────────────────────

const MB_BASE       = "https://musicbrainz.org/ws/2";
const MB_USER_AGENT = "Grub/1.0 (sthefanyflorianog@gmail.com)";
const RATE_LIMIT_MS = 1100;
const BATCH_SIZE    = 50;
const MIN_SCORE     = 70;

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrichResult {
  enriched:  number;
  skipped:   number;
  failed:    number;
  no_match:  number;
}

interface ArtistRow {
  id:        string;
  name:      string;
  photo_url: string | null;
}

// ── MusicBrainz response shapes ───────────────────────────────────────────────

interface MbTag {
  name:  string;
  count: number;
}

interface MbArtistSearchResult {
  id:    string;
  score: number;
  name:  string;
  tags?: MbTag[];
}

interface MbSearchResponse {
  artists: MbArtistSearchResult[];
}

interface MbUrlRelation {
  type: string;
  url:  { resource: string };
}

interface MbArtistLookup {
  id:         string;
  relations?: MbUrlRelation[];
}

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mbFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": MB_USER_AGENT } });
  if (!res.ok) {
    throw new Error(`MusicBrainz ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json() as Promise<T>;
}

// ─── MusicBrainz: search ─────────────────────────────────────────────────────

async function searchArtist(name: string): Promise<MbArtistSearchResult | null> {
  const query = encodeURIComponent(`artist:${name}`);
  const url   = `${MB_BASE}/artist?query=${query}&fmt=json&limit=1`;
  const data  = await mbFetch<MbSearchResponse>(url);
  const artist = data.artists?.[0];
  if (!artist || artist.score < MIN_SCORE) return null;
  return artist;
}

// ─── MusicBrainz: photo via url-rels ─────────────────────────────────────────
//
// Attempts to extract a Wikimedia Commons image URL from the artist's
// URL relations. Returns null if no image relation is found.
//
// Wikimedia Commons page URL:
//   https://commons.wikimedia.org/wiki/File:Foo.jpg
// is converted to a direct-download URL:
//   https://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg

async function lookupArtistPhoto(mbid: string): Promise<string | null> {
  const url  = `${MB_BASE}/artist/${mbid}?inc=url-rels&fmt=json`;
  const data = await mbFetch<MbArtistLookup>(url);

  const imageRel = data.relations?.find(
    (r) => r.type === "image" && r.url?.resource?.includes("wikimedia.org"),
  );
  if (!imageRel) return null;

  const fileMatch = imageRel.url.resource.match(/\/wiki\/File:(.+)$/);
  if (!fileMatch) return null;

  return `https://commons.wikimedia.org/wiki/Special:FilePath/${fileMatch[1]}`;
}

// ─── Genre tag → slug mapping ─────────────────────────────────────────────────
//
// MusicBrainz tags are verbose ("heavy metal", "indie pop", "latin pop", etc.)
// This map normalises them to Grub's genre slugs.
// Tags not matched here are silently skipped.

const MB_TAG_MAP: Record<string, string> = {
  // Rock
  "rock": "rock", "classic rock": "rock", "hard rock": "rock",
  "alternative rock": "rock", "progressive rock": "rock",
  "punk rock": "rock", "punk": "rock", "post-punk": "rock",
  "new wave": "rock", "grunge": "rock", "garage rock": "rock",
  "psychedelic rock": "rock", "folk rock": "rock",
  // Metal
  "metal": "metal", "heavy metal": "metal", "thrash metal": "metal",
  "death metal": "metal", "black metal": "metal", "power metal": "metal",
  "progressive metal": "metal", "nu metal": "metal", "doom metal": "metal",
  "symphonic metal": "metal", "gothic metal": "metal",
  // Pop
  "pop": "pop", "dance pop": "pop", "synth-pop": "pop", "synthpop": "pop",
  "electropop": "pop", "teen pop": "pop", "chamber pop": "pop",
  "baroque pop": "pop", "art pop": "pop",
  // Pop Latino
  "latin pop": "pop-latino", "latin": "pop-latino", "latin rock": "pop-latino",
  "spanish pop": "pop-latino", "flamenco pop": "pop-latino",
  // Balada
  "ballad": "balada", "soft rock": "balada", "adult contemporary": "balada",
  "romantic": "balada",
  // Reggaeton
  "reggaeton": "reggaeton", "reggeaton": "reggaeton",
  // Trap
  "trap": "trap", "trap latino": "trap", "urban": "trap",
  "latin trap": "trap",
  // Hip-hop
  "hip-hop": "hip-hop", "hip hop": "hip-hop", "rap": "hip-hop",
  "conscious hip hop": "hip-hop", "east coast hip hop": "hip-hop",
  // R&B
  "r&b": "rnb", "rhythm and blues": "rnb", "neo soul": "rnb",
  "soul": "rnb", "funk": "rnb",
  // Electrónica
  "electronic": "electronica", "electronica": "electronica",
  "electronic music": "electronica", "edm": "electronica",
  "ambient": "electronica", "downtempo": "electronica",
  "idm": "electronica", "breakbeat": "electronica",
  // Techno
  "techno": "techno", "industrial": "techno", "ebm": "techno",
  // House
  "house": "house", "deep house": "house", "tech house": "house",
  "progressive house": "house", "disco": "house",
  // Indie
  "indie": "indie", "indie pop": "indie", "indie rock": "indie",
  "lo-fi": "indie", "dream pop": "indie", "shoegaze": "indie",
  "alternative": "indie", "alternative music": "indie",
  // Salsa
  "salsa": "salsa", "tropical": "salsa", "son cubano": "salsa",
  "bolero": "salsa", "mambo": "salsa", "merengue": "salsa",
  // Cumbia
  "cumbia": "cumbia", "cumbia andina": "cumbia-andina",
  "chicha": "cumbia-andina", "huayno": "folklore",
  "andean music": "folklore", "andean": "folklore",
  // Cumbia andina
  "cumbia andina": "cumbia-andina", "peruvian cumbia": "cumbia-andina",
  // Latin bass
  "latin bass": "latin-bass", "dembow": "latin-bass",
  // K-Pop
  "k-pop": "kpop", "kpop": "kpop", "korean pop": "kpop",
  // Jazz
  "jazz": "jazz", "jazz fusion": "jazz", "smooth jazz": "jazz",
  "latin jazz": "jazz", "bossa nova": "jazz",
  // Clásica
  "classical": "clasica", "classical music": "clasica",
  "opera": "clasica", "orchestral": "clasica", "symphony": "clasica",
  "chamber music": "clasica",
  // Folklore
  "folk": "folklore", "folklore": "folklore", "world music": "folklore",
  "afrobeat": "folklore", "flamenco": "folklore",
  // Alternativo
  "alternative": "alternativo", "post-rock": "alternativo",
  "math rock": "alternativo", "emo": "alternativo",
};

function tagToSlug(tag: string): string | null {
  return MB_TAG_MAP[tag.toLowerCase().trim()] ?? null;
}

// ─── Genre linking ────────────────────────────────────────────────────────────

async function linkArtistGenres(artistId: string, tags: MbTag[]): Promise<void> {
  const slugsSeen = new Set<string>();

  for (const tag of tags) {
    const slug = tagToSlug(tag.name);
    if (!slug || slugsSeen.has(slug)) continue;
    slugsSeen.add(slug);

    const { data: genre } = await supabase
      .from("genres")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (!genre) continue;

    const { error } = await supabase
      .from("artist_genres")
      .insert({ artist_id: artistId, genre_id: genre.id });

    if (error && error.code !== "23505") {
      console.warn(
        `[enrich-artists] artist_genres insert failed for artist=${artistId} slug="${slug}":`,
        error.message,
      );
    }
  }
}

// ─── Per-artist enrichment ────────────────────────────────────────────────────

async function enrichArtist(artist: ArtistRow, result: EnrichResult): Promise<void> {
  if (!artist.name.trim()) {
    result.skipped++;
    return;
  }

  // 1. Search MusicBrainz ── always followed by a rate-limit pause
  let mbArtist: MbArtistSearchResult | null;
  try {
    mbArtist = await searchArtist(artist.name);
  } catch (err) {
    console.error(`[enrich-artists] search failed for "${artist.name}":`, err);
    result.failed++;
    await sleep(RATE_LIMIT_MS);
    return;
  }
  await sleep(RATE_LIMIT_MS);

  if (!mbArtist) {
    console.log(`[enrich-artists] no match for "${artist.name}"`);
    result.no_match++;
    return;
  }

  // 2. Photo lookup (only when artist has no photo yet) ── also rate-limited
  let photoUrl: string | null = null;
  if (!artist.photo_url) {
    try {
      photoUrl = await lookupArtistPhoto(mbArtist.id);
    } catch (err) {
      console.warn(`[enrich-artists] photo lookup failed for "${artist.name}":`, err);
    }
    await sleep(RATE_LIMIT_MS);
  }

  // 3. Persist musicbrainz_id (always) + photo_url (only if newly found)
  const update: Record<string, unknown> = { musicbrainz_id: mbArtist.id };
  if (photoUrl) update.photo_url = photoUrl;

  const { error: updateError } = await supabase
    .from("artists")
    .update(update)
    .eq("id", artist.id);

  if (updateError) {
    console.error(
      `[enrich-artists] DB update failed for "${artist.name}":`,
      updateError.message,
    );
    result.failed++;
    return;
  }

  // 4. Link MB tags → artist_genres
  if (mbArtist.tags?.length) {
    await linkArtistGenres(artist.id, mbArtist.tags);
  }

  console.log(
    `[enrich-artists] enriched "${artist.name}" → ${mbArtist.id}` +
      (photoUrl ? " (photo)" : ""),
  );
  result.enriched++;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function run(): Promise<EnrichResult> {
  const result: EnrichResult = { enriched: 0, skipped: 0, failed: 0, no_match: 0 };

  let offset = 0;

  while (true) {
    const { data: artists, error } = await supabase
      .from("artists")
      .select("id, name, photo_url")
      .is("musicbrainz_id", null)
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error("[enrich-artists] batch fetch error:", error.message);
      break;
    }

    if (!artists || artists.length === 0) break;

    console.log(
      `[enrich-artists] batch offset=${offset} — ${artists.length} artists`,
    );

    for (const artist of artists as ArtistRow[]) {
      await enrichArtist(artist, result);
    }

    if (artists.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

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
    console.error("[enrich-artists]", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ─── DEPLOY ───────────────────────────────────────────────────────────────────
//
// supabase functions deploy enrich-artists --no-verify-jwt
//
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son inyectadas automáticamente.
//
// CRON (pg_cron + pg_net requeridos — correr en Supabase SQL Editor):
//
//   SELECT cron.schedule(
//     'enrich-artists-weekly',
//     '0 9 * * 1',   -- lunes 9am UTC
//     $$
//     SELECT net.http_post(
//       url     := current_setting('app.supabase_url') || '/functions/v1/enrich-artists',
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
//   curl -X POST https://TU_PROJECT_REF.supabase.co/functions/v1/enrich-artists \
//     -H "Authorization: Bearer TU_ANON_KEY" \
//     -H "Content-Type: application/json"

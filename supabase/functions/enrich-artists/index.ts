// ─── enrich-artists ───────────────────────────────────────────────────────────
//
// Enriquece artistas sin foto/género consultando MusicBrainz y Last.fm.
//
// Fuentes de fotos (en orden de preferencia):
//   1. MusicBrainz → Wikimedia Commons (url-rels tipo "image")
//   2. Last.fm → artist.getinfo (requiere LASTFM_API_KEY)
//
// Géneros: MB tags → mapToCanonicalGenre() → genres table → artist_genres
//
// Opciones:
//   dry_run=true  → calcula cambios pero no escribe en BD
//   limit         → máximo de artistas a procesar (útil para pruebas)
//
// DEPLOY:
//   supabase functions deploy enrich-artists --no-verify-jwt
//
// VARIABLES DE ENTORNO:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — inyectadas automáticamente
//   LASTFM_API_KEY                           — agregar en Supabase secrets
//
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mapToCanonicalGenre } from "../_shared/genre-mapper.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const MB_BASE       = "https://musicbrainz.org/ws/2";
const MB_USER_AGENT = "Grub/1.0 (sthefanyflorianog@gmail.com)";
const RATE_LIMIT_MS = 1100;
const DEFAULT_BATCH = 10;
const MIN_SCORE     = 70;

// Last.fm placeholder — returned when the artist has no image
const LASTFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArtistRow {
  id:                  string;
  name:                string;
  photo_url:           string | null;
  enrichment_failed:   boolean;
}

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

interface MbUrlRelation {
  type: string;
  url:  { resource: string };
}

interface MbArtistLookup {
  id:         string;
  relations?: MbUrlRelation[];
}

export interface EnrichResult {
  enriched:  number;
  skipped:   number;
  failed:    number;
  no_match:  number;
  dry_run:   boolean;
}

export interface RunOptions {
  dryRun?:    boolean;
  batchSize?: number;
  limit?:     number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mbFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": MB_USER_AGENT } });
  if (!res.ok) throw new Error(`MB ${res.status} — ${url}`);
  return res.json() as Promise<T>;
}

// ─── MusicBrainz: search ─────────────────────────────────────────────────────

async function searchMbArtist(name: string): Promise<MbArtistSearchResult | null> {
  const q    = encodeURIComponent(`artist:${name}`);
  const data = await mbFetch<{ artists: MbArtistSearchResult[] }>(
    `${MB_BASE}/artist?query=${q}&fmt=json&limit=1`,
  );
  const artist = data.artists?.[0];
  if (!artist || artist.score < MIN_SCORE) return null;
  return artist;
}

// ─── MusicBrainz: photo via Wikimedia url-rel ─────────────────────────────────

async function fetchMbWikimediaPhoto(mbid: string): Promise<string | null> {
  const data = await mbFetch<MbArtistLookup>(
    `${MB_BASE}/artist/${mbid}?inc=url-rels&fmt=json`,
  );
  const rel = data.relations?.find(
    (r) => r.type === "image" && r.url?.resource?.includes("wikimedia.org"),
  );
  if (!rel) return null;
  const m = rel.url.resource.match(/\/wiki\/File:(.+)$/);
  if (!m) return null;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}`;
}

// ─── Last.fm: photo ───────────────────────────────────────────────────────────

async function fetchLastFmPhoto(name: string, apiKey: string): Promise<string | null> {
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo` +
    `&artist=${encodeURIComponent(name)}&api_key=${apiKey}&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const images: Array<{ "#text": string; size: string }> = data?.artist?.image ?? [];
  for (const size of ["mega", "extralarge", "large"]) {
    const img = images.find((i) => i.size === size);
    if (img?.["#text"] && !img["#text"].includes(LASTFM_PLACEHOLDER)) {
      return img["#text"];
    }
  }
  return null;
}

// ─── Genre linking (batch — no N+1) ──────────────────────────────────────────

async function linkArtistGenres(
  supabase: SupabaseClient,
  artistId: string,
  tags: MbTag[],
  dryRun: boolean,
): Promise<void> {
  const slugSet = new Set<string>();
  for (const tag of tags) {
    const slug = mapToCanonicalGenre(tag.name);
    if (slug) slugSet.add(slug);
  }
  if (!slugSet.size) return;

  const { data: genres, error } = await supabase
    .from("genres")
    .select("id, slug")
    .in("slug", [...slugSet]);

  if (error) {
    console.warn("[enrich-artists] genres lookup error:", error.message);
    return;
  }
  if (!genres?.length) return;

  if (!dryRun) {
    const rows = genres.map((g) => ({ artist_id: artistId, genre_id: g.id }));
    const { error: upsertErr } = await supabase
      .from("artist_genres")
      .upsert(rows, { onConflict: "artist_id,genre_id", ignoreDuplicates: true });
    if (upsertErr) {
      console.warn("[enrich-artists] artist_genres upsert error:", upsertErr.message);
    }
  }
}

// ─── Per-artist enrichment ────────────────────────────────────────────────────

async function enrichArtist(
  supabase: SupabaseClient,
  artist: ArtistRow,
  result: EnrichResult,
  lastFmApiKey: string | null,
): Promise<void> {
  if (!artist.name.trim()) {
    result.skipped++;
    return;
  }

  // ── 1. MusicBrainz search ────────────────────────────────────────────────────
  let mbArtist: MbArtistSearchResult | null;
  try {
    mbArtist = await searchMbArtist(artist.name);
  } catch (err) {
    console.error(`[enrich-artists] MB search failed for "${artist.name}":`, err);
    if (!result.dry_run) {
      await supabase
        .from("artists")
        .update({ enrichment_failed: true })
        .eq("id", artist.id);
    }
    result.failed++;
    await sleep(RATE_LIMIT_MS);
    return;
  }
  await sleep(RATE_LIMIT_MS);

  if (!mbArtist) {
    console.log(`[enrich-artists] no MB match for "${artist.name}"`);
    if (!result.dry_run) {
      await supabase
        .from("artists")
        .update({ enrichment_failed: true })
        .eq("id", artist.id);
    }
    result.no_match++;
    return;
  }

  // ── 2. Photo (MB Wikimedia first, Last.fm fallback) ──────────────────────────
  let photoUrl:    string | null = artist.photo_url ?? null;
  let photoSource: string | null = null;

  if (!photoUrl) {
    try {
      photoUrl = await fetchMbWikimediaPhoto(mbArtist.id);
      if (photoUrl) photoSource = "wikimedia";
    } catch (err) {
      console.warn(`[enrich-artists] MB photo lookup failed for "${artist.name}":`, err);
    }
    await sleep(RATE_LIMIT_MS);

    if (!photoUrl && lastFmApiKey) {
      try {
        photoUrl = await fetchLastFmPhoto(artist.name, lastFmApiKey);
        if (photoUrl) photoSource = "lastfm";
      } catch (err) {
        console.warn(`[enrich-artists] Last.fm photo failed for "${artist.name}":`, err);
      }
    }
  }

  // ── 3. Genre linking ─────────────────────────────────────────────────────────
  await linkArtistGenres(
    supabase,
    artist.id,
    mbArtist.tags ?? [],
    result.dry_run,
  );

  // ── 4. Persist ───────────────────────────────────────────────────────────────
  if (!result.dry_run) {
    const update: Record<string, unknown> = {
      musicbrainz_id:    mbArtist.id,
      enriched_at:       new Date().toISOString(),
      enrichment_failed: false,
    };
    if (photoUrl)    update.photo_url    = photoUrl;
    if (photoSource) update.photo_source = photoSource;

    const { error } = await supabase
      .from("artists")
      .update(update)
      .eq("id", artist.id);

    if (error) {
      console.error(`[enrich-artists] DB update failed for "${artist.name}":`, error.message);
      result.failed++;
      return;
    }
  }

  console.log(
    `[enrich-artists] ${result.dry_run ? "[dry-run] " : ""}enriched "${artist.name}"` +
      ` → mbid=${mbArtist.id}` +
      (photoSource ? ` photo=${photoSource}` : ""),
  );
  result.enriched++;
}

// ─── runEnrichment ────────────────────────────────────────────────────────────
//
// Exportado para poder llamarse desde otros orquestadores (e.g. sync-global)
// o directamente en tests.
//

export async function runEnrichment(
  supabase: SupabaseClient,
  opts: RunOptions = {},
): Promise<EnrichResult> {
  const { dryRun = false, batchSize = DEFAULT_BATCH, limit } = opts;
  const lastFmApiKey = Deno.env.get("LASTFM_API_KEY") ?? null;

  if (!lastFmApiKey) {
    console.warn("[enrich-artists] LASTFM_API_KEY not set — photo fallback disabled");
  }

  const result: EnrichResult = { enriched: 0, skipped: 0, failed: 0, no_match: 0, dry_run: dryRun };
  let offset = 0;

  while (true) {
    const remaining = limit ? limit - (result.enriched + result.failed + result.no_match) : Infinity;
    if (remaining <= 0) break;

    const fetchSize = Math.min(batchSize, remaining);

    const { data: artists, error } = await supabase
      .from("artists")
      .select("id, name, photo_url, enrichment_failed")
      .is("enriched_at", null)
      .eq("enrichment_failed", false)
      .range(offset, offset + fetchSize - 1)
      .order("id");

    if (error) {
      console.error("[enrich-artists] batch fetch error:", error.message);
      break;
    }

    if (!artists?.length) break;

    console.log(
      `[enrich-artists] batch offset=${offset} — ${artists.length} artist(s)` +
        (dryRun ? " [dry-run]" : ""),
    );

    for (const artist of artists as ArtistRow[]) {
      await enrichArtist(supabase, artist, result, lastFmApiKey);
    }

    if (artists.length < fetchSize) break;
    offset += fetchSize;
  }

  console.log(
    `[enrich-artists] done — enriched=${result.enriched} no_match=${result.no_match}` +
      ` failed=${result.failed} skipped=${result.skipped}`,
  );

  return result;
}

// ─── Handler (standalone invocation) ─────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status:  405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")              ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let opts: RunOptions = {};
  try {
    const body = await req.json();
    opts = {
      dryRun:    body.dry_run    === true,
      batchSize: Number(body.batch_size ?? DEFAULT_BATCH),
      limit:     body.limit      ? Number(body.limit) : undefined,
    };
  } catch {
    // no body — use defaults
  }

  try {
    const result = await runEnrichment(supabase, opts);
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
// SECRETS (Supabase dashboard → Settings → Edge Functions → Secrets):
//   LASTFM_API_KEY=tu_clave_de_lastfm
//
// CURL — prueba dry-run (primeros 5):
//   curl -X POST https://TU_REF.supabase.co/functions/v1/enrich-artists \
//     -H "Authorization: Bearer TU_SERVICE_ROLE_KEY" \
//     -H "Content-Type: application/json" \
//     -d '{"dry_run": true, "limit": 5}'
//
// CURL — producción (lote de 10):
//   curl -X POST https://TU_REF.supabase.co/functions/v1/enrich-artists \
//     -H "Authorization: Bearer TU_SERVICE_ROLE_KEY" \
//     -H "Content-Type: application/json" \
//     -d '{}'
//
// CRON SEMANAL (pg_cron + pg_net):
//   SELECT cron.schedule(
//     'enrich-artists-weekly', '0 9 * * 1',
//     $$ SELECT net.http_post(
//       url     := current_setting('app.supabase_url') || '/functions/v1/enrich-artists',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
//         'Content-Type',  'application/json'),
//       body := '{}'::jsonb) $$);

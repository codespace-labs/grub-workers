// ─── Genre mapper ─────────────────────────────────────────────────────────────
//
// Fuente de verdad para géneros canónicos en el sistema grub.
//
// Exporta:
//   CANONICAL_GENRES          — lista fija de slugs canónicos (solo estos 15)
//   mapToCanonicalGenre(raw)  — etiqueta explícita del scraper → slug | null
//   inferGenres(name, venue)  — inferencia desde nombre del evento → slug[]
//   linkGenres(supabase, id, slugs) — vincula slugs en event_genres (sin N+1)
//
// REGLA: nunca LLM. Géneros sin mapeo claro → null / [].
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Géneros canónicos ────────────────────────────────────────────────────────
// Esta lista es fija. No agregar slugs sin actualizar también la migración SQL.

export const CANONICAL_GENRES = [
  "rock",
  "pop",
  "electronica",
  "hip-hop",
  "reggaeton",
  "metal",
  "jazz",
  "salsa",
  "indie",
  "urbano",
  "clasica",
  "cumbia",
  "r-b",
  "punk",
  "alternativo",
] as const;

export type CanonicalGenreSlug = typeof CANONICAL_GENRES[number];

// ─── Normalización ────────────────────────────────────────────────────────────
// Misma lógica que _normalize_genre() en la migración SQL:
//   lowercase → trim → quitar tildes → quitar paréntesis y contenido → trim final

export function normalizeGenreString(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // quita tildes/acentos
    .replace(/\s*\([^)]*\)/g, "")      // quita paréntesis y su contenido
    .replace(/[/|·,]+/g, " ")          // normaliza separadores
    .replace(/\s+/g, " ")              // colapsa espacios múltiples
    .trim();
}

// ─── Tabla de mapeo canónico ──────────────────────────────────────────────────
// Orden importa: excluidos primero, luego los más específicos antes que los generales.
// null = sin canónico válido (el evento/artista se guarda igual, sin ese género).

const CANONICAL_MAP: ReadonlyArray<[RegExp, CanonicalGenreSlug | null]> = [
  // ── Excluidos explícitamente (sin canónico en onboarding) ─────────────────
  [/motivacional|conferencia|charla|talk|speaker/,                          null],
  [/musica peruana|musica andina|criollo|chicha|huayno/,                    null],
  [/folklore|folklorico|andino|andina|traditional/,                        null],
  [/industrial|shoegaze|prog(ressive)? rock|world music|new age|spoken/,   null],
  [/ambiente|ambient/,                                                      null],

  // ── Electrónica ─────────────────────────────────────────────────────────
  [/electroni|electro|edm|techno|house|eurodance|ebm|electronic body/,    "electronica"],
  [/trance|minimal|dnb|drum.?n.?bass|breakbeat|\brave\b|dance.?music/,    "electronica"],
  [/latin.?bass|bass\s*music/,                                             "electronica"],

  // ── Metal ───────────────────────────────────────────────────────────────
  [/nu.?metal|alt(ernativo)?.?metal|death.?metal|black.?metal/,           "metal"],
  [/thrash|heavy.?metal|metal\s*alternativo|metal$/,                      "metal"],
  [/^metal/,                                                               "metal"],

  // ── Punk ────────────────────────────────────────────────────────────────
  [/post.?punk|punk.?rock|^punk$|hardcore/,                               "punk"],

  // ── Rock (después de metal/punk para no capturar "punk rock" aquí) ──────
  [/rock.?alternativo|alternative.?rock/,                                  "rock"],
  [/^rock$|^rock |classic.?rock|hard.?rock|garage.?rock|grunge|blues/,    "rock"],

  // ── Indie ───────────────────────────────────────────────────────────────
  [/indie.?folk|indie.?pop|indie.?rock|^indie$/,                          "indie"],

  // ── Alternativo ─────────────────────────────────────────────────────────
  [/alternati|^alternative$|post.?rock|math.?rock|folk(?!.*rock)|flamenco/, "alternativo"],

  // ── Pop ─────────────────────────────────────────────────────────────────
  [/k.?pop|kpop/,                                                          "pop"],
  [/pop\s*(rock|latino|argentina?|argentino|tropical|urbano)/,             "pop"],
  [/latin\s*pop|^pop$/,                                                    "pop"],

  // ── Hip-Hop / Rap ────────────────────────────────────────────────────────
  [/hip.?hop|^rap$|conscious.?hip/,                                        "hip-hop"],

  // ── Urbano (trap + urban latin) ──────────────────────────────────────────
  [/trap\s*latino|^trap$|urbano|urban\s*latin|freestyle|latin\s*trap/,    "urbano"],

  // ── Reggaetón ───────────────────────────────────────────────────────────
  [/reggaet|perreo|dembow/,                                                "reggaeton"],

  // ── R&B ─────────────────────────────────────────────────────────────────
  [/r\s*&\s*b|^r.b$|^rnb$|r\s*and\s*b|rhythm.?and.?blues|neo.?soul|^soul$|funk/, "r-b"],

  // ── Jazz ────────────────────────────────────────────────────────────────
  [/jazz\s*(fusion|latino|latin)?|^jazz$/,                                 "jazz"],
  [/bossa\s*nova|smooth\s*jazz/,                                           "jazz"],

  // ── Clásica ─────────────────────────────────────────────────────────────
  [/clasic|classical|sinfon|orquest|filarmoni|camara|opera|barroco/,      "clasica"],

  // ── Salsa / Tropical ────────────────────────────────────────────────────
  [/salsa\s*(dura|romantica|brava)?|^salsa$|tropical|bachata|merengue|son\s*cubano/, "salsa"],

  // ── Cumbia ──────────────────────────────────────────────────────────────
  [/cumbia|cuarteto/,                                                      "cumbia"],
];

// ─── mapToCanonicalGenre ──────────────────────────────────────────────────────

/**
 * Mapea una etiqueta de género raw (proveniente del scraper) al slug canónico.
 *
 * - Función pura: sin I/O, sin efectos secundarios. Testeable en aislamiento.
 * - Normaliza antes de comparar: lowercase + trim + sin tildes + sin paréntesis.
 * - Retorna null si no hay mapeo canónico (evento/artista se guarda igual).
 *
 * @example
 *   mapToCanonicalGenre("EBM (Electronic Body Music)") → "electronica"
 *   mapToCanonicalGenre("Motivacional / Conferencia")  → null
 *   mapToCanonicalGenre("Hip-Hop/Rap")                 → "hip-hop"
 *   mapToCanonicalGenre("R&B")                         → "r-b"
 *   mapToCanonicalGenre("Urban Latin")                 → "urbano"
 *   mapToCanonicalGenre("Nu Metal")                    → "metal"
 *   mapToCanonicalGenre("Post-Punk")                   → "punk"
 */
export function mapToCanonicalGenre(rawGenre: string): CanonicalGenreSlug | null {
  const norm = normalizeGenreString(rawGenre);
  if (!norm) return null;

  for (const [re, slug] of CANONICAL_MAP) {
    if (re.test(norm)) return slug;
  }
  return null;
}

// ─── inferGenres ──────────────────────────────────────────────────────────────
// Infiere géneros canónicos desde el nombre del evento (haystack matching).
// Para cuando el scraper no provee etiquetas explícitas de género.

const INFER_RULES: ReadonlyArray<[RegExp, CanonicalGenreSlug]> = [
  [/electro|edm|\brave\b|circoloco|creamfields|awakenings|\bultra\b/,  "electronica"],
  [/\btechno\b|\bhouse\b|tech\s*house|deep\s*house/,                   "electronica"],
  [/reggaet|dembow|perreo/,                                            "reggaeton"],
  [/hip[\s-]hop|\brap\b/,                                              "hip-hop"],
  [/\btrap\b|\burbano\b|urban\s*latin/,                                "urbano"],
  [/r\s*&\s*b|\brnb\b|\bsoul\b/,                                       "r-b"],
  [/\bsalsa\b|tropical|bachata|merengue/,                              "salsa"],
  [/cumbia/,                                                           "cumbia"],
  [/\brock\b/,                                                         "rock"],
  [/\bmetal\b|heavy\s*metal/,                                          "metal"],
  [/\bpunk\b|hardcore/,                                                "punk"],
  [/\bindie\b/,                                                        "indie"],
  [/alternati|\bfolk\b|flamenco/,                                      "alternativo"],
  [/k[\s-]?pop|kpop|\bpop\b/,                                          "pop"],
  [/\bjazz\b|bossa\s*nova/,                                            "jazz"],
  [/clasica|clasico|classical|sinfon|orquesta|filarmoni/,              "clasica"],
];

/**
 * Infiere slugs canónicos desde el nombre del evento (haystack matching).
 * Devuelve [] si no hay señal clara — sin LLM, sin I/O.
 *
 * @example
 *   inferGenres("Daddy Yankee Reggaeton Tour")  → ["reggaeton"]
 *   inferGenres("Festival Techno Rave 2026")    → ["electronica"]
 */
export function inferGenres(name: string, venue = ""): CanonicalGenreSlug[] {
  const haystack = `${name} ${venue}`.toLowerCase();
  const slugs    = new Set<CanonicalGenreSlug>();

  for (const [re, slug] of INFER_RULES) {
    if (re.test(haystack)) slugs.add(slug);
  }

  return [...slugs];
}

// ─── linkGenres ───────────────────────────────────────────────────────────────
// Vincula slugs canónicos con event_genres en una sola query (sin N+1).

export async function linkGenres(
  supabase: SupabaseClient,
  eventId: string,
  slugs: string[],
): Promise<void> {
  if (!slugs.length) return;

  const { data: genres, error } = await supabase
    .from("genres")
    .select("id, slug")
    .in("slug", slugs);

  if (error) {
    console.error("[linkGenres] query error:", error.message);
    return;
  }

  if (!genres?.length) return;

  const rows = genres.map((g) => ({ event_id: eventId, genre_id: g.id }));

  const { error: insertErr } = await supabase
    .from("event_genres")
    .upsert(rows, { onConflict: "event_id,genre_id", ignoreDuplicates: true });

  if (insertErr) {
    console.error("[linkGenres] upsert error:", insertErr.message);
  }
}

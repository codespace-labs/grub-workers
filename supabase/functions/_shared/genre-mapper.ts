// ─── Genre mapper ─────────────────────────────────────────────────────────────
//
// Inferencia de géneros por keyword matching determinista.
//
// REGLA PRINCIPAL: nunca usar LLM para géneros.
// Los géneros que no se pueden inferir con certeza se dejan vacíos para que
// enrich-artists los resuelva en el paso de enriquecimiento posterior.
//
// Esta es la única fuente de verdad para inferencia de géneros.
// Antes estaba triplicada en sync-ticketmaster, sync-ticketmaster-pe y
// sync-teleticket con pequeñas inconsistencias entre versiones.
//
// Slugs válidos (deben existir en la tabla `genres`):
//   techno · house · reggaeton · salsa · cumbia · vallenato · bachata
//   merengue · rock · hip-hop · trap · rnb · indie · electronica
//   latin-bass · jazz · alternativo · kpop · pop · clasica

// ─── Reglas ───────────────────────────────────────────────────────────────────
//
// Orden importa: las reglas más específicas van primero dentro del mismo slug.
// Un evento puede tener varios géneros (set devuelve únicos).

const GENRE_RULES: ReadonlyArray<[RegExp, string]> = [
  // ── Electrónica ─────────────────────────────────────────────────────────────
  [/\btechno\b/,                                                        "techno"],
  [/\bhouse\b|tech\s*house|deep\s*house|afro\s*house|\bfunk\b|\bdisco\b/, "house"],
  [/electro|edm|\brave\b|circoloco|creamfields|awakenings|\bultra\b/,    "electronica"],
  [/latin[\s-]bass|\bbass\b/,                                           "latin-bass"],

  // ── Urbano ──────────────────────────────────────────────────────────────────
  [/reggaet/,                                                     "reggaeton"],
  [/hip[\s-]hop|\brap\b/,                                         "hip-hop"],
  [/\btrap\b/,                                                    "trap"],
  [/r\s*&\s*b|\brnb\b|r'n'b/,                                    "rnb"],
  [/\bsoul\b/,                                                    "rnb"],

  // ── Latina ──────────────────────────────────────────────────────────────────
  [/\bsalsa\b/,                                                   "salsa"],
  [/cumbia/,                                                      "cumbia"],
  [/vallenato/,                                                   "vallenato"],
  [/bachata/,                                                     "bachata"],
  [/merengue/,                                                    "merengue"],

  // ── Rock / alternativo ──────────────────────────────────────────────────────
  [/\brock\b|metal|punk/,                                         "rock"],
  [/blues/,                                                       "rock"],
  [/\bindie\b/,                                                   "indie"],
  [/\bfolk\b|flamenco/,                                           "alternativo"],

  // ── Pop ─────────────────────────────────────────────────────────────────────
  [/k[\s-]?pop|kpop/,                                             "kpop"],
  [/\bpop\b/,                                                     "pop"],

  // ── Acústico / instrumental ──────────────────────────────────────────────────
  [/\bjazz\b/,                                                    "jazz"],
  [/clasica|clasico|classical|sinfon|orquesta|filarmoni|guitarra\s+clasica/, "clasica"],
];

// ─── inferGenres ──────────────────────────────────────────────────────────────

/**
 * Infiere slugs de géneros a partir del nombre del evento (y opcionalmente del venue).
 *
 * - Solo keyword matching: sin llamadas externas, sin LLM.
 * - Devuelve [] si no hay señal clara (enrich-artists lo resolverá después).
 * - Devuelve slugs únicos; el orden no está garantizado.
 *
 * @example
 *   inferGenres("Daddy Yankee Reggaeton Tour")   → ["reggaeton"]
 *   inferGenres("Armin van Buuren – Trance Set") → []   ← correcto, no hay regla de trance
 *   inferGenres("Festival Techno Rave 2026")     → ["techno", "electronica"]
 */
export function inferGenres(name: string, venue = ""): string[] {
  const haystack = `${name} ${venue}`.toLowerCase();
  const slugs    = new Set<string>();

  for (const [re, slug] of GENRE_RULES) {
    if (re.test(haystack)) slugs.add(slug);
  }

  return [...slugs];
}

// ─── linkGenres ───────────────────────────────────────────────────────────────
//
// Vincula slugs con la tabla event_genres.
// Se exporta aquí para que todos los adapters lo usen sin duplicar.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function linkGenres(
  supabase: SupabaseClient,
  eventId: string,
  slugs: string[],
): Promise<void> {
  if (!slugs.length) return;

  // Resuelve todos los genre_id en una sola query para evitar N+1
  const { data: genres, error } = await supabase
    .from("genres")
    .select("id, slug")
    .in("slug", slugs);

  if (error) {
    console.error("[linkGenres] no se pudo consultar géneros:", error.message);
    return;
  }

  if (!genres?.length) return;

  const rows = genres.map((g) => ({ event_id: eventId, genre_id: g.id }));

  const { error: insertErr } = await supabase
    .from("event_genres")
    .upsert(rows, { onConflict: "event_id,genre_id", ignoreDuplicates: true });

  if (insertErr) {
    console.error("[linkGenres] insert error:", insertErr.message);
  }
}

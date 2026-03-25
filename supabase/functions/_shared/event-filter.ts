// ─── Event exclusion filter ───────────────────────────────────────────────────
//
// Determina si un evento está completamente fuera del target de grub.
//
// Target: conciertos de música contemporánea (rock, pop, electrónica, urbano…).
// Out-of-scope: folklore, cumbia, tributos, teatro, infantil, andino, ópera, comedia.
//
// Exporta:
//   isExcludedEvent(name, venue?, category?) → boolean
//   EXCLUDED_SKIP_REASON = "excluded_out_of_scope"
// ─────────────────────────────────────────────────────────────────────────────

export const EXCLUDED_SKIP_REASON = "excluded_out_of_scope";

// Patrones que coinciden con el nombre/venue del evento (minúsculas, sin tildes).
// Evaluados en orden — el primero que coincide excluye el evento.
const EXCLUSION_PATTERNS: RegExp[] = [
  // Teatro / artes escénicas
  /\bteatro\b|\bteatral\b|\bopera\b|\bopera\b|\bópera\b/,

  // Folklore / tradición andina peruana
  /\bfolklor|\bfolklorico\b|\bfolklorica\b/,
  /\bandino\b|\bandina\b|\bchicha\b|\bhuayno\b|\bcriollo\b|\bcriolla\b/,
  /\bmusica\s*peruana\b|\bmusica\s*andina\b|\bmusica\s*folklorica\b/,

  // Cumbia
  /\bcumbia\b|\bcuarteto\b/,

  // Tributos / homenajes
  /\btributo\b|\btributos\b|\btribute\b|\bhomenaje\b/,

  // Infantil / niños
  /\binfantil\b|\bni[nñ]os?\b|\bshow\s*para\s*ni[nñ]|\bespectaculo\s*infantil\b/,

  // Comedia / stand-up
  /\bcomedia\b|\bstand[\s-]?up\b|\bstandup\b|\bhumorista\b|\bhumor\b/,
];

// Categorías explícitas de fuente (ej. campo `category` de teleticket) que excluyen.
const EXCLUDED_CATEGORIES = new Set([
  "teatro",
  "comedia",
  "infantil",
  "circo",
  "danza",
  "ballet",
  "opera",
  "ópera",
  "exposicion",
  "exposición",
  "conferencia",
  "charla",
]);

/**
 * Retorna true si el evento debe ser completamente ignorado (no guardado en DB).
 *
 * @param name      Nombre del evento (raw, sin normalizar)
 * @param venue     Venue raw (opcional) — se ignora en el matching actual
 * @param category  Categoría explícita del scraper (ej. "Teatro", "Infantil")
 */
export function isExcludedEvent(
  name: string,
  venue?: string | null,
  category?: string | null,
): boolean {
  // 1. Filtro por categoría explícita (siempre más preciso)
  if (category) {
    const normCat = category
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
    if (EXCLUDED_CATEGORIES.has(normCat)) return true;
  }

  // 2. Filtro por nombre del evento
  const normName = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  for (const pattern of EXCLUSION_PATTERNS) {
    if (pattern.test(normName)) return true;
  }

  return false;
}

// ─── Music filter ─────────────────────────────────────────────────────────────
//
// Decide si un evento debe permitirse o excluirse antes de escribirlo en la DB.
//
// Lógica:
//   1. Si cae en una exclusión editorial dura → se bloquea.
//   2. Si nombre o venue contiene alguna MUSIC_SIGNAL → musical.
//   3. Si nombre contiene algún NON_MUSIC_KEYWORD → no musical.
//   4. Default → musical.
//
// Los eventos no musicales se pueden upsertear con is_active = false
// para revisión manual si se desea, pero la decisión de filtrarlos
// corresponde al adapter que llama a esta función.
//
// Esta lista estaba triplicada en sync-ticketmaster, sync-ticketmaster-pe
// y sync-teleticket con inconsistencias. Es la única fuente de verdad.

// ─── Señales positivas ────────────────────────────────────────────────────────
//
// Si cualquiera de estas aparece en nombre o venue, el evento se trata
// como musical independientemente de lo que digan los NON_MUSIC_KEYWORDS.

const MUSIC_SIGNALS: ReadonlyArray<string> = [
  // Tipos de evento
  "concierto", "concert",
  "festival",
  "tour", "world tour",
  " live", "live show", "en vivo",
  "dj set", "dj session",
  // Agrupaciones
  "banda", "band",
  // Géneros (señales fuertes)
  "techno", "house",
  "reggaeton", "reggae",
  "salsa",
  "hip-hop", "hip hop", "rap",
  "indie", "rock", "metal",
  "edm", "rave", "electronica",
  "jazz",
];

// ─── Keywords de exclusión ────────────────────────────────────────────────────
//
// Si el nombre contiene alguno de estos Y no hay MUSIC_SIGNAL, no es musical.
// Se chequean solo contra el nombre (no venue), porque nombres de venues como
// "Teatro Municipal" pueden seguir albergando conciertos.

const NON_MUSIC_KEYWORDS: ReadonlyArray<string> = [
  // Logística / venue info
  "estacionamiento",
  "parking",
  "puntos de venta",
  "centro de ayuda",

  // Teatro / espectáculos
  "teatro",
  "el musical",
  "arlequin",
  "obra de",
  " obra ",
  "comedia",

  // Humor
  "humor",
  "imitaciones",
  "stand up",
  "standup",
  "stand-up",
  "comico",
  "monologo",
  "monólogo",

  // Danza / ballet
  "ballet",
  "danza",
  "cisnes",
  "lago de los",

  // Clásica institucional (temporadas)
  "temporada de abono",
  "ciclo cuerdas",
  "sinfonia alla",
  "sinfonía alla",
  "temporada sinfonica",
  "temporada sinf",
  "clasicos de",
  "clásicos de",

  // Infantil / familia
  "fiesta en la granja",
  "show infantil",
  "espectaculo infantil",
  "espectáculo infantil",
  "infantil",
  "para niños",
  "para ninos",
  "niños",
  "ninos",
  "kids",

  // Variedades
  "magia",
  "circo",
];

const HARD_EXCLUSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\btributo\b/i,
  /\btribute\b/i,
  /\bhomenaje\b/i,
  /\brevive\b/i,
  /\bx siempre\b/i,
  /\bcerati x siempre\b/i,
  /\bpara ni(?:n|ñ)os\b/i,
  /\bni(?:n|ñ)os?\b/i,
  /\binfantil(?:es)?\b/i,
  /\bkids?\b/i,
  /\bcumbia\b/i,
  /\bchicha\b/i,
  /\bhuayno?s?\b/i,
  /\bfolklor(?:e|ica|ico)\b/i,
  /\bfolkl[oó]ric[ao]s?\b/i,
  /\bandino?s?\b/i,
  /\bcriollo?s?\b/i,
];

const HARD_EXCLUDED_GENRES = new Set([
  "cumbia",
  "cumbia-andina",
  "folklore",
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export interface EditorialExclusionInput {
  name: string;
  venue?: string | null;
  genreSlugs?: string[];
  coverUrl?: string | null;
}

export function getEditorialExclusionReason(input: EditorialExclusionInput): string | null {
  const nameNorm = normalizeText(input.name ?? "");
  const venueNorm = normalizeText(input.venue ?? "");
  const haystack = `${nameNorm} ${venueNorm}`.trim();

  if (HARD_EXCLUSION_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return "editorial-blocked";
  }

  if ((input.genreSlugs ?? []).some((slug) => HARD_EXCLUDED_GENRES.has(slug))) {
    return "excluded-genre";
  }

  return null;
}

// ─── isMusicalEvent ───────────────────────────────────────────────────────────

/**
 * Retorna true si el evento parece ser de música en vivo.
 *
 * @param name   Nombre del evento (requerido).
 * @param venue  Nombre del venue (opcional, solo para MUSIC_SIGNALS).
 */
export function isMusicalEvent(name: string, venue = ""): boolean {
  if (getEditorialExclusionReason({ name, venue })) return false;

  const haystack = normalizeText(`${name} ${venue}`);

  // Señal positiva fuerte → es musical sin importar el resto
  if (MUSIC_SIGNALS.some((kw) => haystack.includes(kw))) return true;

  // Exclusiones chequeadas solo en el nombre (venues con "teatro" pueden tener conciertos)
  const nameNorm = normalizeText(name);

  if (NON_MUSIC_KEYWORDS.some((kw) => nameNorm.includes(kw))) return false;

  return true; // default abierto
}

// ─── Music filter ─────────────────────────────────────────────────────────────
//
// Decide si un evento es musical o no antes de escribirlo en la DB.
//
// Lógica:
//   1. Si nombre o venue contiene alguna MUSIC_SIGNAL → musical (sin más checks).
//   2. Si nombre o venue contiene algún NON_MUSIC_KEYWORD → no musical.
//   3. Default → musical (abierto por defecto, para no perder eventos).
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
  "tributo", "tribute",
  // Géneros (señales fuertes)
  "techno", "house",
  "reggaeton", "reggae",
  "salsa", "cumbia", "merengue",
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

  // Variedades
  "magia",
  "circo",
];

// ─── isMusicalEvent ───────────────────────────────────────────────────────────

/**
 * Retorna true si el evento parece ser de música en vivo.
 *
 * @param name   Nombre del evento (requerido).
 * @param venue  Nombre del venue (opcional, solo para MUSIC_SIGNALS).
 */
export function isMusicalEvent(name: string, venue = ""): boolean {
  // Normalizar: quitar acentos, minúsculas
  const haystack = `${name} ${venue}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // Señal positiva fuerte → es musical sin importar el resto
  if (MUSIC_SIGNALS.some((kw) => haystack.includes(kw))) return true;

  // Exclusiones chequeadas solo en el nombre (venues con "teatro" pueden tener conciertos)
  const nameNorm = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (NON_MUSIC_KEYWORDS.some((kw) => nameNorm.includes(kw))) return false;

  return true; // default abierto
}

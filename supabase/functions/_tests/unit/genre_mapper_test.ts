import { assertEquals, assertArrayIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  normalizeGenreString,
  mapToCanonicalGenre,
  inferGenres,
  CANONICAL_GENRES,
} from "../../_shared/genre-mapper.ts";

// ─── normalizeGenreString ─────────────────────────────────────────────────────

Deno.test("normalizeGenreString - lowercase y trim", () => {
  assertEquals(normalizeGenreString("  Rock  "), "rock");
  assertEquals(normalizeGenreString("HIP-HOP"), "hip-hop");
});

Deno.test("normalizeGenreString - quita tildes", () => {
  assertEquals(normalizeGenreString("Electrónica"), "electronica");
  assertEquals(normalizeGenreString("Clásica"), "clasica");
  assertEquals(normalizeGenreString("Reggaetón"), "reggaeton");
});

Deno.test("normalizeGenreString - quita paréntesis y su contenido", () => {
  assertEquals(normalizeGenreString("EBM (Electronic Body Music)"), "ebm");
  assertEquals(normalizeGenreString("Rock (Clásico)"), "rock");
});

Deno.test("normalizeGenreString - normaliza separadores", () => {
  assertEquals(normalizeGenreString("Hip-Hop/Rap"), "hip-hop rap");
  assertEquals(normalizeGenreString("R&B · Soul"), "r&b soul");
});

// ─── mapToCanonicalGenre ──────────────────────────────────────────────────────

Deno.test("mapToCanonicalGenre - electronica y variantes", () => {
  assertEquals(mapToCanonicalGenre("Electrónica"), "electronica");
  assertEquals(mapToCanonicalGenre("EDM"), "electronica");
  assertEquals(mapToCanonicalGenre("Techno"), "electronica");
  assertEquals(mapToCanonicalGenre("House"), "electronica");
  assertEquals(mapToCanonicalGenre("EBM (Electronic Body Music)"), "electronica");
  assertEquals(mapToCanonicalGenre("Trance"), "electronica");
});

Deno.test("mapToCanonicalGenre - metal y variantes", () => {
  assertEquals(mapToCanonicalGenre("Metal"), "metal");
  assertEquals(mapToCanonicalGenre("Heavy Metal"), "metal");
  assertEquals(mapToCanonicalGenre("Death Metal"), "metal");
  assertEquals(mapToCanonicalGenre("Nu Metal"), "metal");
  assertEquals(mapToCanonicalGenre("Thrash"), "metal");
});

Deno.test("mapToCanonicalGenre - punk y variantes", () => {
  assertEquals(mapToCanonicalGenre("Punk"), "punk");
  assertEquals(mapToCanonicalGenre("Post-Punk"), "punk");
  assertEquals(mapToCanonicalGenre("Punk Rock"), "punk");
  assertEquals(mapToCanonicalGenre("Hardcore"), "punk");
});

Deno.test("mapToCanonicalGenre - rock y variantes", () => {
  assertEquals(mapToCanonicalGenre("Rock"), "rock");
  assertEquals(mapToCanonicalGenre("Classic Rock"), "rock");
  assertEquals(mapToCanonicalGenre("Hard Rock"), "rock");
  assertEquals(mapToCanonicalGenre("Grunge"), "rock");
  assertEquals(mapToCanonicalGenre("Blues"), "rock");
  assertEquals(mapToCanonicalGenre("Rock Alternativo"), "rock");
});

Deno.test("mapToCanonicalGenre - indie", () => {
  assertEquals(mapToCanonicalGenre("Indie"), "indie");
  assertEquals(mapToCanonicalGenre("Indie Pop"), "indie");
  assertEquals(mapToCanonicalGenre("Indie Rock"), "indie");
  assertEquals(mapToCanonicalGenre("Indie Folk"), "indie");
});

Deno.test("mapToCanonicalGenre - pop y variantes", () => {
  assertEquals(mapToCanonicalGenre("Pop"), "pop");
  assertEquals(mapToCanonicalGenre("K-Pop"), "pop");
  assertEquals(mapToCanonicalGenre("Latin Pop"), "pop");
});

Deno.test("mapToCanonicalGenre - hip-hop", () => {
  assertEquals(mapToCanonicalGenre("Hip-Hop"), "hip-hop");
  assertEquals(mapToCanonicalGenre("Hip Hop"), "hip-hop");
  assertEquals(mapToCanonicalGenre("Rap"), "hip-hop");
});

Deno.test("mapToCanonicalGenre - urbano y trap", () => {
  assertEquals(mapToCanonicalGenre("Urbano"), "urbano");
  assertEquals(mapToCanonicalGenre("Trap"), "urbano");
  assertEquals(mapToCanonicalGenre("Trap Latino"), "urbano");
  assertEquals(mapToCanonicalGenre("Urban Latin"), "urbano");
});

Deno.test("mapToCanonicalGenre - reggaeton", () => {
  assertEquals(mapToCanonicalGenre("Reggaetón"), "reggaeton");
  assertEquals(mapToCanonicalGenre("Reggaeton"), "reggaeton");
  assertEquals(mapToCanonicalGenre("Dembow"), "reggaeton");
  assertEquals(mapToCanonicalGenre("Perreo"), "reggaeton");
});

Deno.test("mapToCanonicalGenre - r-b y soul", () => {
  assertEquals(mapToCanonicalGenre("R&B"), "r-b");
  assertEquals(mapToCanonicalGenre("RnB"), "r-b");
  assertEquals(mapToCanonicalGenre("Soul"), "r-b");
  assertEquals(mapToCanonicalGenre("Funk"), "r-b");
  assertEquals(mapToCanonicalGenre("Neo Soul"), "r-b");
});

Deno.test("mapToCanonicalGenre - jazz y variantes", () => {
  assertEquals(mapToCanonicalGenre("Jazz"), "jazz");
  assertEquals(mapToCanonicalGenre("Jazz Fusión"), "jazz");
  assertEquals(mapToCanonicalGenre("Bossa Nova"), "jazz");
  assertEquals(mapToCanonicalGenre("Smooth Jazz"), "jazz");
});

Deno.test("mapToCanonicalGenre - clasica", () => {
  assertEquals(mapToCanonicalGenre("Clásica"), "clasica");
  assertEquals(mapToCanonicalGenre("Classical"), "clasica");
  assertEquals(mapToCanonicalGenre("Sinfonía"), "clasica");
  assertEquals(mapToCanonicalGenre("Orquesta"), "clasica");
  assertEquals(mapToCanonicalGenre("Ópera"), "clasica");
});

Deno.test("mapToCanonicalGenre - salsa y tropical", () => {
  assertEquals(mapToCanonicalGenre("Salsa"), "salsa");
  assertEquals(mapToCanonicalGenre("Bachata"), "salsa");
  assertEquals(mapToCanonicalGenre("Merengue"), "salsa");
  assertEquals(mapToCanonicalGenre("Son Cubano"), "salsa");
});

Deno.test("mapToCanonicalGenre - cumbia", () => {
  assertEquals(mapToCanonicalGenre("Cumbia"), "cumbia");
  assertEquals(mapToCanonicalGenre("Cuarteto"), "cumbia");
});

Deno.test("mapToCanonicalGenre - géneros excluidos retornan null", () => {
  assertEquals(mapToCanonicalGenre("Motivacional"), null);
  assertEquals(mapToCanonicalGenre("Conferencia"), null);
  assertEquals(mapToCanonicalGenre("Música Andina"), null);
  assertEquals(mapToCanonicalGenre("Folklore"), null);
  assertEquals(mapToCanonicalGenre("Huayno"), null);
  assertEquals(mapToCanonicalGenre("Ambiente"), null);
});

Deno.test("mapToCanonicalGenre - string vacío retorna null", () => {
  assertEquals(mapToCanonicalGenre(""), null);
  assertEquals(mapToCanonicalGenre("   "), null);
});

Deno.test("mapToCanonicalGenre - género desconocido retorna null", () => {
  assertEquals(mapToCanonicalGenre("Genero Inexistente XYZ"), null);
});

// ─── inferGenres ──────────────────────────────────────────────────────────────

Deno.test("inferGenres - infiere electronica desde nombre", () => {
  assertArrayIncludes(inferGenres("Festival Techno Rave 2026"), ["electronica"]);
  assertArrayIncludes(inferGenres("Creamfields Lima"), ["electronica"]);
  assertArrayIncludes(inferGenres("Ultra Music Festival"), ["electronica"]);
});

Deno.test("inferGenres - infiere reggaeton", () => {
  assertArrayIncludes(inferGenres("Daddy Yankee Reggaeton Tour"), ["reggaeton"]);
  assertArrayIncludes(inferGenres("Noche de Perreo"), ["reggaeton"]);
});

Deno.test("inferGenres - infiere rock", () => {
  assertArrayIncludes(inferGenres("Festival Rock al Parque"), ["rock"]);
  assertArrayIncludes(inferGenres("Noche de Rock Clasico"), ["rock"]);
});

Deno.test("inferGenres - infiere salsa desde venue", () => {
  assertArrayIncludes(inferGenres("Noche Especial", "Club Tropical Salsa"), ["salsa"]);
});

Deno.test("inferGenres - retorna array vacío si no hay señal", () => {
  assertEquals(inferGenres("Concierto en el Parque"), []);
  assertEquals(inferGenres("Evento Cultural 2026"), []);
});

Deno.test("inferGenres - puede inferir múltiples géneros", () => {
  const genres = inferGenres("Festival Rock y Electro Beats");
  assertArrayIncludes(genres, ["rock"]);
  assertArrayIncludes(genres, ["electronica"]);
});

// ─── CANONICAL_GENRES ─────────────────────────────────────────────────────────

Deno.test("CANONICAL_GENRES - contiene exactamente 15 slugs", () => {
  assertEquals(CANONICAL_GENRES.length, 15);
});

Deno.test("CANONICAL_GENRES - todos los slugs son únicos", () => {
  const unique = new Set(CANONICAL_GENRES);
  assertEquals(unique.size, CANONICAL_GENRES.length);
});

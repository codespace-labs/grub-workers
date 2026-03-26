import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isExcludedEvent, EXCLUDED_SKIP_REASON } from "../../_shared/event-filter.ts";

// ─── Eventos que SÍ deben incluirse ──────────────────────────────────────────

Deno.test("isExcludedEvent - concierto de rock → incluido", () => {
  assertEquals(isExcludedEvent("Foo Fighters en Lima"), false);
});

Deno.test("isExcludedEvent - festival electrónico → incluido", () => {
  assertEquals(isExcludedEvent("Creamfields Lima 2026"), false);
});

Deno.test("isExcludedEvent - evento reggaeton → incluido", () => {
  assertEquals(isExcludedEvent("Daddy Yankee World Tour"), false);
});

Deno.test("isExcludedEvent - nombre genérico sin exclusión → incluido", () => {
  assertEquals(isExcludedEvent("Gran Concierto 2026"), false);
});

// ─── Teatro ───────────────────────────────────────────────────────────────────

Deno.test("isExcludedEvent - teatro → excluido", () => {
  assertEquals(isExcludedEvent("Obra de Teatro: Hamlet"), true);
});

Deno.test("isExcludedEvent - espectáculo teatral → excluido", () => {
  assertEquals(isExcludedEvent("Festival Teatral Internacional"), true);
});

// ─── Folklore / Andino ────────────────────────────────────────────────────────

Deno.test("isExcludedEvent - folklore → excluido", () => {
  assertEquals(isExcludedEvent("Festival Folklórico Nacional"), true);
});

Deno.test("isExcludedEvent - música andina → excluido", () => {
  assertEquals(isExcludedEvent("Noche de Música Andina"), true);
});

Deno.test("isExcludedEvent - huayno → excluido", () => {
  assertEquals(isExcludedEvent("Gran Huayno Peruano"), true);
});

Deno.test("isExcludedEvent - chicha → excluido", () => {
  assertEquals(isExcludedEvent("Concierto Chicha 2026"), true);
});

Deno.test("isExcludedEvent - criollo → excluido", () => {
  assertEquals(isExcludedEvent("Noche Criolla Tradicional"), true);
});

// ─── Cumbia ───────────────────────────────────────────────────────────────────

Deno.test("isExcludedEvent - cumbia → excluido", () => {
  assertEquals(isExcludedEvent("Festival de Cumbia"), true);
});

// ─── Tributos ─────────────────────────────────────────────────────────────────

Deno.test("isExcludedEvent - tributo → excluido", () => {
  assertEquals(isExcludedEvent("Tributo a Queen"), true);
});

Deno.test("isExcludedEvent - homenaje → excluido", () => {
  assertEquals(isExcludedEvent("Homenaje a Michael Jackson"), true);
});

Deno.test("isExcludedEvent - tribute band → excluido", () => {
  assertEquals(isExcludedEvent("The Tribute Band Live"), true);
});

// ─── Infantil ────────────────────────────────────────────────────────────────

Deno.test("isExcludedEvent - show infantil → excluido", () => {
  assertEquals(isExcludedEvent("Show Infantil de Navidad"), true);
});

Deno.test("isExcludedEvent - show para niños → excluido", () => {
  assertEquals(isExcludedEvent("Show para Niños en el Parque"), true);
});

// ─── Comedia / Stand-up ───────────────────────────────────────────────────────

Deno.test("isExcludedEvent - stand-up comedy → excluido", () => {
  assertEquals(isExcludedEvent("Stand-Up Comedy Night"), true);
});

Deno.test("isExcludedEvent - comedia → excluido", () => {
  assertEquals(isExcludedEvent("Noche de Comedia"), true);
});

// ─── Filtro por categoría explícita ──────────────────────────────────────────

Deno.test("isExcludedEvent - categoría 'Teatro' → excluido", () => {
  assertEquals(isExcludedEvent("Evento cualquiera", null, "Teatro"), true);
});

Deno.test("isExcludedEvent - categoría 'Ballet' → excluido", () => {
  assertEquals(isExcludedEvent("Gran Función", null, "Ballet"), true);
});

Deno.test("isExcludedEvent - categoría 'Conferencia' → excluido", () => {
  assertEquals(isExcludedEvent("Evento X", null, "Conferencia"), true);
});

Deno.test("isExcludedEvent - categoría con tilde normalizada ('Ópera') → excluido", () => {
  assertEquals(isExcludedEvent("Gran Gala", null, "Ópera"), true);
});

Deno.test("isExcludedEvent - categoría 'Concierto' no excluye", () => {
  assertEquals(isExcludedEvent("Rock Festival", null, "Concierto"), false);
});

// ─── EXCLUDED_SKIP_REASON ─────────────────────────────────────────────────────

Deno.test("EXCLUDED_SKIP_REASON - tiene el valor correcto", () => {
  assertEquals(EXCLUDED_SKIP_REASON, "excluded_out_of_scope");
});

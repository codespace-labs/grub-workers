import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
const assertNull = (v: unknown) => assertEquals(v, null);
import {
  resolveEventLocation,
  normalizeVenueAndCity,
  inferCityFromText,
  stripTrailingCityFromEventName,
} from "../../_shared/location-normalization.ts";

// ─── inferCityFromText ────────────────────────────────────────────────────────

Deno.test("inferCityFromText - detecta Lima", () => {
  assertEquals(inferCityFromText("Lima"), "Lima");
  assertEquals(inferCityFromText("lima"), "Lima");
});

Deno.test("inferCityFromText - detecta ciudades peruanas", () => {
  assertEquals(inferCityFromText("Arequipa"), "Arequipa");
  assertEquals(inferCityFromText("aqp"), "Arequipa");
  assertEquals(inferCityFromText("Cusco"), "Cusco");
  assertEquals(inferCityFromText("cuzco"), "Cusco");
  assertEquals(inferCityFromText("Trujillo"), "Trujillo");
  assertEquals(inferCityFromText("Chiclayo"), "Chiclayo");
});

Deno.test("inferCityFromText - distritos de Lima → Lima", () => {
  assertEquals(inferCityFromText("Miraflores"), "Lima");
  assertEquals(inferCityFromText("Barranco"), "Lima");
  assertEquals(inferCityFromText("San Isidro"), "Lima");
  assertEquals(inferCityFromText("Surco"), "Lima");
});

Deno.test("inferCityFromText - texto nulo o vacío retorna null", () => {
  assertNull(inferCityFromText(null));
  assertNull(inferCityFromText(undefined));
  assertNull(inferCityFromText(""));
});

Deno.test("inferCityFromText - texto sin ciudad conocida retorna null", () => {
  assertNull(inferCityFromText("Lugar desconocido XYZ"));
});

// ─── normalizeVenueAndCity ────────────────────────────────────────────────────

Deno.test("normalizeVenueAndCity - venue con ciudad separada por guion", () => {
  const result = normalizeVenueAndCity("Estadio Nacional - Lima");
  assertEquals(result.venue, "Estadio Nacional");
  assertEquals(result.city, "Lima");
  assertEquals(result.country_code, "PE");
});

Deno.test("normalizeVenueAndCity - venue en distrito de Lima", () => {
  const result = normalizeVenueAndCity("Arena Miraflores - Miraflores");
  assertEquals(result.venue, "Arena Miraflores");
  assertEquals(result.city, "Lima");
});

Deno.test("normalizeVenueAndCity - venue sin ciudad → default Lima", () => {
  const result = normalizeVenueAndCity("Estadio Nacional");
  assertEquals(result.venue, "Estadio Nacional");
  assertEquals(result.city, "Lima");
});

Deno.test("normalizeVenueAndCity - venue nulo → todo default", () => {
  const result = normalizeVenueAndCity(null);
  assertNull(result.venue);
  assertEquals(result.city, "Lima");
  assertEquals(result.country_code, "PE");
});

Deno.test("normalizeVenueAndCity - venue vacío → todo default", () => {
  const result = normalizeVenueAndCity("");
  assertNull(result.venue);
  assertEquals(result.city, "Lima");
});

Deno.test("normalizeVenueAndCity - venue solo guion → todo default", () => {
  const result = normalizeVenueAndCity("-");
  assertNull(result.venue);
  assertEquals(result.city, "Lima");
});

// ─── resolveEventLocation ─────────────────────────────────────────────────────

Deno.test("resolveEventLocation - ciudad explícita tiene prioridad", () => {
  const result = resolveEventLocation({
    rawVenue: "Estadio Nacional - Lima",
    explicitCity: "Arequipa",
  });
  assertEquals(result.city, "Arequipa");
});

Deno.test("resolveEventLocation - infiere ciudad desde venue cuando no hay explícita", () => {
  const result = resolveEventLocation({
    rawVenue: "Explanada de Arequipa",
  });
  assertEquals(result.city, "Arequipa");
});

Deno.test("resolveEventLocation - infiere ciudad desde nombre cuando venue no ayuda", () => {
  const result = resolveEventLocation({
    rawName: "Concierto en Cusco 2026",
    rawVenue: "Lugar sin nombre",
  });
  assertEquals(result.city, "Cusco");
});

Deno.test("resolveEventLocation - country_code explícito tiene prioridad", () => {
  const result = resolveEventLocation({
    rawVenue: "Venue",
    countryCode: "CO",
  });
  assertEquals(result.country_code, "CO");
});

Deno.test("resolveEventLocation - default country_code es PE", () => {
  const result = resolveEventLocation({ rawVenue: "Venue Lima" });
  assertEquals(result.country_code, "PE");
});

Deno.test("resolveEventLocation - sin datos → defaults Lima/PE", () => {
  const result = resolveEventLocation({});
  assertEquals(result.city, "Lima");
  assertEquals(result.country_code, "PE");
});

// ─── stripTrailingCityFromEventName ──────────────────────────────────────────

Deno.test("stripTrailingCityFromEventName - quita '- Lima' al final", () => {
  assertEquals(
    stripTrailingCityFromEventName("Foo Fighters - Lima", "Lima"),
    "Foo Fighters"
  );
});

Deno.test("stripTrailingCityFromEventName - quita 'en Lima' al final", () => {
  assertEquals(
    stripTrailingCityFromEventName("Foo Fighters en Lima", "Lima"),
    "Foo Fighters"
  );
});

Deno.test("stripTrailingCityFromEventName - quita '(Lima)' al final", () => {
  assertEquals(
    stripTrailingCityFromEventName("Foo Fighters (Lima)", "Lima"),
    "Foo Fighters"
  );
});

Deno.test("stripTrailingCityFromEventName - quita alias de ciudad (Cusco/Cuzco)", () => {
  assertEquals(
    stripTrailingCityFromEventName("Festival en Cuzco", "Cusco"),
    "Festival"
  );
});

Deno.test("stripTrailingCityFromEventName - no modifica si la ciudad no está al final", () => {
  assertEquals(
    stripTrailingCityFromEventName("Lima Rock Festival", "Lima"),
    "Lima Rock Festival"
  );
});

Deno.test("stripTrailingCityFromEventName - nombre vacío retorna nombre original", () => {
  assertEquals(stripTrailingCityFromEventName("", "Lima"), "");
});

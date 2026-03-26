import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
const assertNull = (v: unknown) => assertEquals(v, null);
import {
  validatePrice,
  extractMinPriceFromMarkdown,
  parseShortDate,
  parseTicketmasterPeDateTime,
  parseTikPeDate,
  toEventRow,
  MIN_VALID_PRICE_PEN,
  type UnifiedEvent,
} from "../../_shared/normalizer.ts";

// ─── validatePrice ────────────────────────────────────────────────────────────

Deno.test("validatePrice - precio válido >= 30 se acepta", () => {
  assertEquals(validatePrice(30), 30);
  assertEquals(validatePrice(50), 50);
  assertEquals(validatePrice(200), 200);
  assertEquals(validatePrice(999.99), 999.99);
});

Deno.test("validatePrice - precio < 30 se descarta", () => {
  assertNull(validatePrice(29.99));
  assertNull(validatePrice(0));
  assertNull(validatePrice(10));
  assertNull(validatePrice(1));
});

Deno.test("validatePrice - null/undefined/NaN se descartan", () => {
  assertNull(validatePrice(null));
  assertNull(validatePrice(undefined));
  assertNull(validatePrice(NaN));
  assertNull(validatePrice(Infinity));
  assertNull(validatePrice(-Infinity));
});

Deno.test(`validatePrice - MIN_VALID_PRICE_PEN es ${MIN_VALID_PRICE_PEN}`, () => {
  assertNull(validatePrice(MIN_VALID_PRICE_PEN - 1));
  assertEquals(validatePrice(MIN_VALID_PRICE_PEN), MIN_VALID_PRICE_PEN);
});

// ─── extractMinPriceFromMarkdown ──────────────────────────────────────────────

Deno.test("extractMinPriceFromMarkdown - extrae precio simple", () => {
  assertEquals(extractMinPriceFromMarkdown("Entrada: S/ 80"), 80);
  assertEquals(extractMinPriceFromMarkdown("S/ 120.00"), 120);
  assertEquals(extractMinPriceFromMarkdown("S/120"), 120);
  assertEquals(extractMinPriceFromMarkdown("S/. 95"), 95);
});

Deno.test("extractMinPriceFromMarkdown - retorna el mínimo cuando hay varios precios", () => {
  assertEquals(extractMinPriceFromMarkdown("Desde S/ 80 hasta S/ 200"), 80);
  assertEquals(extractMinPriceFromMarkdown("S/ 150, S/ 200, S/ 50"), 50);
});

Deno.test("extractMinPriceFromMarkdown - descarta precios < 30 (service fees)", () => {
  assertNull(extractMinPriceFromMarkdown("Cargo S/ 10 + S/ 15"));
  assertNull(extractMinPriceFromMarkdown("Fee: S/ 5"));
});

Deno.test("extractMinPriceFromMarkdown - retorna null si no hay precios", () => {
  assertNull(extractMinPriceFromMarkdown("Evento gratuito"));
  assertNull(extractMinPriceFromMarkdown(""));
  assertNull(extractMinPriceFromMarkdown("Precio: $50 USD"));
});

Deno.test("extractMinPriceFromMarkdown - precio con coma decimal", () => {
  assertEquals(extractMinPriceFromMarkdown("S/ 80,50"), 80.5);
});

// ─── parseShortDate ───────────────────────────────────────────────────────────

Deno.test("parseShortDate - formato Joinnus '20MAR'", () => {
  const result = parseShortDate("20MAR");
  assertEquals(result?.slice(5, 10), "03-20");
  assertEquals(result?.slice(-6), "-05:00");
});

Deno.test("parseShortDate - formato Vastion '04 ABR'", () => {
  const result = parseShortDate("04 ABR");
  assertEquals(result?.slice(5, 10), "04-04");
});

Deno.test("parseShortDate - acepta meses con tilde (DIC, ENE)", () => {
  const dic = parseShortDate("15DIC");
  assertEquals(dic?.slice(5, 10), "12-15");

  const ene = parseShortDate("01ENE");
  assertEquals(ene?.slice(5, 10), "01-01");
});

Deno.test("parseShortDate - retorna null para formatos inválidos", () => {
  assertNull(parseShortDate(""));
  assertNull(parseShortDate("32ENE"));
  assertNull(parseShortDate("20XYZ"));
  assertNull(parseShortDate("abc"));
});

Deno.test("parseShortDate - zona horaria Lima (-05:00)", () => {
  const result = parseShortDate("10JUN");
  assertEquals(result?.endsWith("-05:00"), true);
});

// ─── parseTicketmasterPeDateTime ─────────────────────────────────────────────

Deno.test("parseTicketmasterPeDateTime - parsea fecha y hora completa", () => {
  const { date, start_time } = parseTicketmasterPeDateTime("Miercoles 20 de Mayo - 8:30 pm");
  assertEquals(date?.slice(5, 10), "05-20");
  assertEquals(start_time, "20:30:00");
});

Deno.test("parseTicketmasterPeDateTime - hora AM", () => {
  const { start_time } = parseTicketmasterPeDateTime("Sabado 5 de Junio - 10:00 am");
  assertEquals(start_time, "10:00:00");
});

Deno.test("parseTicketmasterPeDateTime - medianoche (12:00 am → 00:00)", () => {
  const { start_time } = parseTicketmasterPeDateTime("Sabado 5 de Junio - 12:00 am");
  assertEquals(start_time, "00:00:00");
});

Deno.test("parseTicketmasterPeDateTime - mediodia (12:00 pm → 12:00)", () => {
  const { start_time } = parseTicketmasterPeDateTime("Sabado 5 de Junio - 12:00 pm");
  assertEquals(start_time, "12:00:00");
});

Deno.test("parseTicketmasterPeDateTime - sin hora devuelve start_time null", () => {
  const { date, start_time } = parseTicketmasterPeDateTime("Sabado 5 de Junio");
  assertEquals(date?.slice(5, 10), "06-05");
  assertNull(start_time);
});

Deno.test("parseTicketmasterPeDateTime - fecha inválida devuelve ambos null", () => {
  const { date, start_time } = parseTicketmasterPeDateTime("Sin fecha disponible");
  assertNull(date);
  assertNull(start_time);
});

// ─── parseTikPeDate ───────────────────────────────────────────────────────────

Deno.test("parseTikPeDate - formato '25 mar. 2026'", () => {
  assertEquals(parseTikPeDate("25 mar. 2026"), "2026-03-25T00:00:00-05:00");
});

Deno.test("parseTikPeDate - formato '4 abr. 2026' (día sin cero)", () => {
  assertEquals(parseTikPeDate("4 abr. 2026"), "2026-04-04T00:00:00-05:00");
});

Deno.test("parseTikPeDate - formato sin punto '25 mar 2026'", () => {
  assertEquals(parseTikPeDate("25 mar 2026"), "2026-03-25T00:00:00-05:00");
});

Deno.test("parseTikPeDate - retorna null para formatos inválidos", () => {
  assertNull(parseTikPeDate(""));
  assertNull(parseTikPeDate("25/03/2026"));
  assertNull(parseTikPeDate("2026-03-25"));
  assertNull(parseTikPeDate("25 xyz 2026"));
});

Deno.test("parseTikPeDate - descarta años fuera de rango", () => {
  assertNull(parseTikPeDate("25 mar. 2019")); // < 2020
  assertNull(parseTikPeDate("25 mar. 2200")); // > 2100
});

// ─── toEventRow ───────────────────────────────────────────────────────────────

const BASE_EVENT: UnifiedEvent = {
  source: "ticketmaster",
  ticket_url: "https://ticketmaster.pe/event/1",
  external_slug: "event-1",
  name: "Concierto Test",
  date: "2026-05-24T20:00:00-05:00",
  start_time: "20:00:00",
  venue: "Estadio Nacional",
  city: "Lima",
  country_code: "PE",
  cover_url: "https://img.example.com/cover.jpg",
  price_min: 80,
  price_max: 200,
  lineup: ["Artista A", "Artista B"],
  description: "Un gran concierto",
  genre_slugs: ["rock"],
  is_active: true,
  scraper_version: "1.0",
};

Deno.test("toEventRow - mapea todos los campos correctamente", () => {
  const row = toEventRow(BASE_EVENT, "venue-uuid-123");
  assertEquals(row.name, "Concierto Test");
  assertEquals(row.date, "2026-05-24T20:00:00-05:00");
  assertEquals(row.venue, "Estadio Nacional");
  assertEquals(row.venue_id, "venue-uuid-123");
  assertEquals(row.city, "Lima");
  assertEquals(row.country_code, "PE");
  assertEquals(row.ticket_url, "https://ticketmaster.pe/event/1");
  assertEquals(row.price_min, 80);
  assertEquals(row.price_max, 200);
  assertEquals(row.lineup, ["Artista A", "Artista B"]);
  assertEquals(row.is_active, true);
  assertEquals(row.source, "ticketmaster");
  assertEquals(row.external_slug, "event-1");
});

Deno.test("toEventRow - descarta precios inválidos (< 30)", () => {
  const row = toEventRow({ ...BASE_EVENT, price_min: 10, price_max: 20 }, null);
  assertNull(row.price_min);
  assertNull(row.price_max);
});

Deno.test("toEventRow - venue_id null cuando no se resuelve el venue", () => {
  const row = toEventRow(BASE_EVENT, null);
  assertNull(row.venue_id);
});

Deno.test("toEventRow - campos opcionales caen a null correctamente", () => {
  const minimal: UnifiedEvent = {
    ...BASE_EVENT,
    venue: undefined,
    cover_url: undefined,
    price_min: undefined,
    price_max: undefined,
    start_time: undefined,
    description: undefined,
    external_slug: undefined,
  };
  const row = toEventRow(minimal, null);
  assertNull(row.venue);
  assertNull(row.cover_url);
  assertNull(row.price_min);
  assertNull(row.price_max);
  assertNull(row.start_time);
  assertNull(row.description);
  assertNull(row.external_slug);
});

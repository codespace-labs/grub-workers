// ─── Normalizer ───────────────────────────────────────────────────────────────
//
// Tipos y funciones de normalización compartidos por todos los adapters.
//
// REGLA DE ORO SOBRE PRECIOS:
//   - Solo se acepta un precio si es un número >= MIN_VALID_PRICE_PEN (S/ 30).
//   - Si el texto scrapeado tiene "S/ 20" (servicio de entrada, fee, etc.)
//     se descarta con validatePrice().
//   - Nunca se infiere ni estima un precio: null es preferible a un valor incorrecto.
//
// REGLA DE ORO SOBRE FECHAS:
//   - Se almacena siempre en ISO 8601.
//   - Si no hay fecha confiable, el adapter devuelve null y el evento se descarta
//     en lugar de guardar una fecha inventada.

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Precio mínimo aceptable en Soles. Valores menores se tratan como ruido. */
export const MIN_VALID_PRICE_PEN = 30;

// ─── Source IDs ───────────────────────────────────────────────────────────────

export type SourceId =
  | "ticketmaster"
  | "teleticket"
  | "joinnus"
  | "passline"
  | "vastion"
  | "tikpe";

// ─── UnifiedEvent ─────────────────────────────────────────────────────────────
//
// Contrato interno entre adapters y la capa de persistencia.
// Cada adapter produce UnifiedEvent[]; el normalizer los convierte a EventRow.

export interface UnifiedEvent {
  // Identidad
  source:          SourceId;
  ticket_url:      string;          // clave de dedup principal
  external_slug?:  string;          // slug nativo de la fuente (dedup secundario)

  // Datos del evento
  name:            string;
  date:            string | null;   // ISO 8601, ej: "2026-05-24T20:00:00-05:00"
  start_time?:     string | null;   // "HH:MM:SS", ej: "20:00:00"

  // Lugar
  venue?:          string | null;
  city:            string;
  country_code:    string;          // ISO 3166-1 alpha-2

  // Medios y precio
  cover_url?:      string | null;
  price_min?:      number | null;   // S/ — solo si está en el sitio, nunca estimado
  price_max?:      number | null;

  // Enriquecimiento
  lineup:          string[];
  description?:    string | null;
  genre_slugs:     string[];        // inferidos antes del DB linking

  // Control
  is_active:       boolean;
  scraper_version: string;
}

// ─── EventRow ─────────────────────────────────────────────────────────────────
//
// Forma exacta de la tabla `events` en Supabase.

export interface EventRow {
  name:          string;
  date:          string | null;
  venue:         string | null;
  venue_id:      string | null;
  city:          string;
  country_code:  string;
  ticket_url:    string;
  cover_url:     string | null;
  price_min:     number | null;
  price_max:     number | null;
  start_time:    string | null;
  lineup:        string[];
  description:   string | null;
  is_active:     boolean;
  source:        string;
  external_slug: string | null;
}

// ─── validatePrice ────────────────────────────────────────────────────────────

/**
 * Retorna el precio si es un número válido >= MIN_VALID_PRICE_PEN, o null.
 *
 * Descarta:
 *   - null / undefined
 *   - NaN / Infinity
 *   - Valores < S/ 30 (service fees, cargos, noise)
 */
export function validatePrice(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value >= MIN_VALID_PRICE_PEN ? value : null;
}

// ─── extractPricesFromMarkdown ────────────────────────────────────────────────

/**
 * Extrae todos los precios en Soles de un texto markdown y retorna el mínimo.
 *
 * Patrones reconocidos:
 *   "S/ 120"   "S/120.00"   "S/ 80.50"   "desde S/ 80"   "S/. 95"
 *
 * Nunca estima ni alucina — si no hay match retorna null.
 */
export function extractMinPriceFromMarkdown(text: string): number | null {
  const re = /S\/\.?\s*(\d{1,6}(?:[.,]\d{1,2})?)/gi;
  const prices: number[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(value)) prices.push(value);
  }

  if (!prices.length) return null;
  const min = Math.min(...prices);
  return validatePrice(min);
}

// ─── toEventRow ───────────────────────────────────────────────────────────────

/**
 * Convierte un UnifiedEvent al formato de fila de Supabase.
 *
 * @param event    Evento normalizado producido por un adapter.
 * @param venue_id UUID del venue ya upsertado, o null si no se pudo resolver.
 */
export function toEventRow(event: UnifiedEvent, venue_id: string | null): EventRow {
  return {
    name:          event.name,
    date:          event.date,
    venue:         event.venue ?? null,
    venue_id,
    city:          event.city,
    country_code:  event.country_code,
    ticket_url:    event.ticket_url,
    cover_url:     event.cover_url ?? null,
    price_min:     validatePrice(event.price_min),
    price_max:     validatePrice(event.price_max),
    start_time:    event.start_time ?? null,
    lineup:        event.lineup,
    description:   event.description ?? null,
    is_active:     event.is_active,
    source:        event.source,
    external_slug: event.external_slug ?? null,
  };
}

// ─── Shared date parsers ──────────────────────────────────────────────────────
//
// Usados por múltiples adapters. Siempre retornan ISO 8601 con zona Lima
// (UTC-5) o null si no se puede parsear con certeza.
// NUNCA se infiere ni se inventa una fecha.

const SHORT_MONTH_MAP: Readonly<Record<string, number>> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, set: 9, sep: 9, oct: 10, nov: 11, dic: 12,
};

/**
 * Parsea formato corto sin año: "20MAR" (Joinnus) o "04 ABR" (Vastion).
 * Infiere el año: usa el actual; si la fecha está > 6 meses en el pasado,
 * asume el año siguiente.
 */
export function parseShortDate(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");

  const m = s.match(/^(\d{1,2})([a-z]{3,4})$/);
  if (!m) return null;

  const day   = parseInt(m[1], 10);
  const month = SHORT_MONTH_MAP[m[2].slice(0, 3)];
  if (!month || day < 1 || day > 31) return null;

  const now  = new Date();
  let   year = now.getFullYear();

  const candidate    = new Date(year, month - 1, day);
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  if (candidate < sixMonthsAgo) year++;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00-05:00`;
}

/**
 * Parsea formato ticketmaster.pe: "Miercoles 20 de Mayo - 8:30 pm"
 * Retorna { date, start_time } — ambos pueden ser null si no se parsean.
 * NUNCA estima hora ni fecha.
 */
export function parseTicketmasterPeDateTime(
  raw: string,
): { date: string | null; start_time: string | null } {
  const s = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  // fecha: "20 de mayo"
  const dateM = s.match(/(\d{1,2})\s+de\s+([a-z]+)/);
  let date: string | null = null;

  if (dateM) {
    const day   = parseInt(dateM[1], 10);
    const month = SHORT_MONTH_MAP[dateM[2].slice(0, 3)];

    if (month && day >= 1 && day <= 31) {
      const now  = new Date();
      let   year = now.getFullYear();

      const candidate    = new Date(year, month - 1, day);
      const sixMonthsAgo = new Date(now);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      if (candidate < sixMonthsAgo) year++;

      date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00-05:00`;
    }
  }

  // hora: "8:30 pm" / "9:00p.m." / "20:30"
  let start_time: string | null = null;
  const timeM = s.match(/(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/);
  if (timeM) {
    let   h  = parseInt(timeM[1], 10);
    const mi = timeM[2];
    const ap = timeM[3]?.replace(/\./g, "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    start_time = `${String(h).padStart(2, "0")}:${mi}:00`;
  }

  return { date, start_time };
}

// ─── SyncResult ───────────────────────────────────────────────────────────────

export interface SyncResult {
  inserted: number;
  updated:  number;
  failed:   number;
  skipped:  number;   // eventos no musicales o sin fecha
  diagnostics?: {
    discovered?: number;
    parsed?: number;
    detail_fetched?: number;
    skipped_reasons?: Record<string, number>;
    [key: string]: unknown;
  };
}

export function emptySyncResult(): SyncResult {
  return {
    inserted: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    diagnostics: {
      discovered: 0,
      parsed: 0,
      detail_fetched: 0,
      skipped_reasons: {},
    },
  };
}

/**
 * Parsea formato tik.pe con año explícito: "25 mar. 2023", "4 abr. 2026".
 * Retorna ISO 8601 con zona Lima (UTC-5) o null si no se puede parsear.
 * NUNCA estima ni inventa — si no hay match retorna null.
 */
export function parseTikPeDate(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  // "25 mar. 2023" o "25 mar 2023"
  const m = s.match(/^(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})$/);
  if (!m) return null;

  const day   = parseInt(m[1], 10);
  const month = SHORT_MONTH_MAP[m[2].slice(0, 3)];
  const year  = parseInt(m[3], 10);

  if (!month || day < 1 || day > 31 || year < 2020 || year > 2100) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00-05:00`;
}

export interface StructuredLocation {
  venue: string | null;
  city: string;
  country_code: string;
}

interface EventLocationInput {
  rawVenue?: string | null;
  rawName?: string | null;
  explicitCity?: string | null;
  countryCode?: string | null;
}

const DEFAULT_COUNTRY_CODE = "PE";
const DEFAULT_CITY = "Lima";

const PERU_CITY_ALIASES: Record<string, string> = {
  lima: "Lima",
  callao: "Callao",
  arequipa: "Arequipa",
  aqp: "Arequipa",
  cusco: "Cusco",
  cuzco: "Cusco",
  trujillo: "Trujillo",
  chiclayo: "Chiclayo",
  piura: "Piura",
  huancayo: "Huancayo",
  ica: "Ica",
  iquitos: "Iquitos",
  tarapoto: "Tarapoto",
  barranca: "Barranca",
  ayacucho: "Ayacucho",
  huaraz: "Huaraz",
  puno: "Puno",
  huacho: "Huacho",
  chimbote: "Chimbote",
  "nuevo chimbote": "Chimbote",
  "san martin": "Tarapoto",
  urubamba: "Cusco",
  maynas: "Iquitos",
};

const LIMA_DISTRICT_ALIASES = new Set([
  "ate",
  "barranco",
  "breña",
  "brena",
  "callao",
  "chorrillos",
  "jesus maria",
  "la molina",
  "la victoria",
  "lince",
  "lurin",
  "magdalena",
  "magdalena del mar",
  "miraflores",
  "pueblo libre",
  "rimac",
  "san borja",
  "san isidro",
  "san juan de lurigancho",
  "san juan de miraflores",
  "san luis",
  "san martin de porres",
  "san miguel",
  "santa anita",
  "surco",
  "santiago de surco",
  "villa el salvador",
  "villa maria del triunfo",
]);

function canonicalKey(value: string): string {
  return normalizeKey(value);
}

function aliasesForCity(city: string): string[] {
  const normalizedCity = canonicalKey(city);
  const aliases = new Set<string>([city]);

  for (const [alias, canonicalCity] of Object.entries(PERU_CITY_ALIASES)) {
    if (canonicalKey(canonicalCity) === normalizedCity) {
      aliases.add(alias);
      aliases.add(canonicalCity);
    }
  }

  return [...aliases]
    .map(normalizeWhitespace)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeKey(value: string): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findCityCandidate(parts: string[]): string | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = normalizeKey(parts[i]);
    if (!part) continue;

    if (PERU_CITY_ALIASES[part]) {
      return PERU_CITY_ALIASES[part];
    }

    if (LIMA_DISTRICT_ALIASES.has(part)) {
      return "Lima";
    }

    for (const [alias, city] of Object.entries(PERU_CITY_ALIASES)) {
      const boundaryPattern = new RegExp(`(?:^|\\s|-)${escapeRegExp(alias)}(?:$|\\s|-)`, "i");
      if (boundaryPattern.test(part)) return city;
    }

    for (const district of LIMA_DISTRICT_ALIASES) {
      const boundaryPattern = new RegExp(`(?:^|\\s|-)${escapeRegExp(district)}(?:$|\\s|-)`, "i");
      if (boundaryPattern.test(part)) return "Lima";
    }
  }

  return null;
}

export function inferCityFromText(rawText: string | null | undefined): string | null {
  if (!rawText) return null;

  const normalized = normalizeKey(rawText);
  if (!normalized) return null;

  if (PERU_CITY_ALIASES[normalized]) {
    return PERU_CITY_ALIASES[normalized];
  }

  const candidates = normalized.split(/\s+-\s+|\s*,\s*|\s+en\s+|\(|\)/g)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const candidate of candidates.reverse()) {
    if (PERU_CITY_ALIASES[candidate]) {
      return PERU_CITY_ALIASES[candidate];
    }

    if (LIMA_DISTRICT_ALIASES.has(candidate)) {
      return "Lima";
    }

    for (const [alias, city] of Object.entries(PERU_CITY_ALIASES)) {
      const boundaryPattern = new RegExp(`(?:^|\\s|-)${escapeRegExp(alias)}(?:$|\\s|-)`, "i");
      if (boundaryPattern.test(candidate)) return city;
    }

    for (const district of LIMA_DISTRICT_ALIASES) {
      const boundaryPattern = new RegExp(`(?:^|\\s|-)${escapeRegExp(district)}(?:$|\\s|-)`, "i");
      if (boundaryPattern.test(candidate)) return "Lima";
    }
  }

  if (LIMA_DISTRICT_ALIASES.has(normalized)) {
    return "Lima";
  }

  for (const [alias, city] of Object.entries(PERU_CITY_ALIASES)) {
    const cityPattern = new RegExp(`(?:^|\\b|\\s|-)${escapeRegExp(alias)}(?:$|\\b|\\s|-)`, "i");
    if (cityPattern.test(normalized)) return city;
  }

  for (const district of LIMA_DISTRICT_ALIASES) {
    const districtPattern = new RegExp(`(?:^|\\b|\\s|-)${escapeRegExp(district)}(?:$|\\b|\\s|-)`, "i");
    if (districtPattern.test(normalized)) return "Lima";
  }

  return null;
}

export function normalizeVenueAndCity(rawVenue: string | null | undefined): StructuredLocation {
  if (!rawVenue) {
    return { venue: null, city: DEFAULT_CITY, country_code: DEFAULT_COUNTRY_CODE };
  }

  const cleaned = normalizeWhitespace(rawVenue);
  if (!cleaned || cleaned === "-") {
    return { venue: null, city: DEFAULT_CITY, country_code: DEFAULT_COUNTRY_CODE };
  }

  const parts = cleaned.split(/\s+-\s+/).map(normalizeWhitespace).filter(Boolean);
  if (!parts.length) {
    return { venue: cleaned, city: DEFAULT_CITY, country_code: DEFAULT_COUNTRY_CODE };
  }

  const venue = parts[0] || null;
  const city = findCityCandidate(parts.slice(1)) ?? DEFAULT_CITY;

  return {
    venue,
    city,
    country_code: DEFAULT_COUNTRY_CODE,
  };
}

export function resolveEventLocation(input: EventLocationInput): StructuredLocation {
  const structuredVenue = normalizeVenueAndCity(input.rawVenue);
  const explicitCity = inferCityFromText(input.explicitCity);
  const venueCity = inferCityFromText(input.rawVenue);
  const nameCity = inferCityFromText(input.rawName);
  const city =
    explicitCity ??
    venueCity ??
    nameCity ??
    structuredVenue.city ??
    DEFAULT_CITY;

  return {
    venue: structuredVenue.venue,
    city,
    country_code: input.countryCode ?? structuredVenue.country_code ?? DEFAULT_COUNTRY_CODE,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripTrailingCityFromEventName(name: string, city: string): string {
  const cleanedName = normalizeWhitespace(name);
  if (!cleanedName || !city) return cleanedName;

  let result = cleanedName;
  for (const alias of aliasesForCity(city)) {
    const cityPattern = escapeRegExp(alias);
    const patterns = [
      new RegExp(`\\s+-\\s*${cityPattern}\\s*$`, "i"),
      new RegExp(`\\s+en\\s+${cityPattern}\\s*$`, "i"),
      new RegExp(`\\s*\\(${cityPattern}\\)\\s*$`, "i"),
    ];

    for (const pattern of patterns) {
      result = result.replace(pattern, "").trim();
    }
  }

  return result || cleanedName;
}

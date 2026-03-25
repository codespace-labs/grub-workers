// ─── Firecrawl client ─────────────────────────────────────────────────────────
//
// Wrapper sobre la API REST de Firecrawl v2.
//
// MODO: markdown únicamente (1 crédito / página).
// NO se usa LLM extract — los precios y géneros se parsean de forma
// determinista sobre el markdown limpio que devuelve este cliente.
//
// CRÉDITOS aproximados:
//   scrape markdown:  1 crédito / URL
//   LLM extract:     ~5 créditos / URL  ← nunca usar aquí
//
// Env requerida: FIRECRAWL_API_KEY (Supabase Edge Function secret)

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const FIRECRAWL_BASE    = "https://api.firecrawl.dev/v2";

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface FirecrawlScrapeOptions {
  /** ms a esperar tras el rendering JS antes de capturar (default 0). */
  waitFor?: number;
  /** Acciones de browser para scroll infinito / clicks. */
  actions?: FirecrawlAction[];
}

export type FirecrawlAction =
  | { type: "scroll"; direction: "down" | "up"; amount: number }
  | { type: "click"; selector: string }
  | { type: "wait"; milliseconds: number };

export interface FirecrawlResult {
  markdown:   string;
  url:        string;
  statusCode: number;
}

export interface FirecrawlHtmlResult {
  html:       string;
  url:        string;
  statusCode: number;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function redactKey(msg: string): string {
  if (!FIRECRAWL_API_KEY) return msg;
  return msg.replaceAll(FIRECRAWL_API_KEY, "[REDACTED]");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── scrapeMarkdown ───────────────────────────────────────────────────────────

/**
 * Hace scraping de una URL con Firecrawl y devuelve markdown limpio.
 *
 * - Reintentos: hasta `maxRetries` veces con backoff exponencial.
 * - Nunca usa LLM extract para no consumir créditos adicionales
 *   ni arriesgar alucinaciones en precios / fechas.
 * - Lanza `FirecrawlError` si falla tras todos los reintentos.
 */
export async function scrapeMarkdown(
  url: string,
  opts: FirecrawlScrapeOptions = {},
  maxRetries = 3,
  baseBackoffMs = 2000,
): Promise<FirecrawlResult> {
  const body: Record<string, unknown> = {
    url,
    formats: ["markdown"],
  };

  if (opts.waitFor)  body.waitFor = opts.waitFor;
  if (opts.actions?.length) body.actions = opts.actions;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        // Rate limit: esperar más antes de reintentar
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
        console.warn(`[firecrawl] rate-limited → esperando ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }

      const json = await res.json() as {
        success: boolean;
        data?: {
          markdown?:  string;
          metadata?:  { statusCode?: number; url?: string };
        };
        error?: string;
      };

      if (!json.success || !json.data?.markdown) {
        const msg = redactKey(json.error ?? `HTTP ${res.status} sin markdown`);
        throw new FirecrawlError(msg, res.status);
      }

      return {
        markdown:   json.data.markdown,
        url:        json.data.metadata?.url ?? url,
        statusCode: json.data.metadata?.statusCode ?? res.status,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const safeMsg = redactKey(lastError.message);

      if (attempt < maxRetries) {
        const wait = baseBackoffMs * 2 ** attempt;
        console.warn(
          `[firecrawl] intento ${attempt + 1}/${maxRetries + 1} fallido: ${safeMsg}` +
          ` — reintentando en ${wait}ms`,
        );
        await sleep(wait);
      } else {
        console.error(
          `[firecrawl] todos los reintentos agotados para ${url}: ${safeMsg}`,
        );
      }
    }
  }

  throw new FirecrawlError(
    redactKey(lastError?.message ?? "error desconocido"),
    0,
  );
}

export async function scrapeHtml(
  url: string,
  opts: FirecrawlScrapeOptions = {},
  maxRetries = 3,
  baseBackoffMs = 2000,
): Promise<FirecrawlHtmlResult> {
  const body: Record<string, unknown> = {
    url,
    formats: ["html"],
  };

  if (opts.waitFor) body.waitFor = opts.waitFor;
  if (opts.actions?.length) body.actions = opts.actions;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
        console.warn(`[firecrawl] rate-limited → esperando ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }

      const json = await res.json() as {
        success: boolean;
        data?: {
          html?: string;
          metadata?: { statusCode?: number; url?: string };
        };
        error?: string;
      };

      if (!json.success || !json.data?.html) {
        const msg = redactKey(json.error ?? `HTTP ${res.status} sin html`);
        throw new FirecrawlError(msg, res.status);
      }

      return {
        html: json.data.html,
        url: json.data.metadata?.url ?? url,
        statusCode: json.data.metadata?.statusCode ?? res.status,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const safeMsg = redactKey(lastError.message);

      if (attempt < maxRetries) {
        const wait = baseBackoffMs * 2 ** attempt;
        console.warn(
          `[firecrawl] intento ${attempt + 1}/${maxRetries + 1} fallido: ${safeMsg}` +
          ` — reintentando en ${wait}ms`,
        );
        await sleep(wait);
      } else {
        console.error(
          `[firecrawl] todos los reintentos agotados para ${url}: ${safeMsg}`,
        );
      }
    }
  }

  throw new FirecrawlError(
    redactKey(lastError?.message ?? "error desconocido"),
    0,
  );
}

// ─── FirecrawlError ───────────────────────────────────────────────────────────

export class FirecrawlError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "FirecrawlError";
  }
}

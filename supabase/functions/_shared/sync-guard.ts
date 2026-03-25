import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emptySyncResult, type SyncResult } from "./normalizer.ts";

export interface NoChangeGuardOptions {
  source: string;
  cooldownMinutes: number;
  forceRefresh?: boolean;
}

export interface NoChangeGuardState {
  skip: boolean;
  reason?: string;
  previousStartedAt?: string | null;
  cooldownMinutes: number;
}

export async function shouldSkipRecentNoChangeRun(
  supabase: SupabaseClient,
  options: NoChangeGuardOptions,
): Promise<NoChangeGuardState> {
  if (options.forceRefresh) {
    return { skip: false, cooldownMinutes: options.cooldownMinutes };
  }

  const { data, error } = await supabase
    .schema("ingestion")
    .from("sync_run_items")
    .select("inserted_count, updated_count, started_at, status")
    .eq("source", options.source)
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`[sync-guard] no se pudo leer último sync de ${options.source}:`, error.message);
    return { skip: false, cooldownMinutes: options.cooldownMinutes };
  }

  if (!data?.started_at) {
    return { skip: false, cooldownMinutes: options.cooldownMinutes };
  }

  const inserted = Number(data.inserted_count ?? 0);
  const updated = Number(data.updated_count ?? 0);
  if (inserted > 0 || updated > 0) {
    return { skip: false, cooldownMinutes: options.cooldownMinutes, previousStartedAt: data.started_at };
  }

  const startedAtMs = Date.parse(data.started_at);
  if (Number.isNaN(startedAtMs)) {
    return { skip: false, cooldownMinutes: options.cooldownMinutes, previousStartedAt: data.started_at };
  }

  const ageMs = Date.now() - startedAtMs;
  const cooldownMs = options.cooldownMinutes * 60 * 1000;

  if (ageMs < cooldownMs) {
    return {
      skip: true,
      reason: "recent_no_change_window",
      previousStartedAt: data.started_at,
      cooldownMinutes: options.cooldownMinutes,
    };
  }

  return { skip: false, cooldownMinutes: options.cooldownMinutes, previousStartedAt: data.started_at };
}

export function buildSkippedNoChangeResult(
  source: string,
  guard: NoChangeGuardState,
): SyncResult {
  const result = emptySyncResult();
  result.skipped = 1;
  result.diagnostics = {
    discovered: 0,
    parsed: 0,
    detail_fetched: 0,
    skipped_reasons: {
      [guard.reason ?? "recent_no_change_window"]: 1,
    },
    skip_source: source,
    previous_started_at: guard.previousStartedAt ?? null,
    cooldown_minutes: guard.cooldownMinutes,
    firecrawl_saved: true,
  };
  return result;
}

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VenueInput {
  name:         string;
  city:         string;
  country_code?: string;
  address?:     string;
  lat?:         number;
  lng?:         number;
}

// ─── upsertVenue ─────────────────────────────────────────────────────────────
//
// Inserts or updates a venue row and returns its UUID.
//
// Conflict target: (name, city) — matches the UNIQUE constraint
//   CONSTRAINT venues_name_city_unique UNIQUE (name, city)
//
// On conflict the row is updated with any non-null fields supplied,
// preserving existing values for fields that are omitted.
//
// Returns null if the upsert fails (error is logged to console).

export async function upsertVenue(
  supabase: SupabaseClient,
  input: VenueInput,
): Promise<string | null> {
  const row: Record<string, unknown> = {
    name:         input.name.trim(),
    city:         input.city.trim(),
    country_code: input.country_code ?? "PE",
  };

  if (input.address !== undefined) row.address = input.address.trim() || null;
  if (input.lat     !== undefined) row.lat     = input.lat;
  if (input.lng     !== undefined) row.lng     = input.lng;

  const { data, error } = await supabase
    .from("venues")
    .upsert(row, { onConflict: "name,city", ignoreDuplicates: false })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[upsertVenue] failed:", error?.message ?? "no data returned", { input });
    return null;
  }

  return data.id as string;
}

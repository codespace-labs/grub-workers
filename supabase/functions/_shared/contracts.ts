export interface PublicFeedEvent {
  id: string;
  name: string;
  date: string;
  cover_url: string | null;
  price_min: number | null;
  venue: string | null;
  city: string | null;
  country_code: string | null;
  genres: { slug: string; name: string }[];
}

export interface SyncRunSummary {
  id: string;
  trigger_source: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: Record<string, unknown>;
}

export type Severity = "critical" | "high" | "notable" | "quiet";
export type Freshness = "fresh" | "delayed" | "stale";

export interface Reason {
  code: string;
  text: string;
  contribution: number;
}

export interface PathPoint {
  t: string;
  price: string;
  /**
   * True when this point follows a genuine break in data collection (the
   * ingestion loop was down, the provider was unreachable, ...) rather than
   * the previous point in the series — never true on a series' first point.
   * The chart must not draw a connecting line across it.
   */
  gap_before: boolean;
}

/** The route a price took across the user's absence window. */
export interface PricePath {
  points: PathPoint[];
  checkpoint_at: string | null;
  checkpoint_price: string;
  window_high: string;
  window_low: string;
  window_start: string;
  window_end: string;
}

export interface Change {
  symbol: string;
  change_type: string;
  severity: Severity;
  score: number;
  previous_value: string;
  current_value: string;
  change_pct: number;
  occurred_at: string;
  source_timestamp: string;
  freshness: Freshness;
  priority: number;
  reasons: Reason[];
  source: string | null;
  path: PricePath | null;
}

export interface Brief {
  watchlist_id: number;
  watchlist_name: string;
  last_checked_at: string | null;
  generated_at: string;
  monitored_count: number;
  meaningful_count: number;
  attention: Change[];
  quiet: Change[];
  unavailable_symbols: string[];
  overall_freshness: Freshness;
  window_truncated: boolean;
  market_source: string;
  degraded: boolean;
}

/** Full-resolution path plus data-trust fields, for the detail view. */
export interface SymbolPathDetail extends PricePath {
  symbol: string;
  current_value: string;
  source: string;
  source_timestamp: string;
  received_at: string | null;
  freshness: Freshness;
  last_checked_at: string | null;
}

export interface MarketSource {
  provider: string;
  mode: "live" | "replay";
  degraded: boolean;
  degraded_reason: string | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  demo_mode: boolean;
}

export interface Item {
  id: number;
  symbol: string;
  priority: number;
  position: number;
  threshold_above: string | null;
  threshold_below: string | null;
}

export interface Watchlist {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  items: Item[];
}

export interface Preferences {
  min_move_pct: number;
  volume_sensitivity: number;
  swing_sensitivity: number;
}

export interface TimelineEntry {
  id: number;
  symbol: string;
  change_type: string;
  severity: Severity;
  score: number;
  previous_value: string;
  current_value: string;
  change_pct: number;
  detected_at: string;
  source_timestamp: string;
  freshness: Freshness;
  reasons: Reason[];
}

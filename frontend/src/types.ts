export type Severity = "critical" | "high" | "notable" | "quiet";
export type Freshness = "fresh" | "delayed" | "stale";

export interface Reason {
  code: string;
  text: string;
  contribution: number;
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

import type { Freshness, Severity } from "./types";

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 7200) return "an hour ago";
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  if (seconds < 172800) return "yesterday";
  return `${Math.round(seconds / 86400)} days ago`;
}

export function clockTime(iso: string | null): string {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3h 12m", "48m", "2d 4h" — the length of an absence window. */
export function durationBetween(
  startIso: string | null,
  endIso: string,
): string {
  if (!startIso) return "your first visit";
  let mins = Math.max(
    0,
    Math.round(
      (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000,
    ),
  );
  const days = Math.floor(mins / 1440);
  mins -= days * 1440;
  const hours = Math.floor(mins / 60);
  mins -= hours * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins && !days) parts.push(`${mins}m`);
  return parts.join(" ") || "moments";
}

export function signedPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function price(value: string): string {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const severityStyles: Record<
  Severity,
  { border: string; text: string; label: string }
> = {
  critical: {
    border: "border-l-sev-critical",
    text: "text-sev-critical",
    label: "Critical",
  },
  high: { border: "border-l-sev-high", text: "text-sev-high", label: "High" },
  notable: {
    border: "border-l-sev-notable",
    text: "text-sev-notable",
    label: "Notable",
  },
  quiet: { border: "border-l-sev-quiet", text: "text-sev-quiet", label: "Quiet" },
};

/**
 * Freshness copy. The headline label is decided by the data *source* first:
 * replay data is never called "Live" no matter how recent, because it is not a
 * live market. `age` copy still applies to a real live feed.
 */
export function freshnessLabel(freshness: Freshness, source: string): string {
  const isSimulated = source === "replay" || source === "failing";
  if (isSimulated) return freshness === "stale" ? "Replay · stale" : "Replay data";
  return { fresh: "Live", delayed: "Delayed", stale: "Stale" }[freshness];
}

export const freshnessHelp: Record<Freshness, string> = {
  fresh: "Source timestamp is under a minute old.",
  delayed:
    "Source timestamp is 1–15 minutes old. Rankings are weighted down accordingly.",
  stale:
    "Source timestamp is over 15 minutes old. This is the last known good state, not the current market.",
};

/** The source chip in the app header. */
export function sourceCopy(source: {
  provider: string;
  mode: "live" | "replay";
  degraded: boolean;
}): { label: string; help: string; tone: "sim" | "live" | "degraded" } {
  if (source.degraded)
    return {
      label: "Degraded",
      help: "The live feed failed; showing deterministic replay data as a fallback.",
      tone: "degraded",
    };
  if (source.mode === "live" && source.provider !== "replay")
    return {
      label: "Live market data",
      help: `Live feed via ${source.provider}.`,
      tone: "live",
    };
  return {
    label: "Replay data",
    help: "Deterministic simulated market — reproducible, not a live exchange feed.",
    tone: "sim",
  };
}

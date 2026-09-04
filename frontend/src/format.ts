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

export const freshnessCopy: Record<
  Freshness,
  { label: string; dot: string; text: string; help: string }
> = {
  fresh: {
    label: "Live",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
    help: "Data is under a minute old.",
  },
  delayed: {
    label: "Delayed",
    dot: "bg-amber-400",
    text: "text-amber-300",
    help: "Data is between 1 and 15 minutes old. Rankings are weighted down accordingly.",
  },
  stale: {
    label: "Stale",
    dot: "bg-rose-400",
    text: "text-rose-300",
    help: "Data is over 15 minutes old. This is the last known good state, not the current market.",
  },
};

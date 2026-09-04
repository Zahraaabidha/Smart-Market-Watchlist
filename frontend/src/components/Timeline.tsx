import type { TimelineEntry } from "../types";
import { price, relativeTime, severityStyles, signedPct } from "../format";

/**
 * What this watchlist surfaced at previous checks.
 *
 * Grouped by day so the shape of a week is visible at a glance. Entries are
 * records of what was shown at the time, not recomputations, so the wording and
 * score here are exactly what the user read then.
 */
export function Timeline({
  entries,
  loading,
}: {
  entries: TimelineEntry[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 rounded bg-ink-900 animate-pulse" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="border border-dashed border-ink-700 rounded-lg p-12 text-center">
        <h2 className="text-lg font-medium text-slate-300">No history yet</h2>
        <p className="mt-2 text-sm text-slate-500 max-w-sm mx-auto">
          When you mark a brief as read, whatever it surfaced is recorded here —
          so you can look back at what mattered on a given day.
        </p>
      </div>
    );
  }

  const groups = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const day = new Date(entry.detected_at).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const bucket = groups.get(day);
    if (bucket) bucket.push(entry);
    else groups.set(day, [entry]);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">
          What you were told
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Recorded when each brief was marked as read.
        </p>
      </header>

      {[...groups.entries()].map(([day, dayEntries]) => (
        <section key={day}>
          <h2 className="text-xs uppercase tracking-wider text-slate-500 mb-3">
            {day}
          </h2>
          <ol className="border-l border-ink-700 space-y-4 pl-4">
            {dayEntries.map((entry) => {
              const styles = severityStyles[entry.severity];
              return (
                <li key={entry.id} className="relative">
                  <span
                    className={`absolute -left-[21px] top-1.5 w-2 h-2 rounded-full ${styles.text.replace(
                      "text-",
                      "bg-",
                    )}`}
                    aria-hidden="true"
                  />
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <span className="font-medium text-slate-200">
                      {entry.symbol}
                    </span>
                    <span
                      className={`text-[11px] uppercase tracking-wider ${styles.text}`}
                    >
                      {styles.label}
                    </span>
                    <span
                      className={`tnum text-sm ${
                        entry.change_pct > 0
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {signedPct(entry.change_pct)}
                    </span>
                    <span className="text-xs text-slate-600 tnum">
                      {price(entry.previous_value)} →{" "}
                      {price(entry.current_value)}
                    </span>
                    <span className="text-xs text-slate-600 ml-auto">
                      {relativeTime(entry.detected_at)}
                    </span>
                  </div>
                  {entry.reasons.length > 0 && (
                    <p className="mt-1 text-sm text-slate-400">
                      {entry.reasons[0].text}
                      {entry.reasons.length > 1 && (
                        <span className="text-slate-600">
                          {" "}
                          +{entry.reasons.length - 1} more
                        </span>
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

import type { TimelineEntry } from "@/types";
import { clockTime, price, signedPct } from "@/format";
import { Card, CardBody, SeverityBadge, Skeleton } from "@/components/ui";
import { companyName } from "@/universe";

/**
 * What this watchlist surfaced at previous checks — a market-event timeline.
 *
 * Entries are records of what was shown at the time, not recomputations, so the
 * wording and score are exactly what the user read then. Grouped by day so the
 * shape of a week is visible at a glance.
 */
export function Timeline({
  entries,
  loading,
  watchedSymbols,
  onOpenPath,
}: {
  entries: TimelineEntry[];
  loading: boolean;
  watchedSymbols: string[];
  onOpenPath: (symbol: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <Card className="border-dashed">
        <CardBody className="py-14 text-center">
          <h2 className="text-lg font-semibold text-ink-900">No history yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-500">
            When you mark a brief as read, whatever it surfaced is recorded here
            — so you can look back at what mattered on a given day.
          </p>
        </CardBody>
      </Card>
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

  const watched = new Set(watchedSymbols);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">
          Market events you were told about
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          Recorded when each brief was marked as read.
        </p>
      </header>

      {[...groups.entries()].map(([day, dayEntries]) => (
        <section key={day}>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
            {day}
          </h2>
          <ol className="space-y-2">
            {dayEntries.map((entry) => {
              const up = entry.change_pct > 0;
              const canDrill = watched.has(entry.symbol);
              return (
                <li key={entry.id}>
                  <Card
                    className={
                      canDrill
                        ? "cursor-pointer transition-shadow hover:shadow-pop"
                        : ""
                    }
                  >
                    <button
                      type="button"
                      disabled={!canDrill}
                      onClick={() => canDrill && onOpenPath(entry.symbol)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
                    >
                      <span className="w-12 shrink-0 text-xs tabular-nums text-ink-400">
                        {clockTime(entry.detected_at)}
                      </span>
                      <span
                        className={
                          "h-2 w-2 shrink-0 rounded-full " +
                          (entry.severity === "critical"
                            ? "bg-sev-critical"
                            : entry.severity === "high"
                              ? "bg-sev-high"
                              : entry.severity === "notable"
                                ? "bg-sev-notable"
                                : "bg-sev-quiet")
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-semibold text-ink-900">
                            {entry.symbol}
                          </span>
                          <span className="truncate text-xs text-ink-400">
                            {companyName(entry.symbol)}
                          </span>
                          <SeverityBadge severity={entry.severity} />
                        </div>
                        {entry.reasons.length > 0 && (
                          <p className="mt-0.5 truncate text-sm text-ink-500">
                            {entry.reasons[0].text}
                            {entry.reasons.length > 1 && (
                              <span className="text-ink-400">
                                {" "}
                                +{entry.reasons.length - 1} more
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right tnum">
                        <div
                          className={
                            "text-sm font-semibold " +
                            (up ? "text-up" : "text-down")
                          }
                        >
                          {signedPct(entry.change_pct)}
                        </div>
                        <div className="text-[11px] text-ink-400">
                          {price(entry.previous_value)} →{" "}
                          {price(entry.current_value)}
                        </div>
                      </div>
                      {canDrill && (
                        <span className="shrink-0 text-ink-400">→</span>
                      )}
                    </button>
                  </Card>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

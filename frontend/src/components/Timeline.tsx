import type { TimelineEntry } from "@/types";
import { clockTime, leadReason, price, signedPct } from "@/format";
import { Card, CardBody, SeverityBadge, Skeleton } from "@/components/ui";
import { companyName } from "@/universe";

/**
 * A market-event timeline: what this watchlist surfaced at previous checks.
 * Records, not recomputations - the wording and score are what the user saw
 * then. Tightened to a dense, scannable list; rows drill into the path view.
 */
const dot: Record<TimelineEntry["severity"], string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  notable: "bg-sev-notable",
  quiet: "bg-sev-quiet",
};

/**
 * Two rows are the *same event*, not just the same symbol recurring, only
 * when every fact about them matches: symbol, detection time, the move
 * itself, and the price range it moved across. A symbol legitimately shows
 * up many times with different timestamps/movements/price ranges (different
 * review windows) - that is not a duplicate and must never be collapsed.
 * This only ever removes a row that is a byte-for-byte repeat of another.
 */
function dedupeIdenticalEvents(entries: TimelineEntry[]): TimelineEntry[] {
  const seen = new Set<string>();
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    const key = [
      entry.symbol,
      entry.detected_at,
      entry.change_pct,
      entry.previous_value,
      entry.current_value,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

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
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <Card className="border-dashed">
        <CardBody className="py-14 text-center">
          <h2 className="text-lg font-semibold text-ink-900">No history yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-500">
            When you review a brief, whatever it surfaced is recorded here - so
            you can look back at what mattered on a given day.
          </p>
        </CardBody>
      </Card>
    );
  }

  const groups = new Map<string, TimelineEntry[]>();
  for (const entry of dedupeIdenticalEvents(entries)) {
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
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">
          Market events you were told about
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          Recorded when each brief was reviewed.
        </p>
      </header>

      {[...groups.entries()].map(([day, rows]) => (
        <section key={day}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
            {day}
          </h2>
          <Card>
            <ul className="divide-y divide-line">
              {rows.map((entry) => {
                const up = entry.change_pct > 0;
                const canDrill = watched.has(entry.symbol);
                const company = companyName(entry.symbol);
                const reason = leadReason(entry.reasons);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      disabled={!canDrill}
                      onClick={() => canDrill && onOpenPath(entry.symbol)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors enabled:hover:bg-sunk/50 disabled:cursor-default"
                    >
                      <span className="w-14 shrink-0 whitespace-nowrap tabular-nums text-[11px] text-ink-400">
                        {clockTime(entry.detected_at)}
                      </span>
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[entry.severity]}`}
                      />
                      {/* symbol + company - one fixed-width column, same
                          shape on every row and at every viewport width, so
                          the identity block never overlaps the columns after
                          it. Symbol on top (bold/prominent), company name
                          underneath (smaller, muted) whenever the universe
                          has one for this symbol - including when it's the
                          same word as the symbol (ZOMATO/Zomato, ITC/ITC):
                          consistency across rows matters more than avoiding
                          that visual repeat. */}
                      <span className="w-[6.5rem] shrink-0 sm:w-32" title={entry.symbol}>
                        <span className="block truncate font-semibold text-ink-900">
                          {entry.symbol}
                        </span>
                        {company && (
                          <span className="block truncate text-[11px] font-normal text-ink-400">
                            {company}
                          </span>
                        )}
                      </span>
                      <span className="hidden w-20 shrink-0 sm:block">
                        <SeverityBadge severity={entry.severity} />
                      </span>
                      <span
                        className={`w-20 shrink-0 whitespace-nowrap text-right font-semibold tabular-nums ${
                          up ? "text-up" : "text-down"
                        }`}
                      >
                        {signedPct(entry.change_pct)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-500">
                        since last review
                        {reason && <> · {reason}</>}
                        {entry.reasons.length > 1 && (
                          <span className="text-ink-400">
                            {" "}
                            +{entry.reasons.length - 1}
                          </span>
                        )}
                      </span>
                      <span className="hidden w-40 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-ink-400 lg:block">
                        {price(entry.previous_value)} → {price(entry.current_value)}
                      </span>
                      <span className="w-4 shrink-0 text-right text-ink-300">
                        {canDrill ? "›" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}

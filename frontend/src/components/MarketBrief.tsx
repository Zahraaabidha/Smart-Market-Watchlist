import type { Brief } from "../types";
import { clockTime, freshnessCopy, price, relativeTime, signedPct } from "../format";
import { ChangeCard } from "./ChangeCard";

/**
 * The primary screen.
 *
 * Hierarchy is deliberate and fixed: what changed, what needs attention, why,
 * what is unchanged. Everything above the fold answers "should I care right
 * now?" -- the full watchlist lives on another tab because putting it here
 * would invite exactly the scanning behaviour the product exists to remove.
 */
export function MarketBrief({
  brief,
  onCheckpoint,
  checkpointing,
}: {
  brief: Brief;
  onCheckpoint: () => void;
  checkpointing: boolean;
}) {
  const fresh = freshnessCopy[brief.overall_freshness];
  const nothingChanged = brief.attention.length === 0;

  if (brief.monitored_count === 0) {
    return (
      <div className="border border-dashed border-ink-700 rounded-lg p-12 text-center">
        <h2 className="text-lg font-medium text-slate-300">
          Nothing on this watchlist yet
        </h2>
        <p className="mt-2 text-sm text-slate-500 max-w-sm mx-auto">
          Add a few symbols and the brief will start tracking what changes
          between your visits.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          {nothingChanged
            ? "Nothing needs your attention."
            : `Your market changed since ${clockTime(brief.last_checked_at)}.`}
        </h1>

        <p className="mt-1.5 text-sm text-slate-400">
          {brief.last_checked_at
            ? `Last checked ${relativeTime(brief.last_checked_at)}`
            : "First visit — comparing against the past week"}
          {" · "}
          {brief.monitored_count} monitored
          {" · "}
          <span className={brief.meaningful_count > 0 ? "text-slate-200" : ""}>
            {brief.meaningful_count} meaningful{" "}
            {brief.meaningful_count === 1 ? "change" : "changes"}
          </span>
        </p>

        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${fresh.text}`}
            title={fresh.help}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${fresh.dot}`} />
            {fresh.label}
          </span>
          <span className="text-xs text-slate-600">
            Generated {clockTime(brief.generated_at)}
          </span>
          <button
            onClick={onCheckpoint}
            disabled={checkpointing}
            className="ml-auto text-xs px-3 py-1.5 rounded border border-ink-600 text-slate-300
                       hover:bg-ink-800 disabled:opacity-50 transition-colors"
          >
            {checkpointing ? "Saving…" : "Mark as read"}
          </button>
        </div>
      </header>

      {/* Trust warnings sit above the content they qualify, never below it. */}
      {brief.overall_freshness === "stale" && (
        <div className="rounded-md border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
          <strong className="font-medium">Showing last known data.</strong>{" "}
          {fresh.help}
        </div>
      )}

      {brief.window_truncated && (
        <div className="rounded-md border border-ink-600 bg-ink-900 px-4 py-3 text-sm text-slate-300">
          <strong className="font-medium">Long absence.</strong> You were away
          longer than the 7-day history window, so this compares against the
          last 7 days rather than your actual previous visit.
        </div>
      )}

      {brief.unavailable_symbols.length > 0 && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
          <strong className="font-medium">No data available</strong> for{" "}
          {brief.unavailable_symbols.join(", ")}. These are excluded from the
          brief rather than shown as unchanged.
        </div>
      )}

      {brief.attention.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-slate-500 mb-3">
            Needs attention
          </h2>
          <div className="space-y-3">
            {brief.attention.map((change) => (
              <ChangeCard key={change.symbol} change={change} />
            ))}
          </div>
        </section>
      )}

      {nothingChanged && brief.quiet.length > 0 && (
        <p className="text-sm text-slate-400 -mt-4">
          All {brief.quiet.length} tracked{" "}
          {brief.quiet.length === 1 ? "symbol" : "symbols"} moved within their
          normal range and below your thresholds.
        </p>
      )}

      {brief.quiet.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-slate-500 mb-3">
            No meaningful change ({brief.quiet.length})
          </h2>
          {/* Shown compactly rather than hidden. "We checked these and they
              were fine" is information; silently omitting them would leave the
              user unsure whether they were monitored at all. */}
          <div className="rounded-md border border-ink-800 divide-y divide-ink-800">
            {brief.quiet.map((change) => (
              <div
                key={change.symbol}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <span className="text-slate-400">{change.symbol}</span>
                <span className="flex items-center gap-4 tnum">
                  <span className="text-slate-500">
                    {price(change.current_value)}
                  </span>
                  <span
                    className={`w-16 text-right ${
                      change.change_pct > 0
                        ? "text-emerald-600"
                        : change.change_pct < 0
                          ? "text-rose-600"
                          : "text-slate-600"
                    }`}
                  >
                    {signedPct(change.change_pct)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

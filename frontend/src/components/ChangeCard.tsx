import { useState } from "react";
import type { Change } from "../types";
import {
  clockTime,
  freshnessCopy,
  price,
  severityStyles,
  signedPct,
} from "../format";

/**
 * One surfaced change.
 *
 * The layout answers the product's three questions in reading order: what
 * changed (headline), why it matters (the move and its context), and why the
 * system surfaced it (the reason list). The reason list is expanded by default
 * for critical and high items -- if the system woke you up, it should not also
 * make you click to find out why.
 */
export function ChangeCard({ change }: { change: Change }) {
  const styles = severityStyles[change.severity];
  const urgent = change.severity === "critical" || change.severity === "high";
  const [open, setOpen] = useState(urgent);
  const fresh = freshnessCopy[change.freshness];
  const up = change.change_pct > 0;

  return (
    <article
      className={`border-l-2 ${styles.border} bg-ink-900 rounded-r-md`}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold tracking-tight text-slate-100">
                {change.symbol}
              </h3>
              <span
                className={`text-[11px] uppercase tracking-wider ${styles.text}`}
              >
                {styles.label}
              </span>
              {change.priority === 1 && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-700 text-slate-400">
                  Priority
                </span>
              )}
            </div>

            <p
              className={`mt-1 text-2xl font-semibold tnum ${
                up ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {signedPct(change.change_pct)}
            </p>

            <p className="mt-1 text-sm text-slate-400 tnum">
              {price(change.previous_value)} → {price(change.current_value)}
              <span className="text-slate-500">
                {" "}
                · since you last checked
              </span>
            </p>
          </div>

          <div className="text-right shrink-0">
            {/* The score is shown next to the reasons that produce it, never
                on its own -- a bare number would be the opaque confidence
                score this product is trying not to be. */}
            <div className="text-xs text-slate-500">Attention score</div>
            <div className="text-xl font-semibold tnum text-slate-300">
              {change.score.toFixed(0)}
            </div>
            <div
              className={`mt-1 flex items-center justify-end gap-1.5 text-[11px] ${fresh.text}`}
              title={fresh.help}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${fresh.dot}`} />
              {fresh.label}
            </div>
          </div>
        </div>

        <button
          onClick={() => setOpen(!open)}
          className="mt-3 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          aria-expanded={open}
        >
          {open ? "Hide" : "Show"} why this surfaced ({change.reasons.length})
        </button>

        {open && (
          <ul className="mt-2 space-y-1.5 border-t border-ink-700 pt-3">
            {change.reasons.map((reason) => (
              <li
                key={reason.code}
                className="flex gap-3 text-sm text-slate-300"
              >
                <span className="text-slate-600 select-none">·</span>
                <span className="flex-1">{reason.text}</span>
                {reason.contribution > 0 && (
                  <span className="text-xs text-slate-500 tnum shrink-0">
                    +{reason.contribution.toFixed(0)}
                  </span>
                )}
              </li>
            ))}
            <li className="pt-1 text-[11px] text-slate-600">
              Source timestamp {clockTime(change.source_timestamp)}
            </li>
          </ul>
        )}
      </div>
    </article>
  );
}

import type { Change } from "@/types";
import {
  clockTime,
  freshnessHelp,
  freshnessLabel,
  price,
  signedPct,
} from "@/format";
import {
  Card,
  Disclosure,
  FreshnessChip,
  SeverityBadge,
} from "@/components/ui";
import { Sparkline } from "./Sparkline";

/**
 * One surfaced change.
 *
 * The layout answers the product's questions in reading order: what changed
 * (symbol, move), the route it took (sparkline), why it surfaced (reasons,
 * behind progressive disclosure — expanded by default when the system judged
 * it urgent), and whether the data is trustworthy (freshness + source).
 */
export function AttentionCard({
  change,
  company,
  marketSource,
  onOpenPath,
}: {
  change: Change;
  company: string | null;
  marketSource: string;
  onOpenPath: () => void;
}) {
  const urgent = change.severity === "critical" || change.severity === "high";
  const up = change.change_pct > 0;
  const swing = change.reasons.find((r) => r.code === "intrawindow_swing");
  const accent =
    change.severity === "critical"
      ? "before:bg-sev-critical"
      : change.severity === "high"
        ? "before:bg-sev-high"
        : "before:bg-sev-notable";

  return (
    <Card
      className={
        "relative overflow-hidden pl-4 " +
        "before:absolute before:inset-y-0 before:left-0 before:w-1 " +
        accent
      }
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          {/* left: identity + move */}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold tracking-tight text-ink-900">
                {change.symbol}
              </h3>
              {company && (
                <span className="hidden max-w-[22ch] truncate text-sm text-ink-400 sm:inline">
                  {company}
                </span>
              )}
              <SeverityBadge severity={change.severity} />
              {change.priority === 1 && (
                <span className="rounded-md bg-sunk px-1.5 py-0.5 text-[11px] font-medium text-ink-500">
                  Priority
                </span>
              )}
            </div>

            <p
              className={
                "mt-2 text-[28px] font-semibold leading-none tnum " +
                (up ? "text-up" : "text-down")
              }
            >
              {signedPct(change.change_pct)}
            </p>
            <p className="mt-1.5 text-sm text-ink-500 tnum">
              {price(change.previous_value)} → {price(change.current_value)}
              <span className="text-ink-400"> since you last checked</span>
            </p>

            {swing && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-sev-bg-notable px-2 py-1 text-xs font-medium text-sev-notable">
                <SwingIcon />
                {swingHeadline(swing.text) ?? "Swung further than it settled"}
              </p>
            )}
          </div>

          {/* right: path + score + trust */}
          <div className="flex shrink-0 flex-col items-end gap-2">
            {change.path && (
              <Sparkline path={change.path} className="opacity-95" />
            )}
            <div className="text-right">
              <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Attention score
              </div>
              <div className="text-xl font-semibold tnum text-ink-700">
                {change.score.toFixed(0)}
              </div>
            </div>
            <FreshnessChip
              freshness={change.freshness}
              label={freshnessLabel(change.freshness, marketSource)}
              title={freshnessHelp[change.freshness]}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
          <Disclosure
            defaultOpen={urgent}
            summary={(open) =>
              `${open ? "Hide" : "Why this surfaced"} (${change.reasons.length})`
            }
          >
            <ul className="space-y-2">
              {change.reasons.map((reason) => (
                <li key={reason.code} className="text-sm text-ink-700">
                  <div className="flex items-baseline gap-2">
                    <span className="flex-1">{reason.text}</span>
                    {reason.contribution > 0 && (
                      <span className="shrink-0 text-xs font-medium tnum text-ink-400">
                        +{reason.contribution.toFixed(0)}
                      </span>
                    )}
                  </div>
                  {reason.contribution > 0 && (
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-sunk">
                      <div
                        className="h-full rounded-full bg-ink-400"
                        style={{
                          width: `${Math.min(100, (reason.contribution / 50) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
              <li className="pt-1 text-[11px] text-ink-400">
                Source timestamp {clockTime(change.source_timestamp)}
                {change.source ? ` · ${change.source}` : ""}
              </li>
            </ul>
          </Disclosure>

          <button
            onClick={onOpenPath}
            className="shrink-0 text-xs font-medium text-accent transition-colors hover:underline"
          >
            View path →
          </button>
        </div>
      </div>
    </Card>
  );
}

/** Pull the "Swung to X% ... settled at Y%" clause out of the engine's reason. */
function swingHeadline(text: string): string | null {
  const m = text.match(/Swung to (-?\d+\.?\d*)% .*?settled at (-?\d+\.?\d*)%/);
  if (!m) return null;
  return `Swung to ${m[1]}%, settled at ${m[2]}%`;
}

function SwingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1 12 5 6l3 3 3-6 3 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

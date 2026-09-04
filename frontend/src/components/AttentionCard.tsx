import type { Change } from "@/types";
import { freshnessHelp, freshnessLabel, price, signedPct } from "@/format";
import { Card, Disclosure, FreshnessChip, SeverityBadge } from "@/components/ui";
import { companyName } from "@/universe";
import { Sparkline } from "./Sparkline";

/** Pull "Swung to X% ... settled at Y%" out of the engine's reason text. */
function swingHeadline(reasons: Change["reasons"]): string | null {
  const r = reasons.find((x) => x.code === "intrawindow_swing");
  if (!r) return null;
  const m = r.text.match(/Swung to (-?\d+\.?\d*)% .*?settled at (-?\d+\.?\d*)%/);
  return m ? `Swung to ${m[1]}%, settled at ${m[2]}%` : "Swung further than it settled";
}

function accentBar(severity: Change["severity"]): string {
  return severity === "critical"
    ? "before:bg-sev-critical"
    : severity === "high"
      ? "before:bg-sev-high"
      : "before:bg-sev-notable";
}

const rail =
  "relative overflow-hidden before:absolute before:inset-y-0 before:left-0 before:w-1";

/* ------------------------------------------------------------------ */
/*  TOP ATTENTION — the single highest-ranked change, strongest card  */
/* ------------------------------------------------------------------ */

export function TopAttentionCard({
  change,
  marketSource,
  onOpenPath,
}: {
  change: Change;
  marketSource: string;
  onOpenPath: () => void;
}) {
  const up = change.change_pct > 0;
  const swing = swingHeadline(change.reasons);
  const company = companyName(change.symbol);

  return (
    <Card className={`${rail} pl-4 ${accentBar(change.severity)}`}>
      <div className="flex flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
                Top attention
              </span>
              <SeverityBadge severity={change.severity} />
              {change.priority === 1 && (
                <span className="rounded bg-sunk px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                  Priority
                </span>
              )}
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <h3 className="text-xl font-semibold tracking-tight text-ink-900">
                {change.symbol}
              </h3>
              {company && (
                <span className="truncate text-sm text-ink-400">{company}</span>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
              Score
            </div>
            <div className="text-2xl font-semibold tnum text-ink-900">
              {change.score.toFixed(0)}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-end justify-between gap-4">
          <div>
            <p
              className={`text-3xl font-semibold leading-none tnum ${up ? "text-up" : "text-down"}`}
            >
              {signedPct(change.change_pct)}
            </p>
            <p className="mt-1.5 text-xs text-ink-500 tnum">
              {price(change.previous_value)} → {price(change.current_value)}
              <span className="text-ink-400"> since you last checked</span>
            </p>
          </div>
          {change.path && (
            <Sparkline path={change.path} width={150} height={52} area />
          )}
        </div>

        {swing && (
          <p className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-md bg-sev-bg-notable px-2.5 py-1.5 text-xs font-semibold text-sev-notable">
            <SwingIcon />
            {swing}
          </p>
        )}

        <div className="pt-4">
          <Disclosure
            defaultOpen
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
                      <span className="shrink-0 text-xs font-semibold tnum text-ink-400">
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
            </ul>
          </Disclosure>

          <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
            <FreshnessChip
              freshness={change.freshness}
              label={freshnessLabel(change.freshness, change.source ?? marketSource)}
              title={freshnessHelp[change.freshness]}
            />
            <button
              onClick={onOpenPath}
              className="text-xs font-semibold text-accent transition-colors hover:underline"
            >
              View path →
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  COMPACT — every other attention item                             */
/* ------------------------------------------------------------------ */

export function AttentionCard({
  change,
  marketSource,
  onOpenPath,
}: {
  change: Change;
  marketSource: string;
  onOpenPath: () => void;
}) {
  const up = change.change_pct > 0;
  const swing = swingHeadline(change.reasons);
  const company = companyName(change.symbol);
  const topReason = [...change.reasons]
    .filter((r) => r.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)[0];

  return (
    <Card className={`${rail} pl-3.5 ${accentBar(change.severity)} h-full`}>
      <button
        onClick={onOpenPath}
        className="flex h-full w-full flex-col p-4 text-left transition-colors hover:bg-sunk/40"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold tracking-tight text-ink-900">
                {change.symbol}
              </span>
              <SeverityBadge severity={change.severity} />
              {change.priority === 1 && (
                <span className="rounded bg-sunk px-1 py-0.5 text-[9px] font-semibold uppercase text-ink-500">
                  Pri
                </span>
              )}
            </div>
            {company && (
              <div className="truncate text-[11px] text-ink-400">{company}</div>
            )}
          </div>
          <span className="shrink-0 text-right text-[11px] font-medium tnum text-ink-400">
            score {change.score.toFixed(0)}
          </span>
        </div>

        <div className="mt-2 flex items-end justify-between gap-2">
          <div>
            <span
              className={`text-lg font-semibold tnum ${up ? "text-up" : "text-down"}`}
            >
              {signedPct(change.change_pct)}
            </span>
            <div className="text-[11px] text-ink-400 tnum">
              {price(change.previous_value)} → {price(change.current_value)}
            </div>
          </div>
          {change.path && (
            <Sparkline path={change.path} width={92} height={30} />
          )}
        </div>

        {swing ? (
          <p className="mt-2 truncate rounded bg-sev-bg-notable px-1.5 py-1 text-[11px] font-semibold text-sev-notable">
            {swing}
          </p>
        ) : (
          topReason && (
            <p className="mt-2 truncate text-[11px] text-ink-500">
              {topReason.text}{" "}
              <span className="font-semibold text-ink-400">
                +{topReason.contribution.toFixed(0)}
              </span>
            </p>
          )
        )}

        <div className="mt-auto flex items-center justify-between pt-2.5 text-[11px]">
          <FreshnessChip
            freshness={change.freshness}
            label={freshnessLabel(change.freshness, change.source ?? marketSource)}
            title={freshnessHelp[change.freshness]}
          />
          <span className="font-semibold text-accent">View path →</span>
        </div>
      </button>
    </Card>
  );
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

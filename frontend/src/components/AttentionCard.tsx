import type { Change } from "@/types";
import { freshnessHelp, freshnessLabel, leadReason, signedPct } from "@/format";
import { FreshnessChip } from "@/components/ui";
import { companyName } from "@/universe";
import { Sparkline } from "./Sparkline";

/** Pull "Swung to X% ... settled at Y%" out of the engine's reason text. */
function swingHeadline(reasons: Change["reasons"]): string | null {
  const r = reasons.find((x) => x.code === "intrawindow_swing");
  if (!r) return null;
  const m = r.text.match(/Swung to (-?\d+\.?\d*)% .*?settled at (-?\d+\.?\d*)%/);
  return m ? `Swung to ${m[1]}%, settled at ${m[2]}%` : null;
}

/**
 * One dense row in the ranked attention list. Columns fall away cleanly as the
 * viewport narrows so there is never clipped text or horizontal overflow.
 */
export function AttentionRow({
  change,
  marketSource,
  onOpenPath,
}: {
  change: Change;
  marketSource: string;
  onOpenPath: () => void;
}) {
  const up = change.change_pct > 0;
  const company = companyName(change.symbol);
  const lead = swingHeadline(change.reasons) ?? leadReason(change.reasons);
  const dot =
    change.severity === "critical"
      ? "bg-sev-critical"
      : change.severity === "high"
        ? "bg-sev-high"
        : "bg-sev-notable";

  return (
    <button
      onClick={onOpenPath}
      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-sunk/50 sm:gap-3"
    >
      {/* severity */}
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
        title={change.severity}
      />
      {/* symbol — fixed width + truncate so a long ticker (e.g. TATAMOTORS)
          ellipsizes instead of overflowing its box and bleeding into the
          change% column next to it. */}
      <span
        className="w-20 shrink-0 truncate font-semibold text-ink-900 sm:w-24"
        title={change.symbol}
      >
        {change.symbol}
      </span>
      {/* company */}
      <span className="hidden w-28 shrink-0 truncate text-[11px] text-ink-400 lg:block xl:w-36">
        {company ?? ""}
      </span>
      {/* change% — never ellipsized (a truncated number reads as wrong, not
          just cut off), so this is sized to comfortably fit a 3-digit move
          and only prevented from wrapping. */}
      <span
        className={`w-20 shrink-0 whitespace-nowrap text-right font-semibold tabular-nums ${up ? "text-up" : "text-down"}`}
      >
        {signedPct(change.change_pct)}
      </span>
      {/* sparkline */}
      {change.path && (
        <span className="hidden w-[72px] shrink-0 sm:inline-flex">
          <Sparkline path={change.path} width={72} height={22} />
        </span>
      )}
      {/* reason — the only flexible column; takes whatever space the fixed
          columns around it leave. */}
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-500">
        <span className="hidden min-[420px]:inline">{lead}</span>
      </span>
      {/* source / freshness */}
      <span className="hidden w-32 shrink-0 md:block">
        <FreshnessChip
          freshness={change.freshness}
          label={freshnessLabel(change.freshness, change.source ?? marketSource)}
          title={freshnessHelp[change.freshness]}
        />
      </span>
      {/* score */}
      <span className="w-9 shrink-0 whitespace-nowrap text-right text-[11px] font-medium tabular-nums text-ink-400">
        {change.score.toFixed(0)}
      </span>
      {/* drill-down arrow */}
      <span className="w-4 shrink-0 text-right text-ink-300">›</span>
    </button>
  );
}

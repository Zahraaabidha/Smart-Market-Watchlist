import type { Change } from "@/types";
import { freshnessHelp, freshnessLabel, shortReason, signedPct } from "@/format";
import { FreshnessChip } from "@/components/ui";
import { companyName } from "@/universe";
import { Sparkline } from "./Sparkline";

/** Pull "swung to X% ... settled at Y%" out of the engine's reason text. */
function swingHeadline(reasons: Change["reasons"]): string | null {
  const r = reasons.find((x) => x.code === "intrawindow_swing");
  if (!r) return null;
  const m = r.text.match(/Swung to (-?\d+\.?\d*)% .*?settled at (-?\d+\.?\d*)%/);
  return m ? `swung to ${m[1]}%, settled at ${m[2]}%` : null;
}

/**
 * The row's inline explanation — shown directly, no hover required.
 * A swing gets its own richer sentence; otherwise the top one or two
 * contributing reasons, e.g. "threshold crossed" or
 * "threshold crossed · unusual movement".
 */
function inlineReason(reasons: Change["reasons"]): string | null {
  const swing = swingHeadline(reasons);
  if (swing) return swing;

  const contributing = [...reasons]
    .filter((r) => r.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);
  if (contributing.length === 0) return null;

  return contributing.slice(0, 2).map((r) => shortReason(r.code)).join(" · ");
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
  const lead = inlineReason(change.reasons);
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
      {/* symbol — fixed but generous: wide enough that a normal ticker (up
          to ~11 characters, the longest in this app's universe, e.g.
          TATAMOTORS) always renders in full. `truncate` stays on only as a
          last-resort safety net for something genuinely abnormal; it should
          never actually engage for a real symbol. */}
      <span
        className="w-28 shrink-0 truncate font-semibold text-ink-900"
        title={change.symbol}
      >
        {change.symbol}
      </span>
      {/* company — its own column, separate from the symbol; only an
          unusually long company name (not the symbol) ever truncates here. */}
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
      {/* reason — shown inline always (no hover needed for the basic
          explanation); the only flexible column, taking whatever space the
          fixed columns around it leave, ellipsizing rather than wrapping or
          overflowing if that space gets tight. */}
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-500">
        {lead}
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

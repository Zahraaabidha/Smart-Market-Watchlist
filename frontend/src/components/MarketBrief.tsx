import type { Brief } from "@/types";
import {
  clockTime,
  durationBetween,
  freshnessHelp,
  freshnessLabel,
  price,
  relativeTime,
  signedPct,
} from "@/format";
import {
  Card,
  CardBody,
  FreshnessChip,
  SectionLabel,
  Button,
} from "@/components/ui";
import { companyName } from "@/universe";
import { AttentionCard } from "./AttentionCard";

/**
 * The primary screen.
 *
 * Reading order is fixed and answers, in sequence: what changed while you were
 * away, how much of it matters, why each item surfaced, and whether the data
 * can be trusted. The full watchlist lives on the Manage tab — putting it here
 * would invite the scanning the product exists to remove.
 */
export function MarketBrief({
  brief,
  onCheckpoint,
  checkpointing,
  onOpenPath,
}: {
  brief: Brief;
  onCheckpoint: () => void;
  checkpointing: boolean;
  onOpenPath: (symbol: string) => void;
}) {
  const changed = brief.attention.length > 0;
  const highCount = brief.attention.filter(
    (c) => c.severity === "critical" || c.severity === "high",
  ).length;
  const notableCount = brief.attention.length - highCount;

  if (brief.monitored_count === 0) {
    return (
      <Card className="border-dashed">
        <CardBody className="py-14 text-center">
          <h2 className="text-lg font-semibold text-ink-900">
            Nothing on this watchlist yet
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-500">
            Add a few symbols on the Manage tab and the brief will start
            tracking what changes between your visits.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-7">
      {/* --- Hero -------------------------------------------------- */}
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-400">
          {brief.last_checked_at
            ? `While you were away · ${durationBetween(
                brief.last_checked_at,
                brief.generated_at,
              )}`
            : "First visit"}
        </p>
        <h1 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-tight text-ink-900">
          {changed
            ? "Here's what changed while you were away."
            : "Nothing needs your attention."}
        </h1>
        <p className="mt-2 text-sm text-ink-500">
          {brief.last_checked_at
            ? `Last checked ${relativeTime(brief.last_checked_at)} at ${clockTime(
                brief.last_checked_at,
              )}`
            : "Comparing against the past week"}
          {" · updated "}
          {clockTime(brief.generated_at)}
          {" · "}
          {brief.monitored_count} monitored
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FreshnessChip
            freshness={brief.overall_freshness}
            label={freshnessLabel(brief.overall_freshness, brief.market_source)}
            title={freshnessHelp[brief.overall_freshness]}
          />
          <Button
            className="ml-auto"
            size="sm"
            onClick={onCheckpoint}
            disabled={checkpointing}
          >
            {checkpointing ? "Saving…" : "Mark as read"}
          </Button>
        </div>
      </header>

      {/* --- Summary strip -------------------------------------- */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="High attention" value={highCount} tone="high" />
        <Stat label="Notable" value={notableCount} tone="notable" />
        <Stat label="Unchanged" value={brief.quiet.length} tone="quiet" />
      </div>

      {/* --- Trust banners ------------------------------------- */}
      {brief.overall_freshness === "stale" && (
        <Banner tone="critical">
          <strong className="font-semibold">Showing last known data.</strong>{" "}
          {freshnessHelp.stale}
        </Banner>
      )}
      {brief.degraded && (
        <Banner tone="high">
          <strong className="font-semibold">Live feed degraded.</strong> The
          vendor is unavailable, so this is deterministic replay data served as
          a fallback.
        </Banner>
      )}
      {brief.window_truncated && (
        <Banner tone="neutral">
          <strong className="font-semibold">Long absence.</strong> You were away
          longer than the 7-day history window, so this compares against the
          last 7 days rather than your actual previous visit.
        </Banner>
      )}
      {brief.unavailable_symbols.length > 0 && (
        <Banner tone="high">
          <strong className="font-semibold">No data available</strong> for{" "}
          {brief.unavailable_symbols.join(", ")}. Excluded from the brief rather
          than shown as unchanged.
        </Banner>
      )}

      {/* --- Attention --------------------------------------- */}
      {changed && (
        <section className="space-y-3">
          <SectionLabel>Needs attention</SectionLabel>
          {brief.attention.map((change) => (
            <AttentionCard
              key={change.symbol}
              change={change}
              company={companyName(change.symbol)}
              marketSource={brief.market_source}
              onOpenPath={() => onOpenPath(change.symbol)}
            />
          ))}
        </section>
      )}

      {/* --- Unchanged -------------------------------------- */}
      {brief.quiet.length > 0 && (
        <section className="space-y-3">
          <SectionLabel>No meaningful change ({brief.quiet.length})</SectionLabel>
          {!changed && (
            <p className="text-sm text-ink-500">
              All {brief.quiet.length} tracked{" "}
              {brief.quiet.length === 1 ? "symbol" : "symbols"} moved within
              their normal range and below your thresholds.
            </p>
          )}
          <Card>
            <ul className="divide-y divide-line">
              {brief.quiet.map((change) => {
                const up = change.change_pct > 0;
                return (
                  <li
                    key={change.symbol}
                    className="flex items-center justify-between px-4 py-2.5 text-sm"
                  >
                    <span className="font-medium text-ink-700">
                      {change.symbol}
                    </span>
                    <span className="flex items-center gap-5 tnum">
                      <span className="text-ink-500">
                        {price(change.current_value)}
                      </span>
                      <span
                        className={
                          "w-16 text-right " +
                          (change.change_pct === 0
                            ? "text-ink-400"
                            : up
                              ? "text-up"
                              : "text-down")
                        }
                      >
                        {signedPct(change.change_pct)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "high" | "notable" | "quiet";
}) {
  const color =
    value === 0
      ? "text-ink-400"
      : tone === "high"
        ? "text-sev-critical"
        : tone === "notable"
          ? "text-sev-notable"
          : "text-ink-700";
  return (
    <Card>
      <div className="px-4 py-3">
        <div className={"text-2xl font-semibold tnum " + color}>{value}</div>
        <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">
          {label}
        </div>
      </div>
    </Card>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "critical" | "high" | "neutral";
  children: React.ReactNode;
}) {
  const cls =
    tone === "critical"
      ? "border-sev-bg-critical bg-sev-bg-critical text-sev-critical"
      : tone === "high"
        ? "border-sev-bg-high bg-sev-bg-high text-sev-high"
        : "border-line bg-sunk text-ink-700";
  return (
    <div className={"rounded-lg border px-4 py-3 text-sm " + cls}>{children}</div>
  );
}

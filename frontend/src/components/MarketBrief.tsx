import type { Brief } from "@/types";
import {
  clockTime,
  durationBetween,
  freshnessHelp,
  freshnessLabel,
  price,
  relativeTime,
  signedPct,
  sourceCopy,
} from "@/format";
import { Button, Card, CardBody, SectionLabel } from "@/components/ui";
import { AttentionCard, TopAttentionCard } from "./AttentionCard";
import { Sparkline } from "./Sparkline";

/**
 * The Brief, as a restrained Bento dashboard.
 *
 * Card size tracks importance. Reading order is fixed:
 *   1. what changed        — the hero
 *   2. what deserves attention — the large TOP ATTENTION card
 *   3. why                 — its reason contributions
 *   4. can I trust the data — the small Data Trust card
 *   5. what can I ignore    — "Nothing else needs your attention"
 */
export function MarketBrief({
  brief,
  onCheckpoint,
  checkpointing,
  justReviewedAt,
  onOpenPath,
}: {
  brief: Brief;
  onCheckpoint: () => void;
  checkpointing: boolean;
  justReviewedAt: string | null;
  onOpenPath: (symbol: string) => void;
}) {
  const attention = brief.attention;
  const [top, ...rest] = attention;
  const changed = attention.length > 0;
  const highCount = attention.filter(
    (c) => c.severity === "critical" || c.severity === "high",
  ).length;
  const notableCount = attention.length - highCount;
  const src = sourceCopy({
    provider: brief.market_source,
    mode: "replay",
    degraded: brief.degraded,
  });

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
    <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
      {/* ── 1. HERO ─────────────────────────────────────────── */}
      <Card className="md:col-span-6">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
              {brief.last_checked_at
                ? `While you were away · ${durationBetween(brief.last_checked_at, brief.generated_at)}`
                : "First visit"}
            </p>
            <h1 className="mt-1.5 text-[22px] font-semibold leading-tight tracking-tight text-ink-900 sm:text-[26px]">
              {changed
                ? "Here's what changed while you were away."
                : "Nothing needs your attention."}
            </h1>
            <p className="mt-2 text-sm text-ink-500">
              {brief.last_checked_at
                ? `Last checked ${relativeTime(brief.last_checked_at)} · `
                : "Comparing against the past week · "}
              updated {clockTime(brief.generated_at)} · {brief.monitored_count}{" "}
              monitored · {brief.meaningful_count} meaningful ·{" "}
              {brief.quiet.length} unchanged
            </p>
          </div>
          <div className="shrink-0">
            <Button
              size="sm"
              variant="primary"
              onClick={onCheckpoint}
              disabled={checkpointing}
              className="whitespace-nowrap"
            >
              {checkpointing ? "Saving…" : "I've reviewed this"}
            </Button>
          </div>
        </div>
        {justReviewedAt && (
          <div className="border-t border-line bg-sunk/60 px-5 py-2.5 text-xs font-medium text-ink-600">
            Review saved. Your next brief will compare from{" "}
            {clockTime(justReviewedAt)}.
          </div>
        )}
      </Card>

      {/* trust banners (stale / degraded / truncated / unavailable) */}
      {brief.overall_freshness === "stale" && (
        <Banner tone="critical" className="md:col-span-6">
          <strong className="font-semibold">Showing last known data.</strong>{" "}
          {freshnessHelp.stale}
        </Banner>
      )}
      {brief.degraded && (
        <Banner tone="high" className="md:col-span-6">
          <strong className="font-semibold">Live feed degraded.</strong> The
          vendor is unavailable, so this is deterministic replay data served as a
          fallback.
        </Banner>
      )}
      {brief.window_truncated && (
        <Banner tone="neutral" className="md:col-span-6">
          <strong className="font-semibold">Long absence.</strong> You were away
          longer than the 7-day history window, so this compares against the last
          7 days rather than your actual previous visit.
        </Banner>
      )}
      {brief.unavailable_symbols.length > 0 && (
        <Banner tone="high" className="md:col-span-6">
          <strong className="font-semibold">No data available</strong> for{" "}
          {brief.unavailable_symbols.join(", ")}. Excluded from the brief rather
          than shown as unchanged.
        </Banner>
      )}

      {changed ? (
        <>
          {/* ── summary strip ──────────────────────────────── */}
          <div className="grid grid-cols-3 gap-3 md:col-span-6">
            <Stat label="High attention" value={highCount} tone="high" />
            <Stat label="Notable" value={notableCount} tone="notable" />
            <Stat label="Unchanged" value={brief.quiet.length} tone="quiet" />
          </div>

          {/* ── 2. TOP ATTENTION (large) + 4. DATA TRUST (small) */}
          <div className="md:col-span-4">
            <TopAttentionCard
              change={top}
              marketSource={brief.market_source}
              onOpenPath={() => onOpenPath(top.symbol)}
            />
          </div>

          <div className="md:col-span-2">
            <Card>
              <div className="p-4">
                <SectionLabel>Can I trust this data?</SectionLabel>
                <div className="mt-2.5 flex items-center gap-2">
                  <span
                    className={
                      "h-2 w-2 rounded-full " +
                      (src.tone === "live"
                        ? "bg-up"
                        : src.tone === "degraded"
                          ? "bg-sev-high"
                          : "bg-ink-400")
                    }
                  />
                  <span className="text-sm font-semibold text-ink-900">
                    {src.label}
                  </span>
                </div>
                <dl className="mt-3 space-y-1.5 text-[11px] text-ink-500">
                  <Row k="Source" v={brief.market_source} />
                  <Row
                    k="Freshness"
                    v={freshnessLabel(brief.overall_freshness, brief.market_source)}
                  />
                  <Row
                    k="Updated"
                    v={`${clockTime(brief.generated_at)} · ${relativeTime(brief.generated_at)}`}
                  />
                </dl>
                <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-400">
                  {src.help}
                </p>
              </div>
            </Card>
          </div>

          {/* ── "While you were away" visualization (large) ──── */}
          <Card className="md:col-span-6">
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
              <div className="min-w-0 sm:w-64 sm:shrink-0">
                <SectionLabel>While you were away</SectionLabel>
                <p className="mt-1.5 text-sm text-ink-700">
                  <span className="font-semibold text-ink-900">{top.symbol}</span>{" "}
                  moved{" "}
                  <span
                    className={
                      top.change_pct > 0 ? "font-semibold text-up" : "font-semibold text-down"
                    }
                  >
                    {signedPct(top.change_pct)}
                  </span>{" "}
                  end to end.
                  {swingText(top.reasons) && (
                    <> {swingText(top.reasons)}</>
                  )}
                </p>
                <button
                  onClick={() => onOpenPath(top.symbol)}
                  className="mt-2 text-xs font-semibold text-accent hover:underline"
                >
                  View full path →
                </button>
              </div>
              <div className="min-w-0 flex-1">
                {top.path ? (
                  <Sparkline
                    path={top.path}
                    width={620}
                    height={92}
                    area
                    className="w-full"
                  />
                ) : (
                  <p className="text-sm text-ink-400">No path data.</p>
                )}
              </div>
            </div>
          </Card>

          {/* ── remaining attention items (small) ───────────── */}
          {rest.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:col-span-6 lg:grid-cols-3">
              {rest.map((c) => (
                <AttentionCard
                  key={c.symbol}
                  change={c}
                  marketSource={brief.market_source}
                  onOpenPath={() => onOpenPath(c.symbol)}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        /* no attention — summary + trust still shown, compactly */
        <div className="grid grid-cols-2 gap-3 md:col-span-6 md:grid-cols-4">
          <Stat label="High attention" value={0} tone="high" />
          <Stat label="Notable" value={0} tone="notable" />
          <Stat label="Unchanged" value={brief.quiet.length} tone="quiet" />
          <Card>
            <div className="p-4">
              <SectionLabel>Data</SectionLabel>
              <div className="mt-1.5 text-sm font-semibold text-ink-900">
                {src.label}
              </div>
              <div className="text-[11px] text-ink-500">
                {freshnessLabel(brief.overall_freshness, brief.market_source)} ·
                updated {clockTime(brief.generated_at)}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ── 5. Nothing else needs your attention ────────────── */}
      {brief.quiet.length > 0 && (
        <Card className="md:col-span-6">
          <div className="p-4">
            <SectionLabel>Nothing else needs your attention.</SectionLabel>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              {brief.quiet.map((c) => {
                const up = c.change_pct > 0;
                return (
                  <span
                    key={c.symbol}
                    className="inline-flex items-baseline gap-2 text-sm"
                  >
                    <span className="font-medium text-ink-700">{c.symbol}</span>
                    <span className="tnum text-ink-500">
                      {price(c.current_value)}
                    </span>
                    <span
                      className={
                        "tnum text-xs " +
                        (c.change_pct === 0
                          ? "text-ink-400"
                          : up
                            ? "text-up"
                            : "text-down")
                      }
                    >
                      {signedPct(c.change_pct)}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function swingText(reasons: Brief["attention"][number]["reasons"]): string | null {
  const r = reasons.find((x) => x.code === "intrawindow_swing");
  if (!r) return null;
  const m = r.text.match(/Swung to (-?\d+\.?\d*)% .*?settled at (-?\d+\.?\d*)%/);
  return m ? `It swung to ${m[1]}% before settling at ${m[2]}%.` : null;
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
    <Card className="col-span-1">
      <div className="px-4 py-3">
        <div className={"text-2xl font-semibold tnum " + color}>{value}</div>
        <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">
          {label}
        </div>
      </div>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-400">{k}</dt>
      <dd className="truncate font-medium text-ink-600">{v}</dd>
    </div>
  );
}

function Banner({
  tone,
  className,
  children,
}: {
  tone: "critical" | "high" | "neutral";
  className?: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === "critical"
      ? "border-sev-bg-critical bg-sev-bg-critical text-sev-critical"
      : tone === "high"
        ? "border-sev-bg-high bg-sev-bg-high text-sev-high"
        : "border-line bg-sunk text-ink-700";
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${cls} ${className ?? ""}`}>
      {children}
    </div>
  );
}

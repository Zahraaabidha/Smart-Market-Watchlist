import type { Brief, Change } from "@/types";
import {
  clockTime,
  durationBetween,
  freshnessHelp,
  freshnessLabel,
  isSimulatedSource,
  price,
  relativeTime,
  signedPct,
  sourceCopy,
} from "@/format";
import { Button, Card, CardBody, SectionLabel } from "@/components/ui";
import { AttentionRow } from "./AttentionCard";
import { Sparkline } from "./Sparkline";

/**
 * The Brief - an attention dashboard.
 *
 * Fixed shape whatever the number of changes: hero → "N things need your
 * attention" → a single ranked list of the changes (score-ordered) → the data
 * trust strip → the "while you were away" summary of the strongest move →
 * everything that can be ignored.
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
  const n = attention.length;
  const highCount = attention.filter(
    (c) => c.severity === "critical" || c.severity === "high",
  ).length;
  const notableCount = n - highCount;
  const src = sourceCopy({
    provider: brief.market_source,
    mode: isSimulatedSource(brief.market_source) ? "replay" : "live",
    degraded: brief.degraded,
  });
  const strongest = attention[0];

  if (brief.monitored_count === 0) {
    return (
      <Card className="border-dashed">
        <CardBody className="py-14 text-center">
          <h2 className="text-lg font-semibold text-ink-900">
            Nothing on this watchlist yet
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-500">
            Add a few symbols on the Watchlist tab and the brief will start
            tracking what changes between your visits.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── HERO - page header, not a dashboard card ──────────── */}
      <header className="border-b border-line pb-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
              {brief.last_checked_at
                ? `While you were away · ${durationBetween(brief.last_checked_at, brief.generated_at)}`
                : "First visit"}
            </p>
            <h1 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-tight text-ink-900 sm:text-[30px]">
              {n > 0
                ? "Here's what changed while you were away."
                : "Nothing needs your attention."}
            </h1>
            <p className="mt-2 text-sm text-ink-500">
              {brief.last_checked_at
                ? `Reviewed ${relativeTime(brief.last_checked_at)} · `
                : "Comparing against the past week · "}
              updated {clockTime(brief.generated_at)} · {brief.monitored_count}{" "}
              monitored · {brief.meaningful_count} meaningful ·{" "}
              {brief.quiet.length} unchanged · {src.label}
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
          <div className="mt-4 rounded-lg bg-sunk/70 px-3.5 py-2.5 text-xs font-medium text-ink-600">
            Review saved. Your next brief will compare from{" "}
            {clockTime(justReviewedAt)}.
          </div>
        )}
      </header>

      {/* ── trust banners ────────────────────────────────────── */}
      {brief.overall_freshness === "stale" && (
        <Banner tone="critical">
          <strong className="font-semibold">Showing last known data.</strong>{" "}
          {freshnessHelp.stale}
        </Banner>
      )}
      {brief.degraded && (
        <Banner tone="high">
          <strong className="font-semibold">Live feed degraded.</strong> The
          vendor is unavailable, so this is deterministic replay data served as a
          fallback.
        </Banner>
      )}
      {brief.window_truncated && (
        <Banner tone="neutral">
          <strong className="font-semibold">Long absence.</strong> You were away
          longer than the 7-day history window, so this compares against the last
          7 days rather than your actual previous visit.
        </Banner>
      )}
      {brief.unavailable_symbols.length > 0 && (
        <Banner tone="high">
          <strong className="font-semibold">No data available</strong> for{" "}
          {brief.unavailable_symbols.join(", ")}. Excluded from the brief rather
          than shown as unchanged.
        </Banner>
      )}

      {/* ── ATTENTION SECTION ────────────────────────────────── */}
      {n > 0 ? (
        <section className="space-y-3 pt-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">
              <span className="text-sev-critical">{n}</span>{" "}
              {n === 1 ? "thing needs" : "things need"} your attention
            </h2>
            <span className="text-[11px] text-ink-400">
              {highCount} high · {notableCount} notable
            </span>
          </div>

          <Card>
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <SectionLabel>Ranked by attention score</SectionLabel>
              <span className="text-[11px] text-ink-400">
                open a row for the full path
              </span>
            </div>
            <ul className="divide-y divide-line">
              {attention.map((c) => (
                <li key={c.symbol}>
                  <AttentionRow
                    change={c}
                    marketSource={brief.market_source}
                    onOpenPath={() => onOpenPath(c.symbol)}
                  />
                </li>
              ))}
            </ul>
          </Card>
          <DataTrustStrip brief={brief} src={src} />
        </section>
      ) : (
        <DataTrustStrip brief={brief} src={src} />
      )}

      {/* ── WHILE YOU WERE AWAY (compact) ────────────────────── */}
      {strongest && strongest.path && (
        <Card>
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
            <div className="min-w-0 sm:w-64 sm:shrink-0">
              <SectionLabel>While you were away</SectionLabel>
              <p className="mt-1.5 text-sm text-ink-700">
                The biggest move was{" "}
                <span className="font-semibold text-ink-900">
                  {strongest.symbol}
                </span>{" "}
                <span
                  className={
                    strongest.change_pct > 0
                      ? "font-semibold text-up"
                      : "font-semibold text-down"
                  }
                >
                  {signedPct(strongest.change_pct)}
                </span>
                {swingText(strongest.reasons) && (
                  <> - {swingText(strongest.reasons)}</>
                )}
                .
              </p>
              <button
                onClick={() => onOpenPath(strongest.symbol)}
                className="mt-2 text-xs font-semibold text-accent hover:underline"
              >
                View full path →
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <Sparkline
                path={strongest.path}
                width={620}
                height={84}
                area
                className="w-full"
              />
            </div>
          </div>
        </Card>
      )}

      {/* ── NOTHING ELSE NEEDS YOUR ATTENTION (receded) ──────── */}
      {brief.quiet.length > 0 && (
        <div className="rounded-lg border border-line bg-sunk/40 p-4">
          <SectionLabel>Nothing else needs your attention.</SectionLabel>
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
            {brief.quiet.map((c) => {
              const up = c.change_pct > 0;
              return (
                <span
                  key={c.symbol}
                  className="inline-flex items-baseline gap-1.5 text-[13px]"
                >
                  <span className="font-medium text-ink-600">{c.symbol}</span>
                  <span className="tnum text-ink-400">
                    {price(c.current_value)}
                  </span>
                  <span
                    className={
                      "tnum text-[11px] " +
                      (c.change_pct === 0
                        ? "text-ink-400"
                        : up
                          ? "text-up/80"
                          : "text-down/80")
                    }
                  >
                    {signedPct(c.change_pct)}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── data trust strip ──────────────────────────────────────────── */

type Src = ReturnType<typeof sourceCopy>;

function TrustDot({ tone }: { tone: Src["tone"] }) {
  return (
    <span
      className={
        "h-2 w-2 shrink-0 rounded-full " +
        (tone === "live"
          ? "bg-up"
          : tone === "degraded"
            ? "bg-sev-high"
            : "bg-ink-400")
      }
    />
  );
}

function DataTrustStrip({ brief, src }: { brief: Brief; src: Src }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-lg border border-line bg-surface px-4 py-3 text-[11px] text-ink-500 shadow-card">
      <span className="inline-flex items-center gap-2">
        <TrustDot tone={src.tone} />
        <span className="font-semibold text-ink-900">{src.label}</span>
      </span>
      <span>
        <span className="text-ink-400">Source</span> {brief.market_source}
      </span>
      <span>
        <span className="text-ink-400">Freshness</span>{" "}
        {freshnessLabel(brief.overall_freshness, brief.market_source)}
      </span>
      <span>
        <span className="text-ink-400">Updated</span>{" "}
        {clockTime(brief.generated_at)} · {relativeTime(brief.generated_at)}
      </span>
      <span className="hidden text-ink-400 lg:inline">{src.help}</span>
    </div>
  );
}

/* ── small bits ────────────────────────────────────────────────── */

function swingText(reasons: Change["reasons"]): string | null {
  const r = reasons.find((x) => x.code === "intrawindow_swing");
  if (!r) return null;
  const m = r.text.match(/Swung to (-?\d+\.?\d*)% .*?settled at (-?\d+\.?\d*)%/);
  return m ? `it swung to ${m[1]}% before settling at ${m[2]}%` : null;
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
    <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>
  );
}

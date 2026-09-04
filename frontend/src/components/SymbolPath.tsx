import { useEffect, useState } from "react";
import { api } from "@/api";
import type { Change, SymbolPathDetail } from "@/types";
import {
  clockTime,
  durationBetween,
  freshnessHelp,
  freshnessLabel,
  price,
  relativeTime,
  signedPct,
} from "@/format";
import { Card, CardBody, SectionLabel, SeverityBadge, Skeleton } from "@/components/ui";
import { companyName } from "@/universe";
import { BklitPathChart } from "./BklitPathChart";

/**
 * The drill-in for one symbol. Shows the price path across the absence window
 * with the checkpoint and the intra-window extremes marked, then the full
 * reasoning and the data-trust record behind the numbers.
 */
export function SymbolPath({
  watchlistId,
  symbol,
  change,
  onBack,
}: {
  watchlistId: number;
  symbol: string;
  change: Change | null;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<SymbolPathDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .path(watchlistId, symbol)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Could not load the path.");
      });
    return () => {
      cancelled = true;
    };
  }, [watchlistId, symbol]);

  const company = companyName(symbol);
  const swing = change?.reasons.find((r) => r.code === "intrawindow_swing");

  const endMove =
    detail &&
    ((Number(detail.current_value) - Number(detail.checkpoint_price)) /
      Number(detail.checkpoint_price)) *
      100;
  const peakMove =
    detail &&
    (() => {
      const cp = Number(detail.checkpoint_price);
      const hi = (Number(detail.window_high) - cp) / cp;
      const lo = (Number(detail.window_low) - cp) / cp;
      return (Math.abs(hi) >= Math.abs(lo) ? hi : lo) * 100;
    })();

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="text-xs font-medium text-ink-500 transition-colors hover:text-ink-700"
      >
        ← Back to brief
      </button>

      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
          {symbol}
        </h1>
        {company && <span className="text-sm text-ink-400">{company}</span>}
        {change && <SeverityBadge severity={change.severity} />}
      </header>

      {error && (
        <Card>
          <CardBody className="text-sm text-sev-critical">{error}</CardBody>
        </Card>
      )}

      {!detail && !error && <Skeleton className="h-72" />}

      {detail && (
        <>
          {/* headline numbers */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Checkpoint" value={price(detail.checkpoint_price)} />
            <Metric
              label="Peak move"
              value={peakMove != null ? signedPct(peakMove) : "—"}
              tone={peakMove != null && peakMove >= 0 ? "up" : "down"}
            />
            <Metric label="Current" value={price(detail.current_value)} />
            <Metric
              label="Settled at"
              value={endMove != null ? signedPct(endMove) : "—"}
              tone={endMove != null && endMove >= 0 ? "up" : "down"}
            />
          </div>

          <BklitPathChart detail={detail} />

          {/* why this matters — the signature explanation */}
          {swing && peakMove != null && endMove != null && (
            <Card>
              <CardBody className="text-sm text-ink-700">
                <SectionLabel className="mb-1.5">Why this matters</SectionLabel>
                It ran to{" "}
                <strong className="font-semibold text-ink-900">
                  {signedPct(peakMove)}
                </strong>{" "}
                at its extreme, then settled at{" "}
                <strong className="font-semibold text-ink-900">
                  {signedPct(endMove)}
                </strong>
                . A watchlist that only compares last price to current price
                would have reported this as almost nothing — the move happened
                entirely inside your absence window.
              </CardBody>
            </Card>
          )}

          {/* full reasoning */}
          {change && change.reasons.length > 0 && (
            <section className="space-y-2">
              <SectionLabel>Why this surfaced</SectionLabel>
              <Card>
                <ul className="divide-y divide-line">
                  {change.reasons.map((r) => (
                    <li
                      key={r.code}
                      className="flex items-baseline gap-3 px-4 py-2.5 text-sm text-ink-700"
                    >
                      <span className="flex-1">{r.text}</span>
                      {r.contribution > 0 && (
                        <span className="shrink-0 text-xs font-medium tnum text-ink-400">
                          +{r.contribution.toFixed(0)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {/* data trust */}
          <section className="space-y-2">
            <SectionLabel>Can I trust this data?</SectionLabel>
            <Card>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-4">
                <Trust label="Source" value={detail.source} />
                <Trust
                  label="Source time"
                  value={`${clockTime(detail.source_timestamp)} · ${relativeTime(
                    detail.source_timestamp,
                  )}`}
                />
                <Trust
                  label="Received"
                  value={
                    detail.received_at
                      ? relativeTime(detail.received_at)
                      : "—"
                  }
                />
                <Trust
                  label="Freshness"
                  value={freshnessLabel(detail.freshness, detail.source)}
                  help={freshnessHelp[detail.freshness]}
                />
              </dl>
            </Card>
            <p className="text-xs text-ink-400">
              Absence window:{" "}
              {durationBetween(detail.last_checked_at, detail.window_end)} · last
              checked {relativeTime(detail.last_checked_at)}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <Card>
      <div className="px-4 py-3">
        <div
          className={
            "text-lg font-semibold tnum " +
            (tone === "up"
              ? "text-up"
              : tone === "down"
                ? "text-down"
                : "text-ink-900")
          }
        >
          {value}
        </div>
        <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">
          {label}
        </div>
      </div>
    </Card>
  );
}

function Trust({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  return (
    <div title={help}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium text-ink-700">{value}</dd>
    </div>
  );
}

import { curveNatural } from "@visx/curve";
import { useMemo } from "react";
import {
  ChartTooltip,
  Grid,
  Line,
  LineChart,
  ReferenceArea,
  YAxis,
  useChartStable,
} from "@/components/charts";
import { seriesPathFromPoints } from "@/components/charts/series-path-utils";
import type { SymbolPathDetail } from "@/types";
import { cn } from "@/lib/utils";
import { clockTime, price, signedPct } from "@/format";

/**
 * The absence-window story, drawn with the Bklit line chart.
 *
 * The price line is the visual hero. The grid is a pale hairline, the "while
 * you were away" band is a barely-there wash, and the markers are small dots
 * with no permanent text on the plot — checkpoint, intra-window high, intra-
 * window low and current. Everything (value, time, which marker) shows in a
 * light tooltip on hover. Real backend points, real high/low, tight y-domain.
 *
 * Points the backend flags `gap_before` (a genuine break in data collection —
 * see `app/services/brief.py::_gap_threshold`) are never bridged with a solid
 * stroke: that would draw continuous market data across a stretch where none
 * was collected. Where a gap exists the line is split into real segments,
 * joined only by a thin dashed connector, and the footer says so.
 */
const UP = "#0f8a52";
const DOWN = "#c8354a";
const GAP_STROKE = "#b7bcc6";

type Row = { date: Date; price: number; gapBefore: boolean };

export function BklitPathChart({ detail }: { detail: SymbolPathDetail }) {
  const model = useMemo(() => {
    const rows: Row[] = detail.points
      .map((p) => ({
        date: new Date(p.t),
        price: Number(p.price),
        gapBefore: p.gap_before,
      }))
      .filter((r) => Number.isFinite(r.price) && !Number.isNaN(+r.date))
      .sort((a, b) => +a.date - +b.date);

    const checkpoint = Number(detail.checkpoint_price);
    const current = Number(detail.current_value);
    const hi = Number(detail.window_high);
    const lo = Number(detail.window_low);

    const checkpointDate = detail.checkpoint_at
      ? new Date(detail.checkpoint_at)
      : rows[0]?.date;

    const nearest = (target: number) =>
      rows.reduce(
        (best, r) =>
          Math.abs(r.price - target) < Math.abs(best.price - target) ? r : best,
        rows[0],
      );

    // Real, contiguous runs of data — split wherever the backend says a
    // stretch was genuinely never collected. `gaps` records exactly what
    // each break spans, for the honest dashed connector and the caption.
    const segments: Row[][] = [];
    const gaps: { from: Row; to: Row }[] = [];
    for (const row of rows) {
      if (row.gapBefore || segments.length === 0) {
        if (segments.length > 0) {
          const prevSegment = segments[segments.length - 1];
          gaps.push({ from: prevSegment[prevSegment.length - 1], to: row });
        }
        segments.push([row]);
      } else {
        segments[segments.length - 1].push(row);
      }
    }

    return {
      rows,
      segments,
      gaps,
      hasGap: gaps.length > 0,
      checkpoint,
      current,
      hi,
      lo,
      checkpointDate,
      hiPoint: nearest(hi),
      loPoint: nearest(lo),
      lastPoint: rows[rows.length - 1],
      rising: current >= checkpoint,
    };
  }, [detail]);

  if (model.rows.length < 2) {
    return (
      <div className="grid h-56 place-items-center rounded-xl border border-line bg-sunk text-sm text-ink-400">
        Not enough data to plot a path yet.
      </div>
    );
  }

  const stroke = model.rising ? UP : DOWN;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="w-full px-3 pt-3">
        <LineChart
          data={model.rows}
          xDataKey="date"
          animationDuration={420}
          yDomainTween={false}
          aspectRatio="16 / 6"
          margin={{ top: 18, right: 18, bottom: 28, left: 46 }}
        >
          <Grid
            horizontal
            numTicksRows={4}
            stroke="#f0f2f5"
            strokeDasharray="0"
            fadeHorizontal={false}
          />

          {/* while you were away — a faint wash, no border */}
          <ReferenceArea
            x1={model.checkpointDate}
            fill="#2b59d9"
            fillOpacity={0.05}
            fadeEdges={false}
          />

          <Line
            dataKey="price"
            // The shared `Line` renderer has no notion of a gap — it always
            // draws one continuous stroke through `data`. Rather than teach
            // the shared chart primitive a one-off "don't connect these two
            // points" rule, this instance's own stroke is made invisible
            // when a real gap exists and `SegmentedStroke` below draws the
            // honest, broken version from the same points/scales. `Line`
            // itself stays mounted either way: it is what registers this
            // series' y-domain and drives the hover tooltip's value lookup.
            stroke={model.hasGap ? "transparent" : stroke}
            strokeWidth={2.4}
            animate={!model.hasGap}
            fadeEdges={false}
            showHighlight={false}
          />

          {model.hasGap && (
            <SegmentedStroke
              segments={model.segments}
              gaps={model.gaps}
              stroke={stroke}
              strokeWidth={2.4}
            />
          )}

          <YAxis numTicks={4} />
          <TimeAxis />

          <PathMarkers
            checkpoint={{ date: model.checkpointDate, value: model.checkpoint }}
            high={{ date: model.hiPoint.date, value: model.hi }}
            low={{ date: model.loPoint.date, value: model.lo }}
            now={{ date: model.lastPoint.date, value: model.current }}
            color={stroke}
          />

          <ChartTooltip
            showDatePill={false}
            showDots
            indicatorColor={stroke}
            indicatorDasharray="3,3"
            backgroundColor="#ffffff"
            panelStyle={{
              backdropFilter: "none",
              border: "1px solid #e6e8ec",
              boxShadow: "0 10px 28px -8px rgb(15 23 41 / 0.20)",
            }}
            content={({ point }) => {
              const t = new Date(point.date as string);
              const p = Number(point.price);
              const delta = model.checkpoint
                ? ((p - model.checkpoint) / model.checkpoint) * 100
                : 0;
              const ts = +t;
              const tag =
                ts === +model.hiPoint.date
                  ? { text: "Intra-window high", color: UP }
                  : ts === +model.loPoint.date
                    ? { text: "Intra-window low", color: DOWN }
                    : ts === +model.lastPoint.date
                      ? { text: "Now", color: stroke }
                      : model.checkpointDate && ts === +model.checkpointDate
                        ? { text: "You left", color: "#697086" }
                        : null;
              return (
                <div className="px-3 py-2.5 text-left">
                  <div className="text-[11px] font-medium text-ink-500">
                    {t.toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · {clockTime(t.toISOString())}
                  </div>
                  {tag && (
                    <div
                      className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide"
                      style={{ color: tag.color }}
                    >
                      {tag.text}
                    </div>
                  )}
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-sm font-semibold tabular-nums text-ink-900">
                      {price(String(p))}
                    </span>
                    <span
                      className={cn(
                        "text-[11px] font-medium tabular-nums",
                        delta >= 0 ? "text-up" : "text-down",
                      )}
                    >
                      {signedPct(delta)} vs checkpoint
                    </span>
                  </div>
                </div>
              );
            }}
          />
        </LineChart>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-ink-400">
        <LegendDot label="You left" ring="#8b91a3" />
        <LegendDot label="High" fill={UP} />
        <LegendDot label="Low" fill={DOWN} />
        <LegendDot label="Now" fill={stroke} />
        {model.hasGap && <LegendDot label="Gap" dashed />}
        <span className="ml-auto normal-case tracking-normal">
          {model.hasGap
            ? `Shaded band = while you were away · dashed = no data collected (${gapSummary(model.gaps)})`
            : "Shaded band = while you were away · hover for detail"}
        </span>
      </div>
    </div>
  );
}

function LegendDot({
  label,
  ring,
  fill,
  dashed,
}: {
  label: string;
  ring?: string;
  fill?: string;
  /** A short dashed swatch instead of a dot — the "gap in data" key. */
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {dashed ? (
        <svg width="12" height="6" viewBox="0 0 12 6" aria-hidden="true">
          <line
            x1={0}
            y1={3}
            x2={12}
            y2={3}
            stroke={GAP_STROKE}
            strokeWidth={1.5}
            strokeDasharray="2.5,2"
          />
        </svg>
      ) : (
        <span
          className="h-1.5 w-1.5 rounded-full border"
          style={{
            borderColor: ring ?? fill,
            background: fill ?? "#fff",
          }}
        />
      )}
      {label}
    </span>
  );
}

/** "2 gaps, largest 1h 12m" / "1 gap, 29m" — for the honest footer caption. */
function gapSummary(gaps: { from: Row; to: Row }[]): string {
  const spans = gaps.map((g) => +g.to.date - +g.from.date);
  const longest = Math.max(...spans);
  const label = (ms: number) => {
    const totalMin = Math.round(ms / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  return gaps.length === 1
    ? label(longest)
    : `${gaps.length} gaps, longest ${label(longest)}`;
}

/**
 * The gap-aware replacement for `<Line>`'s own stroke (which is made
 * transparent by the caller whenever this renders). One solid `<path>` per
 * real contiguous run of data — never a single path spanning a gap — plus a
 * thin dashed connector across each gap so its presence and rough size are
 * visible rather than just an unexplained blank stretch. Uses the same
 * `xScale`/`yScale` the rest of the chart's overlays (`PathMarkers`,
 * `TimeAxis`) already read from context, so it lines up with them exactly.
 */
function SegmentedStroke({
  segments,
  gaps,
  stroke,
  strokeWidth,
}: {
  segments: Row[][];
  gaps: { from: Row; to: Row }[];
  stroke: string;
  strokeWidth: number;
}) {
  const { xScale, yScale } = useChartStable();

  const toPoint = (row: Row) => ({
    x: xScale(row.date) ?? 0,
    y: yScale(row.price) ?? 0,
  });

  return (
    <g className="chart-segmented-stroke" pointerEvents="none">
      {segments.map((segment, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are stable per render of this memoized model
          key={i}
          d={seriesPathFromPoints(
            segment.map((row, j) => ({
              x: xScale(row.date) ?? 0,
              y: yScale(row.price) ?? 0,
              key: String(j),
            })),
            curveNatural,
          )}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      ))}
      {gaps.map((gap, i) => {
        const a = toPoint(gap.from);
        const b = toPoint(gap.to);
        if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
        return (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: gaps are stable per render of this memoized model
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={GAP_STROKE}
            strokeWidth={1.5}
            strokeDasharray="4,3"
          />
        );
      })}
    </g>
  );
}

type Pt = { date: Date; value: number };

/** Dots on the line — no text on the plot; details live in the tooltip. */
function PathMarkers({
  checkpoint,
  high,
  low,
  now,
  color,
}: {
  checkpoint: Pt;
  high: Pt;
  low: Pt;
  now: Pt;
  color: string;
}) {
  const { xScale, yScale } = useChartStable();
  const at = (p: Pt) => ({ x: xScale(p.date), y: yScale(p.value) });
  const c = at(checkpoint);
  const h = at(high);
  const l = at(low);
  const nw = at(now);

  // Nudge a marker a hair off any other it would sit directly on top of.
  // Thresholds/step scaled up slightly alongside the larger marker radii below.
  const dodge = (
    a: { x: number; y: number },
    others: { x: number; y: number }[],
  ) => {
    let dx = 0;
    for (const o of others) {
      if (Math.abs(a.x - o.x) < 8 && Math.abs(a.y - o.y) < 8) dx += 7;
    }
    return { x: a.x + dx, y: a.y };
  };
  const cN = dodge(c, [h, l, nw]);
  const hN = dodge(h, [l, nw]);
  const lN = dodge(l, [nw]);

  const ok = (pt: { x: number; y: number }) =>
    Number.isFinite(pt.x) && Number.isFinite(pt.y);

  // Three deliberately distinct marker styles, in increasing weight:
  //   - checkpoint ("you left"): small and hollow — a reference point, not
  //     an event.
  //   - high/low: medium, filled with the up/down color, ringed in white so
  //     it stays legible wherever the line or grid falls behind it.
  //   - now: the same white-outline treatment, just slightly larger — it's
  //     the endpoint the whole chart is building up to.
  // No text is drawn here; which marker is which, and its exact value/time,
  // lives entirely in the tooltip on hover.
  const marker = (
    pt: { x: number; y: number },
    { r, fill, stroke, strokeWidth }: {
      r: number;
      fill: string;
      stroke: string;
      strokeWidth: number;
    },
  ) =>
    ok(pt) && (
      <circle
        cx={pt.x}
        cy={pt.y}
        r={r}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );

  return (
    <g className="chart-path-markers" pointerEvents="none">
      {/* you left — small hollow dot */}
      {marker(cN, { r: 3, fill: "#fff", stroke: "#8b91a3", strokeWidth: 1.5 })}
      {/* intra-window high — medium, filled, white outline */}
      {marker(hN, { r: 5, fill: UP, stroke: "#fff", strokeWidth: 2 })}
      {/* intra-window low — medium, filled, white outline */}
      {marker(lN, { r: 5, fill: DOWN, stroke: "#fff", strokeWidth: 2 })}
      {/* now — slightly larger than high/low, filled, white outline */}
      {marker(nw, { r: 6, fill: color, stroke: "#fff", strokeWidth: 2.25 })}
    </g>
  );
}

/**
 * Intraday-aware X axis. Short absence windows (≤ ~36h) get "1:35 PM" style
 * ticks instead of a single "Sep 4"; longer windows fall back to dates.
 */
function TimeAxis() {
  const { xScale, innerHeight } = useChartStable();
  const domain = xScale.domain() as [Date, Date];
  const t0 = +domain[0];
  const t1 = +domain[1];
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;

  const intraday = t1 - t0 <= 36 * 3_600_000;
  const fmt = (d: Date) =>
    intraday
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const N = 5;
  const ticks = Array.from({ length: N }, (_, i) => new Date(t0 + ((t1 - t0) * i) / (N - 1)));

  return (
    <g className="chart-time-axis" pointerEvents="none">
      {ticks.map((d, i) => {
        const x = xScale(d);
        if (!Number.isFinite(x)) return null;
        const anchor = i === 0 ? "start" : i === N - 1 ? "end" : "middle";
        return (
          <text
            key={i}
            x={x}
            y={innerHeight + 18}
            textAnchor={anchor}
            className="fill-ink-400"
            fontSize={10}
          >
            {fmt(d)}
          </text>
        );
      })}
    </g>
  );
}

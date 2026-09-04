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
 */
const UP = "#0f8a52";
const DOWN = "#c8354a";

export function BklitPathChart({ detail }: { detail: SymbolPathDetail }) {
  const model = useMemo(() => {
    const rows = detail.points
      .map((p) => ({ date: new Date(p.t), price: Number(p.price) }))
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

    return {
      rows,
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
            stroke={stroke}
            strokeWidth={2.4}
            animate
            fadeEdges={false}
            showHighlight={false}
          />

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
        <LegendDot label="High" ring={UP} />
        <LegendDot label="Low" ring={DOWN} />
        <LegendDot label="Now" fill={stroke} />
        <span className="ml-auto normal-case tracking-normal">
          Shaded band = while you were away · hover for detail
        </span>
      </div>
    </div>
  );
}

function LegendDot({
  label,
  ring,
  fill,
}: {
  label: string;
  ring?: string;
  fill?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-1.5 w-1.5 rounded-full border"
        style={{
          borderColor: ring ?? fill,
          background: fill ?? "#fff",
        }}
      />
      {label}
    </span>
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
  const dodge = (
    a: { x: number; y: number },
    others: { x: number; y: number }[],
  ) => {
    let dx = 0;
    for (const o of others) {
      if (Math.abs(a.x - o.x) < 6 && Math.abs(a.y - o.y) < 6) dx += 5;
    }
    return { x: a.x + dx, y: a.y };
  };
  const cN = dodge(c, [h, l, nw]);
  const hN = dodge(h, [l, nw]);
  const lN = dodge(l, [nw]);

  const ok = (pt: { x: number; y: number }) =>
    Number.isFinite(pt.x) && Number.isFinite(pt.y);

  return (
    <g className="chart-path-markers" pointerEvents="none">
      {ok(cN) && (
        <circle
          cx={cN.x}
          cy={cN.y}
          r={3.4}
          fill="#fff"
          stroke="#8b91a3"
          strokeWidth={1.6}
        />
      )}
      {ok(hN) && (
        <circle
          cx={hN.x}
          cy={hN.y}
          r={3.6}
          fill="#fff"
          stroke={UP}
          strokeWidth={1.9}
        />
      )}
      {ok(lN) && (
        <circle
          cx={lN.x}
          cy={lN.y}
          r={3.6}
          fill="#fff"
          stroke={DOWN}
          strokeWidth={1.9}
        />
      )}
      {ok(nw) && <circle cx={nw.x} cy={nw.y} r={4.2} fill={color} />}
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

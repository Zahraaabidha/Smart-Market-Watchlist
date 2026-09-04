import { useMemo } from "react";
import {
  ChartTooltip,
  Grid,
  Line,
  LineChart,
  ReferenceArea,
  XAxis,
  YAxis,
  useChartStable,
} from "@/components/charts";
import type { SymbolPathDetail } from "@/types";
import { clockTime, price } from "@/format";

/**
 * The absence-window story, drawn with the Bklit line chart.
 *
 * Only the pieces the story needs: a Line for the path, a Grid + Axes for
 * reference, a ChartTooltip for inspection, a ReferenceArea shading the time
 * the user was away, and four labelled markers (checkpoint, intra-window high,
 * intra-window low, current). No projection, brush, legend, or decoration.
 */
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
      lastDate: rows[rows.length - 1]?.date,
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

  const stroke = model.rising ? "#0f8a52" : "#c8354a";

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface p-3">
      <div className="w-full">
        <LineChart
          data={model.rows}
          xDataKey="date"
          animationDuration={420}
          yDomainTween={false}
          aspectRatio="16 / 7"
          margin={{ top: 26, right: 22, bottom: 28, left: 48 }}
        >
          <Grid horizontal strokeDasharray="3,4" />

          {/* while you were away */}
          <ReferenceArea
            x1={model.checkpointDate}
            fill="#2b59d9"
            fillOpacity={0.06}
            stroke="#9aa1b1"
            strokeStyle="dashed"
            strokeDasharray="4,4"
            fadeEdges={false}
          />

          <Line
            dataKey="price"
            stroke={stroke}
            strokeWidth={2}
            animate
            fadeEdges={false}
          />

          <YAxis numTicks={4} />
          <XAxis numTicks={5} tickMode="domain" />

          <PathMarkers
            points={[
              {
                date: model.checkpointDate,
                value: model.checkpoint,
                label: "Checkpoint",
                color: "#5a6273",
              },
              {
                date: model.hiPoint.date,
                value: model.hi,
                label: `High ${price(String(model.hi))}`,
                color: "#0f8a52",
                place: "above",
              },
              {
                date: model.loPoint.date,
                value: model.lo,
                label: `Low ${price(String(model.lo))}`,
                color: "#c8354a",
                place: "below",
              },
              {
                date: model.lastDate,
                value: model.current,
                label: "Now",
                color: stroke,
                place: "above",
                filled: true,
              },
            ]}
          />

          <ChartTooltip
            showDatePill={false}
            showDots
            indicatorColor={stroke}
            rows={(pt: Record<string, unknown>) => [
              {
                color: stroke,
                label: clockTime(new Date(pt.date as string).toISOString()),
                value: price(String(pt.price)),
              },
            ]}
          />
        </LineChart>
      </div>
      <p className="mt-1.5 px-1 text-center text-[11px] font-medium uppercase tracking-wide text-ink-400">
        Shaded band = while you were away
      </p>
    </div>
  );
}

type MarkerSpec = {
  date: Date;
  value: number;
  label: string;
  color: string;
  place?: "above" | "below";
  filled?: boolean;
};

/** Renders point markers in the chart's coordinate space via the shared scales. */
function PathMarkers({ points }: { points: MarkerSpec[] }) {
  const { xScale, yScale, innerWidth } = useChartStable();

  return (
    <g className="chart-path-markers">
      {points.map((p, i) => {
        const x = xScale(p.date);
        const y = yScale(p.value);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const dy = p.place === "below" ? 15 : -9;
        const anchor =
          x < 64 ? "start" : x > innerWidth - 64 ? "end" : "middle";
        return (
          <g key={i}>
            <circle
              cx={x}
              cy={y}
              r={3.6}
              fill={p.filled ? p.color : "#fff"}
              stroke={p.color}
              strokeWidth={1.75}
            />
            <text
              x={anchor === "start" ? x - 3 : anchor === "end" ? x + 3 : x}
              y={y + dy}
              textAnchor={anchor}
              fontSize="10"
              fontWeight="600"
              fill={p.color}
            >
              {p.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

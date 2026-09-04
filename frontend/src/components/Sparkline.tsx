import { useMemo } from "react";
import type { PricePath } from "@/types";

/**
 * A compact price path for an attention card.
 *
 * Hand-rolled inline SVG, no charting library: the card only needs the shape
 * of the move plus two markers - where the price was when the user last
 * checked, and the intra-window extreme an endpoint comparison would hide.
 * The full labelled chart lives in the detail view.
 */
export function Sparkline({
  path,
  width = 132,
  height = 40,
  area = false,
  className,
}: {
  path: PricePath;
  width?: number;
  height?: number;
  /** Faint fill under the line - for the larger "while you were away" card. */
  area?: boolean;
  className?: string;
}) {
  const model = useMemo(() => {
    const pts = path.points.map((p) => ({
      t: new Date(p.t).getTime(),
      v: Number(p.price),
    }));
    if (pts.length < 2) return null;

    const checkpoint = Number(path.checkpoint_price);
    const hi = Number(path.window_high);
    const lo = Number(path.window_low);
    const vs = pts.map((p) => p.v).concat([checkpoint, hi, lo]);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const span = max - min || 1;

    const pad = 3;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const tSpan = t1 - t0 || 1;
    const x = (t: number) => pad + ((t - t0) / tSpan) * (width - 2 * pad);
    const y = (v: number) =>
      pad + (1 - (v - min) / span) * (height - 2 * pad);

    const line = pts.map((p) => `${x(p.t)},${y(p.v)}`).join(" ");
    const areaPath =
      `${x(pts[0].t)},${height} ` + line + ` ${x(pts[pts.length - 1].t)},${height}`;
    const last = pts[pts.length - 1];

    // The extreme worth marking is whichever of high/low is further from the
    // checkpoint price - that is the excursion the card is drawing attention to.
    const extremeUp = Math.abs(hi - checkpoint) >= Math.abs(checkpoint - lo);
    const extremeVal = extremeUp ? hi : lo;
    const extremeIdx = pts.reduce(
      (best, p, i) =>
        Math.abs(p.v - extremeVal) < Math.abs(pts[best].v - extremeVal)
          ? i
          : best,
      0,
    );
    const extreme = pts[extremeIdx];

    const rising = last.v >= checkpoint;
    return {
      line,
      areaPath,
      checkpointY: y(checkpoint),
      extreme: { cx: x(extreme.t), cy: y(extreme.v) },
      end: { cx: x(last.t), cy: y(last.v) },
      rising,
    };
  }, [path, width, height]);

  if (!model) {
    return (
      <div
        style={{ width, height }}
        className={className}
        aria-hidden="true"
      />
    );
  }

  const stroke = model.rising ? "var(--spark-up)" : "var(--spark-down)";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label="Price path since your last check"
      style={
        {
          "--spark-up": "#0f8a52",
          "--spark-down": "#c8354a",
        } as React.CSSProperties
      }
    >
      {area && (
        <polygon points={model.areaPath} fill={stroke} opacity={0.08} />
      )}
      {/* checkpoint reference: where the price stood when you last looked */}
      <line
        x1={0}
        x2={width}
        y1={model.checkpointY}
        y2={model.checkpointY}
        stroke="#c3c8d2"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <polyline
        points={model.line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* intra-window extreme */}
      <circle
        cx={model.extreme.cx}
        cy={model.extreme.cy}
        r={2.6}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
      />
      {/* current value */}
      <circle cx={model.end.cx} cy={model.end.cy} r={2.4} fill={stroke} />
    </svg>
  );
}

import { useMemo, useRef, useState } from "react";
import type { SymbolPathDetail } from "@/types";
import { clockTime, price } from "@/format";

/**
 * The signature chart: the route a price took across the user's absence.
 *
 * Hand-rolled SVG rather than a charting dependency — the shape it must draw is
 * specific (a shaded absence band, a checkpoint marker, the two intra-window
 * extremes, the current value) and every one of those is a few lines here. It
 * stays under ~200 lines and pulls nothing new into the bundle.
 */
const VB_W = 760;
const VB_H = 320;
const PAD = { top: 20, right: 64, bottom: 28, left: 8 };

export function PricePathChart({ detail }: { detail: SymbolPathDetail }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const m = useMemo(() => {
    const pts = detail.points.map((p) => ({
      t: new Date(p.t).getTime(),
      v: Number(p.price),
    }));
    const hi = Number(detail.window_high);
    const lo = Number(detail.window_low);
    const checkpoint = Number(detail.checkpoint_price);
    const checkpointT = detail.checkpoint_at
      ? new Date(detail.checkpoint_at).getTime()
      : pts[0]?.t;

    const vMin = Math.min(lo, checkpoint);
    const vMax = Math.max(hi, checkpoint);
    const vPad = (vMax - vMin || 1) * 0.12;
    const y0 = vMin - vPad;
    const y1 = vMax + vPad;

    const t0 = pts[0]?.t ?? 0;
    const t1 = pts[pts.length - 1]?.t ?? 1;
    const tSpan = t1 - t0 || 1;

    const px = (t: number) =>
      PAD.left + ((t - t0) / tSpan) * (VB_W - PAD.left - PAD.right);
    const py = (v: number) =>
      PAD.top + (1 - (v - y0) / (y1 - y0)) * (VB_H - PAD.top - PAD.bottom);

    const line = pts.map((p) => `${px(p.t)},${py(p.v)}`).join(" ");
    const area =
      `${px(pts[0]?.t ?? 0)},${py(y0)} ` +
      line +
      ` ${px(pts[pts.length - 1]?.t ?? 1)},${py(y0)}`;

    const hiIdx = pts.reduce((b, p, i) => (p.v > pts[b].v ? i : b), 0);
    const loIdx = pts.reduce((b, p, i) => (p.v < pts[b].v ? i : b), 0);

    // y-axis ticks
    const yticks = [y0, (y0 + y1) / 2, y1, checkpoint, hi, lo].filter(
      (v, i, a) => a.indexOf(v) === i,
    );

    return {
      pts,
      line,
      area,
      px,
      py,
      checkpoint,
      checkpointX: px(checkpointT),
      hi,
      lo,
      hiIdx,
      loIdx,
      endX: px(t1),
      endY: py(pts[pts.length - 1]?.v ?? 0),
      yticks,
      t0,
      t1,
      rising: (pts[pts.length - 1]?.v ?? 0) >= checkpoint,
    };
  }, [detail]);

  if (m.pts.length < 2) {
    return (
      <div className="grid h-56 place-items-center rounded-lg border border-line bg-sunk text-sm text-ink-400">
        Not enough data to plot a path yet.
      </div>
    );
  }

  const stroke = m.rising ? "#0f8a52" : "#c8354a";
  const hover = hoverIdx != null ? m.pts[hoverIdx] : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xVb = ((e.clientX - rect.left) / rect.width) * VB_W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < m.pts.length; i++) {
      const d = Math.abs(m.px(m.pts[i].t) - xVb);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHoverIdx(best);
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label={`Price path for ${detail.symbol} across your absence window`}
      >
        {/* absence band: from the checkpoint to now */}
        <rect
          x={m.checkpointX}
          y={PAD.top}
          width={Math.max(0, VB_W - PAD.right - m.checkpointX)}
          height={VB_H - PAD.top - PAD.bottom}
          fill="#2b59d9"
          opacity={0.05}
        />
        <text
          x={m.checkpointX + 6}
          y={PAD.top + 12}
          className="fill-ink-400"
          fontSize="10"
          fontWeight="600"
        >
          WHILE YOU WERE AWAY
        </text>

        {/* y gridlines + labels */}
        {m.yticks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={VB_W - PAD.right}
              y1={m.py(v)}
              y2={m.py(v)}
              stroke="#eceef2"
              strokeWidth={1}
            />
            <text
              x={VB_W - PAD.right + 6}
              y={m.py(v) + 3}
              className="fill-ink-400"
              fontSize="10"
            >
              {price(String(v))}
            </text>
          </g>
        ))}

        {/* checkpoint reference line */}
        <line
          x1={PAD.left}
          x2={VB_W - PAD.right}
          y1={m.py(m.checkpoint)}
          y2={m.py(m.checkpoint)}
          stroke="#9aa1b1"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <line
          x1={m.checkpointX}
          x2={m.checkpointX}
          y1={PAD.top}
          y2={VB_H - PAD.bottom}
          stroke="#9aa1b1"
          strokeWidth={1}
        />

        {/* filled trend + line */}
        <polygon points={m.area} fill={stroke} opacity={0.07} />
        <polyline
          points={m.line}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* extreme markers */}
        <Marker
          x={m.px(m.pts[m.hiIdx].t)}
          y={m.py(m.pts[m.hiIdx].v)}
          label={`High ${price(String(m.hi))}`}
          color="#0f8a52"
          place="above"
        />
        <Marker
          x={m.px(m.pts[m.loIdx].t)}
          y={m.py(m.pts[m.loIdx].v)}
          label={`Low ${price(String(m.lo))}`}
          color="#c8354a"
          place="below"
        />

        {/* checkpoint dot + current dot */}
        <circle
          cx={m.checkpointX}
          cy={m.py(m.checkpoint)}
          r={3.5}
          fill="#fff"
          stroke="#5a6273"
          strokeWidth={1.5}
        />
        <circle cx={m.endX} cy={m.endY} r={4} fill={stroke} />

        {/* hover */}
        {hover && (
          <g>
            <line
              x1={m.px(hover.t)}
              x2={m.px(hover.t)}
              y1={PAD.top}
              y2={VB_H - PAD.bottom}
              stroke="#c3c8d2"
              strokeWidth={1}
            />
            <circle
              cx={m.px(hover.t)}
              cy={m.py(hover.v)}
              r={3.5}
              fill={stroke}
            />
          </g>
        )}

        {/* x-axis end labels */}
        <text
          x={PAD.left}
          y={VB_H - 8}
          className="fill-ink-400"
          fontSize="10"
        >
          {clockTime(detail.points[0]?.t ?? null)}
        </text>
        <text
          x={VB_W - PAD.right}
          y={VB_H - 8}
          textAnchor="end"
          className="fill-ink-400"
          fontSize="10"
        >
          {clockTime(detail.points[detail.points.length - 1]?.t ?? null)}
        </text>
      </svg>

      {hover && (
        <div className="mt-1 flex items-center justify-center gap-4 text-xs text-ink-500 tnum">
          <span>{new Date(hover.t).toLocaleString()}</span>
          <span className="font-semibold text-ink-900">
            {price(String(hover.v))}
          </span>
        </div>
      )}
    </div>
  );
}

function Marker({
  x,
  y,
  label,
  color,
  place,
}: {
  x: number;
  y: number;
  label: string;
  color: string;
  place: "above" | "below";
}) {
  const dy = place === "above" ? -10 : 16;
  return (
    <g>
      <circle
        cx={x}
        cy={y}
        r={3.5}
        fill="#fff"
        stroke={color}
        strokeWidth={1.75}
      />
      <text
        x={x}
        y={y + dy}
        textAnchor="middle"
        fontSize="10"
        fontWeight="600"
        fill={color}
      >
        {label}
      </text>
    </g>
  );
}

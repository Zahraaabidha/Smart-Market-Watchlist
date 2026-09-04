import { useEffect, useState } from "react";
import type { Item, Preferences, Watchlist } from "@/types";
import { Button, Card, CardBody, SectionLabel } from "@/components/ui";
import { companyName } from "@/universe";

/**
 * Watchlist symbols and attention preferences. Semantics and values are
 * unchanged — the `view` prop just picks which half to show so the sidebar can
 * route "Watchlist" (symbols) and "Manage" (sensitivities) separately.
 */
const selectCls =
  "rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-sm text-ink-700 " +
  "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

export function WatchlistPanel({
  view,
  watchlist,
  preferences,
  onAdd,
  onRemove,
  onUpdateItem,
  onReorder,
  onUpdatePreferences,
  busy,
}: {
  view: "watchlist" | "manage";
  watchlist: Watchlist;
  preferences: Preferences | null;
  onAdd: (symbol: string, priority: number) => Promise<void>;
  onRemove: (itemId: number) => Promise<void>;
  onUpdateItem: (itemId: number, body: Partial<Item>) => Promise<void>;
  onReorder: (itemIds: number[]) => Promise<void>;
  onUpdatePreferences: (body: Partial<Preferences>) => Promise<void>;
  busy: boolean;
}) {
  const [symbol, setSymbol] = useState("");
  const [priority, setPriority] = useState(2);

  const items = [...watchlist.items].sort((a, b) => a.position - b.position);

  function move(index: number, direction: -1 | 1) {
    const next = [...items];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void onReorder(next.map((i) => i.id));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const cleaned = symbol.trim().toUpperCase();
    if (!cleaned) return;
    await onAdd(cleaned, priority);
    setSymbol("");
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">
          {view === "watchlist" ? "Watchlist" : "Manage what surfaces"}
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          {view === "watchlist"
            ? "The symbols you monitor. Reorder, set priority, add or remove."
            : "Tune the thresholds that decide what your brief raises."}
        </p>
      </header>

      {view === "watchlist" && (
        <>
      {/* ── Add stock ─────────────────────────────────────── */}
      <Card>
        <CardBody className="py-4">
          <SectionLabel>Add a stock</SectionLabel>
          <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="Symbol (e.g. SBIN)"
              maxLength={20}
              className={
                "min-w-[12rem] flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm " +
                "text-ink-900 placeholder:text-ink-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
              }
            />
            <select
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className={selectCls}
            >
              <option value={1}>High priority</option>
              <option value={2}>Normal</option>
              <option value={3}>Low priority</option>
            </select>
            <Button type="submit" variant="primary" disabled={busy || !symbol.trim()}>
              Add
            </Button>
          </form>
        </CardBody>
      </Card>

      {/* ── Watchlist rows ────────────────────────────────── */}
      <Card>
        <CardBody className="py-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>{watchlist.name}</SectionLabel>
            <span className="text-[11px] text-ink-400">
              {items.length} {items.length === 1 ? "symbol" : "symbols"}
            </span>
          </div>

          {items.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-500">
              No symbols yet. Add one above to start tracking it.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {items.map((item, index) => (
                <li key={item.id} className="flex items-center gap-3 py-2">
                  <div className="flex w-4 shrink-0 flex-col text-[10px] leading-none text-ink-400">
                    <button
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || busy}
                      aria-label={`Move ${item.symbol} up`}
                      className="transition-colors hover:text-ink-700 disabled:opacity-25"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => move(index, 1)}
                      disabled={index === items.length - 1 || busy}
                      aria-label={`Move ${item.symbol} down`}
                      className="transition-colors hover:text-ink-700 disabled:opacity-25"
                    >
                      ▼
                    </button>
                  </div>

                  <div className="min-w-0 flex-1">
                    <span className="font-semibold text-ink-900">
                      {item.symbol}
                    </span>
                    <span className="ml-2 truncate text-[11px] text-ink-400">
                      {companyName(item.symbol) ?? ""}
                    </span>
                  </div>

                  {(item.threshold_above || item.threshold_below) && (
                    <span
                      title={`Alerts: ${item.threshold_above ? `above ${item.threshold_above}` : ""}${item.threshold_above && item.threshold_below ? ", " : ""}${item.threshold_below ? `below ${item.threshold_below}` : ""}`}
                      className="hidden shrink-0 rounded bg-sunk px-1.5 py-0.5 text-[10px] font-medium text-ink-500 sm:inline"
                    >
                      alerts
                    </span>
                  )}

                  <select
                    value={item.priority}
                    onChange={(e) =>
                      void onUpdateItem(item.id, {
                        priority: Number(e.target.value),
                      })
                    }
                    className={selectCls + " shrink-0 py-1 text-xs"}
                    aria-label={`Priority for ${item.symbol}`}
                  >
                    <option value={1}>High</option>
                    <option value={2}>Normal</option>
                    <option value={3}>Low</option>
                  </select>

                  <button
                    onClick={() => void onRemove(item.id)}
                    disabled={busy}
                    className="shrink-0 text-xs font-medium text-ink-400 transition-colors hover:text-down disabled:opacity-40"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
        </>
      )}

      {/* ── Sensitivity controls ──────────────────────────── */}
      {view === "manage" && preferences && (
        <section>
          <div className="mb-3">
            <SectionLabel>What you want surfaced</SectionLabel>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-400">
              These tune what <em>you</em> want the brief to raise — not what is
              objectively important in the market. Raising a threshold means
              fewer, more significant alerts for you.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SensitivityCard
              label="Minimum move"
              help="A price change smaller than this is not treated as meaningful."
              value={preferences.min_move_pct}
              suffix="%"
              min={0.5}
              max={15}
              step={0.5}
              onCommit={(v) => void onUpdatePreferences({ min_move_pct: v })}
            />
            <SensitivityCard
              label="Volume sensitivity"
              help="How many times its average volume a symbol must trade for that to count as conviction."
              value={preferences.volume_sensitivity}
              suffix="×"
              min={1}
              max={10}
              step={0.5}
              onCommit={(v) => void onUpdatePreferences({ volume_sensitivity: v })}
            />
            <SensitivityCard
              label="Swing sensitivity"
              help="Multiplier on your minimum move before a spike that reversed is worth reporting."
              value={preferences.swing_sensitivity}
              suffix="×"
              min={1}
              max={5}
              step={0.25}
              onCommit={(v) => void onUpdatePreferences({ swing_sensitivity: v })}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function SensitivityCard({
  label,
  help,
  value,
  suffix,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  help: string;
  value: number;
  suffix: string;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);
  const pct = ((local - min) / (max - min)) * 100;

  return (
    <Card>
      <div className="p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold text-ink-900">{label}</span>
          <span className="text-lg font-semibold tnum text-ink-900">
            {local}
            <span className="ml-0.5 text-xs text-ink-400">{suffix}</span>
          </span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={local}
          onChange={(e) => setLocal(Number(e.target.value))}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => {
            setDragging(false);
            onCommit(local);
          }}
          onKeyUp={() => onCommit(local)}
          aria-label={label}
          className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none
                     [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-line-strong
                     [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-card
                     [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full
                     [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-line-strong
                     [&::-moz-range-thumb]:bg-surface"
          style={{
            background: `linear-gradient(to right, #2b59d9 ${pct}%, #e6e8ec ${pct}%)`,
          }}
        />
        <p className="mt-2.5 text-[11px] leading-relaxed text-ink-400">{help}</p>
      </div>
    </Card>
  );
}

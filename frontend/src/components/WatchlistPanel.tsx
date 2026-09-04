import { useEffect, useState } from "react";
import type { Item, Preferences, Watchlist } from "@/types";
import { Button, Card, CardBody, SectionLabel } from "@/components/ui";
import { companyName } from "@/universe";

/**
 * Watchlist management and attention preferences.
 *
 * Kept off the brief on purpose: this is the screen you visit occasionally to
 * configure things; the brief is the one you visit daily to read them.
 */
const PRIORITY_LABEL: Record<number, string> = {
  1: "High",
  2: "Normal",
  3: "Low",
};

export function WatchlistPanel({
  watchlist,
  preferences,
  onAdd,
  onRemove,
  onUpdateItem,
  onReorder,
  onUpdatePreferences,
  busy,
}: {
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

  const select =
    "rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-sm text-ink-700 " +
    "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionLabel>Symbols in {watchlist.name}</SectionLabel>

        <form onSubmit={submit} className="flex flex-wrap gap-2">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="Add a symbol (e.g. SBIN)"
            maxLength={20}
            className={
              "min-w-[12rem] flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm " +
              "text-ink-900 placeholder:text-ink-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
            }
          />
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className={select}
          >
            <option value={1}>High priority</option>
            <option value={2}>Normal</option>
            <option value={3}>Low priority</option>
          </select>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !symbol.trim()}
          >
            Add
          </Button>
        </form>

        {items.length === 0 ? (
          <Card className="border-dashed">
            <CardBody className="py-8 text-center text-sm text-ink-500">
              No symbols yet. Add one above to start tracking it.
            </CardBody>
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {items.map((item, index) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm"
                >
                  <div className="flex flex-col text-ink-400">
                    <button
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || busy}
                      aria-label={`Move ${item.symbol} up`}
                      className="leading-none transition-colors hover:text-ink-700 disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => move(index, 1)}
                      disabled={index === items.length - 1 || busy}
                      aria-label={`Move ${item.symbol} down`}
                      className="leading-none transition-colors hover:text-ink-700 disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </div>

                  <div className="w-40">
                    <div className="font-semibold text-ink-900">
                      {item.symbol}
                    </div>
                    <div className="truncate text-xs text-ink-400">
                      {companyName(item.symbol)}
                    </div>
                  </div>

                  <select
                    value={item.priority}
                    onChange={(e) =>
                      void onUpdateItem(item.id, {
                        priority: Number(e.target.value),
                      })
                    }
                    className={select + " py-1 text-xs"}
                    aria-label={`Priority for ${item.symbol}`}
                  >
                    <option value={1}>High</option>
                    <option value={2}>Normal</option>
                    <option value={3}>Low</option>
                  </select>

                  <span className="flex-1 text-xs text-ink-400">
                    {item.threshold_above || item.threshold_below ? (
                      <>
                        Alerts:{" "}
                        {item.threshold_above &&
                          `above ${item.threshold_above}`}
                        {item.threshold_above && item.threshold_below && ", "}
                        {item.threshold_below &&
                          `below ${item.threshold_below}`}
                      </>
                    ) : (
                      "No price alerts"
                    )}
                  </span>

                  <span className="hidden text-[11px] font-medium text-ink-400 sm:inline">
                    {PRIORITY_LABEL[item.priority]}
                  </span>

                  <button
                    onClick={() => void onRemove(item.id)}
                    disabled={busy}
                    className="text-xs font-medium text-ink-400 transition-colors hover:text-down disabled:opacity-40"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {preferences && (
        <section className="space-y-3">
          <div>
            <SectionLabel>What you want to hear about</SectionLabel>
            <p className="mt-1 text-xs text-ink-400">
              These change how the engine scores every symbol. Raising a
              threshold means fewer, more significant alerts.
            </p>
          </div>

          <Card>
            <CardBody className="space-y-6">
              <SliderRow
                label="Minimum move"
                help="A price change smaller than this is not treated as meaningful."
                value={preferences.min_move_pct}
                suffix="%"
                min={0.5}
                max={15}
                step={0.5}
                onCommit={(v) => void onUpdatePreferences({ min_move_pct: v })}
              />
              <SliderRow
                label="Volume sensitivity"
                help="How many times its average volume a symbol must trade before that counts as conviction."
                value={preferences.volume_sensitivity}
                suffix="×"
                min={1}
                max={10}
                step={0.5}
                onCommit={(v) =>
                  void onUpdatePreferences({ volume_sensitivity: v })
                }
              />
              <SliderRow
                label="Swing sensitivity"
                help="Multiplier on your minimum move before a spike that reversed is worth reporting."
                value={preferences.swing_sensitivity}
                suffix="×"
                min={1}
                max={5}
                step={0.25}
                onCommit={(v) =>
                  void onUpdatePreferences({ swing_sensitivity: v })
                }
              />
            </CardBody>
          </Card>
        </section>
      )}
    </div>
  );
}

function SliderRow({
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
  // Track locally while dragging; only hit the API on release, so a drag from
  // 2 to 8 is one request rather than twelve.
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);
  // Adopt a server-confirmed value unless the user is mid-drag.
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);
  const shown = local;
  const pct = ((shown - min) / (max - min)) * 100;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-ink-900">{label}</label>
        <span className="text-sm font-semibold tnum text-ink-700">
          {shown}
          <span className="ml-0.5 text-ink-400">{suffix}</span>
        </span>
      </div>
      <p className="mt-0.5 text-xs text-ink-400">{help}</p>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => {
          setDragging(false);
          onCommit(local);
        }}
        onKeyUp={() => onCommit(local)}
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
    </div>
  );
}

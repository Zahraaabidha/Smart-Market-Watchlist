import { useState } from "react";
import type { Item, Preferences, Watchlist } from "../types";

/**
 * Watchlist management and attention preferences.
 *
 * Kept off the brief on purpose. This is the screen you visit occasionally to
 * configure things; the brief is the screen you visit daily to read them.
 */
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

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xs uppercase tracking-wider text-slate-500 mb-3">
          Symbols in {watchlist.name}
        </h2>

        <form onSubmit={submit} className="flex gap-2 mb-4">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="Add a symbol (e.g. SBIN)"
            maxLength={20}
            className="flex-1 bg-ink-900 border border-ink-700 rounded px-3 py-2 text-sm
                       placeholder:text-slate-600 focus:outline-none focus:border-ink-600"
          />
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="bg-ink-900 border border-ink-700 rounded px-2 py-2 text-sm text-slate-300"
          >
            <option value={1}>High priority</option>
            <option value={2}>Normal</option>
            <option value={3}>Low priority</option>
          </select>
          <button
            type="submit"
            disabled={busy || !symbol.trim()}
            className="px-4 py-2 rounded bg-slate-200 text-ink-950 text-sm font-medium
                       hover:bg-white disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </form>

        {items.length === 0 ? (
          <p className="text-sm text-slate-500 border border-dashed border-ink-700 rounded p-6 text-center">
            No symbols yet. Add one above to start tracking it.
          </p>
        ) : (
          <ul className="rounded-md border border-ink-800 divide-y divide-ink-800">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="flex items-center gap-3 px-3 py-2.5 text-sm"
              >
                <div className="flex flex-col">
                  <button
                    onClick={() => move(index, -1)}
                    disabled={index === 0 || busy}
                    aria-label={`Move ${item.symbol} up`}
                    className="text-slate-600 hover:text-slate-300 disabled:opacity-25 leading-none"
                  >
                    ▴
                  </button>
                  <button
                    onClick={() => move(index, 1)}
                    disabled={index === items.length - 1 || busy}
                    aria-label={`Move ${item.symbol} down`}
                    className="text-slate-600 hover:text-slate-300 disabled:opacity-25 leading-none"
                  >
                    ▾
                  </button>
                </div>

                <span className="font-medium text-slate-200 w-28">
                  {item.symbol}
                </span>

                <select
                  value={item.priority}
                  onChange={(e) =>
                    void onUpdateItem(item.id, {
                      priority: Number(e.target.value),
                    })
                  }
                  className="bg-ink-900 border border-ink-700 rounded px-2 py-1 text-xs text-slate-300"
                >
                  <option value={1}>High</option>
                  <option value={2}>Normal</option>
                  <option value={3}>Low</option>
                </select>

                <span className="text-xs text-slate-600 flex-1">
                  {item.threshold_above || item.threshold_below ? (
                    <>
                      Alerts:{" "}
                      {item.threshold_above && `above ${item.threshold_above}`}
                      {item.threshold_above && item.threshold_below && ", "}
                      {item.threshold_below && `below ${item.threshold_below}`}
                    </>
                  ) : (
                    "No price alerts"
                  )}
                </span>

                <button
                  onClick={() => void onRemove(item.id)}
                  disabled={busy}
                  className="text-xs text-slate-500 hover:text-rose-400 disabled:opacity-40"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {preferences && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-slate-500 mb-1">
            What you want to hear about
          </h2>
          <p className="text-xs text-slate-600 mb-4">
            These change how the engine scores every symbol. Raising a threshold
            means fewer, more significant alerts.
          </p>

          <div className="space-y-4">
            <PreferenceRow
              label="Minimum move"
              help="A price change smaller than this is not treated as meaningful."
              value={preferences.min_move_pct}
              suffix="%"
              min={0.1}
              max={25}
              step={0.1}
              onChange={(v) => void onUpdatePreferences({ min_move_pct: v })}
            />
            <PreferenceRow
              label="Volume sensitivity"
              help="How many times its average volume a symbol must trade before that counts as conviction."
              value={preferences.volume_sensitivity}
              suffix="×"
              min={1}
              max={10}
              step={0.1}
              onChange={(v) =>
                void onUpdatePreferences({ volume_sensitivity: v })
              }
            />
            <PreferenceRow
              label="Swing sensitivity"
              help="Multiplier on your minimum move before a spike that reversed is worth reporting."
              value={preferences.swing_sensitivity}
              suffix="×"
              min={1}
              max={5}
              step={0.1}
              onChange={(v) =>
                void onUpdatePreferences({ swing_sensitivity: v })
              }
            />
          </div>
        </section>
      )}
    </div>
  );
}

function PreferenceRow({
  label,
  help,
  value,
  suffix,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  suffix: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-1">
        <label className="text-sm text-slate-300">{label}</label>
        <p className="text-xs text-slate-600 mt-0.5">{help}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (next >= min && next <= max) onChange(next);
          }}
          className="w-20 bg-ink-900 border border-ink-700 rounded px-2 py-1 text-sm text-right tnum
                     focus:outline-none focus:border-ink-600"
        />
        <span className="text-xs text-slate-600 w-3">{suffix}</span>
      </div>
    </div>
  );
}

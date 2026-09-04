import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, getToken, setToken } from "./api";
import type { Brief, Item, Preferences, TimelineEntry, Watchlist } from "./types";
import { MarketBrief } from "./components/MarketBrief";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { SignIn } from "./components/SignIn";
import { Timeline } from "./components/Timeline";

const REFRESH_MS = 20_000;

type Tab = "brief" | "history" | "watchlist";

export default function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [tab, setTab] = useState<Tab>("brief");
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkpointing, setCheckpointing] = useState(false);

  // Retains the last good brief across a failed refresh so a transient network
  // blip does not blank the screen the user is reading.
  const hasLoadedOnce = useRef(false);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const lists = await api.watchlists();
      const first = lists[0] ?? null;
      setWatchlist(first);

      if (first) {
        const [nextBrief, prefs] = await Promise.all([
          api.brief(first.id),
          api.preferences(),
        ]);
        setBrief(nextBrief);
        setPreferences(prefs);
      }
      setError(null);
      hasLoadedOnce.current = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuthed(false);
        setBrief(null);
        setWatchlist(null);
        return;
      }
      setError(
        err instanceof Error ? err.message : "Something went wrong loading data.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void load(true);
  }, [authed, load]);

  // Background refresh. Silent on failure: the stale-data banner already tells
  // the user the data is ageing, so an error toast every 20 seconds would add
  // noise without adding information.
  useEffect(() => {
    if (!authed) return;
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [authed, load]);

  async function handleAuth(
    email: string,
    password: string,
    mode: "login" | "register",
  ) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const result =
        mode === "login"
          ? await api.login(email, password)
          : await api.register(email, password);
      setToken(result.access_token);
      setAuthed(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That action failed.");
    } finally {
      setBusy(false);
    }
  }

  // Loaded only when the history tab is opened. It is not needed to answer
  // "what should I look at now", so fetching it with every brief would be work
  // most visits never use.
  useEffect(() => {
    if (!authed || tab !== "history" || !watchlist) return;
    let cancelled = false;
    setTimelineLoading(true);
    api
      .timeline(watchlist.id)
      .then((rows) => {
        if (!cancelled) setTimeline(rows);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Could not load history.");
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authed, tab, watchlist]);

  async function handleCheckpoint() {
    if (!watchlist || !brief) return;
    setCheckpointing(true);
    setError(null);
    try {
      // Keyed on the brief the user actually read. Re-clicking the button for
      // the same brief is a no-op server-side, so a double tap cannot collapse
      // the comparison window.
      await api.checkpoint(watchlist.id, `brief-${brief.generated_at}`);
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save checkpoint.");
    } finally {
      setCheckpointing(false);
    }
  }

  function signOut() {
    setToken(null);
    setAuthed(false);
    setBrief(null);
    setWatchlist(null);
    hasLoadedOnce.current = false;
  }

  if (!authed) {
    return <SignIn onSubmit={handleAuth} error={authError} busy={authBusy} />;
  }

  return (
    <div className="min-h-screen">
      <nav className="border-b border-ink-800 sticky top-0 bg-ink-950/90 backdrop-blur z-10">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-6">
          <span className="text-sm font-semibold text-slate-200 tracking-tight">
            Watchlist
          </span>
          <div className="flex gap-1">
            {(["brief", "history", "watchlist"] as const).map((name) => (
              <button
                key={name}
                onClick={() => setTab(name)}
                className={`px-3 py-1.5 text-sm rounded transition-colors ${
                  tab === name
                    ? "bg-ink-800 text-slate-100"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {name === "brief"
                  ? "Brief"
                  : name === "history"
                    ? "History"
                    : "Manage"}
              </button>
            ))}
          </div>
          <button
            onClick={signOut}
            className="ml-auto text-xs text-slate-500 hover:text-slate-300"
          >
            Sign out
          </button>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-8">
        {error && (
          <div className="mb-6 rounded-md border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200 flex items-center gap-3">
            <span className="flex-1">{error}</span>
            <button
              onClick={() => void load(true)}
              className="text-xs px-2 py-1 rounded border border-rose-800 hover:bg-rose-900/40"
            >
              Retry
            </button>
          </div>
        )}

        {loading && !hasLoadedOnce.current ? (
          <LoadingState />
        ) : !watchlist ? (
          <p className="text-sm text-slate-500">
            No watchlist found for this account.
          </p>
        ) : tab === "brief" ? (
          brief && (
            <MarketBrief
              brief={brief}
              onCheckpoint={handleCheckpoint}
              checkpointing={checkpointing}
            />
          )
        ) : tab === "history" ? (
          <Timeline entries={timeline} loading={timelineLoading} />
        ) : (
          <WatchlistPanel
            watchlist={watchlist}
            preferences={preferences}
            busy={busy}
            onAdd={(symbol, priority) =>
              mutate(() => api.addItem(watchlist.id, { symbol, priority }))
            }
            onRemove={(itemId) =>
              mutate(() => api.removeItem(watchlist.id, itemId))
            }
            onUpdateItem={(itemId, body: Partial<Item>) =>
              mutate(() => api.updateItem(watchlist.id, itemId, body))
            }
            onReorder={(itemIds) =>
              mutate(() => api.reorder(watchlist.id, itemIds))
            }
            onUpdatePreferences={(body) =>
              mutate(() => api.updatePreferences(body))
            }
          />
        )}
      </main>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading your brief">
      <div className="h-7 w-2/3 rounded bg-ink-900 animate-pulse" />
      <div className="h-4 w-1/2 rounded bg-ink-900 animate-pulse" />
      <div className="pt-4 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 rounded bg-ink-900 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, getToken, setToken } from "./api";
import type {
  Brief,
  Item,
  MarketSource,
  Preferences,
  TimelineEntry,
  Watchlist,
} from "./types";
import { Button, Skeleton } from "@/components/ui";
import { MarketBrief } from "./components/MarketBrief";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { SignIn } from "./components/SignIn";
import { Timeline } from "./components/Timeline";
import { SymbolPath } from "./components/SymbolPath";
import { MobileTopBar, Sidebar, type NavId } from "./components/Sidebar";

const REFRESH_MS = 20_000;

type Tab = NavId;

export default function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [tab, setTab] = useState<Tab>("brief");
  const [navOpen, setNavOpen] = useState(false);
  const [pathSymbol, setPathSymbol] = useState<string | null>(null);
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [source, setSource] = useState<MarketSource | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkpointing, setCheckpointing] = useState(false);
  const [justReviewedAt, setJustReviewedAt] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);

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
        const [nextBrief, prefs, src] = await Promise.all([
          api.brief(first.id),
          api.preferences(),
          api.marketSource().catch(() => null),
        ]);
        setBrief(nextBrief);
        setPreferences(prefs);
        if (src) setSource(src);
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
      // the comparison window. Backend checkpoint semantics are unchanged; this
      // is still an explicit, user-initiated action.
      const result = await api.checkpoint(
        watchlist.id,
        `brief-${brief.generated_at}`,
      );
      setJustReviewedAt(result.checked_at);
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save checkpoint.");
    } finally {
      setCheckpointing(false);
    }
  }

  async function runDemo() {
    setDemoBusy(true);
    setError(null);
    try {
      await api.demoReplay();
      setTab("brief");
      setPathSymbol(null);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the demo.");
    } finally {
      setDemoBusy(false);
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

  function navigate(t: Tab) {
    setTab(t);
    setPathSymbol(null);
    setJustReviewedAt(null);
    setNavOpen(false);
  }

  return (
    <div className="min-h-screen lg:flex">
      <Sidebar
        active={tab}
        onNav={navigate}
        source={source}
        onDemo={runDemo}
        demoBusy={demoBusy}
        onSignOut={signOut}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="min-w-0 flex-1">
        <MobileTopBar onOpen={() => setNavOpen(true)} />

        <main className="max-w-6xl px-4 py-8 lg:px-10">
          {error && (
          <div className="mb-6 flex items-center gap-3 rounded-lg border border-sev-bg-critical bg-sev-bg-critical px-4 py-3 text-sm text-sev-critical">
            <span className="flex-1">{error}</span>
            <Button size="sm" onClick={() => void load(true)}>
              Retry
            </Button>
          </div>
        )}

        {loading && !hasLoadedOnce.current ? (
          <LoadingState />
        ) : !watchlist ? (
          <p className="text-sm text-ink-500">
            No watchlist found for this account.
          </p>
        ) : pathSymbol && watchlist ? (
          <SymbolPath
            watchlistId={watchlist.id}
            symbol={pathSymbol}
            change={
              brief?.attention.find((c) => c.symbol === pathSymbol) ?? null
            }
            onBack={() => setPathSymbol(null)}
          />
        ) : tab === "brief" ? (
          brief && (
            <MarketBrief
              brief={brief}
              onCheckpoint={handleCheckpoint}
              checkpointing={checkpointing}
              justReviewedAt={justReviewedAt}
              onOpenPath={(symbol) => setPathSymbol(symbol)}
            />
          )
        ) : tab === "history" ? (
          <Timeline
            entries={timeline}
            loading={timelineLoading}
            watchedSymbols={watchlist.items.map((i) => i.symbol)}
            onOpenPath={(symbol) => setPathSymbol(symbol)}
          />
        ) : (
          <WatchlistPanel
            view={tab === "manage" ? "manage" : "watchlist"}
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
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading your brief">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <div className="grid grid-cols-3 gap-3 pt-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <div className="space-y-3 pt-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    </div>
  );
}

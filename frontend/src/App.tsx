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
import { sourceCopy } from "./format";
import { cn } from "@/lib/utils";
import { Button, Skeleton } from "@/components/ui";
import { MarketBrief } from "./components/MarketBrief";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { SignIn } from "./components/SignIn";
import { Timeline } from "./components/Timeline";
import { SymbolPath } from "./components/SymbolPath";

const REFRESH_MS = 20_000;

type Tab = "brief" | "history" | "manage";
const TABS: { id: Tab; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "history", label: "History" },
  { id: "manage", label: "Manage" },
];

export default function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [tab, setTab] = useState<Tab>("brief");
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
      // the comparison window.
      await api.checkpoint(watchlist.id, `brief-${brief.generated_at}`);
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

  return (
    <div className="min-h-screen">
      <Header
        tab={tab}
        onTab={(t) => {
          setTab(t);
          setPathSymbol(null);
        }}
        source={source}
        onDemo={runDemo}
        demoBusy={demoBusy}
        onSignOut={signOut}
      />

      <main className="mx-auto max-w-4xl px-4 py-8">
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

function Header({
  tab,
  onTab,
  source,
  onDemo,
  demoBusy,
  onSignOut,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  source: MarketSource | null;
  onDemo: () => void;
  demoBusy: boolean;
  onSignOut: () => void;
}) {
  const chip = source ? sourceCopy(source) : null;
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-4xl items-center gap-2 px-3 sm:gap-4 sm:px-4">
        <span className="flex shrink-0 items-center gap-2 text-sm font-semibold tracking-tight text-ink-900">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-ink-900 text-white">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 11.5 6 6l3 3 5-7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="hidden md:inline">Watchlist</span>
        </span>

        <nav className="flex gap-0.5 sm:gap-1">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => onTab(id)}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-3",
                tab === id
                  ? "bg-sunk text-ink-900"
                  : "text-ink-500 hover:text-ink-700",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-2.5">
          {chip && (
            <span
              title={chip.help}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[11px] font-medium sm:px-2",
                chip.tone === "live" && "border-up/30 bg-up/10 text-up",
                chip.tone === "sim" && "border-line bg-surface text-ink-500",
                chip.tone === "degraded" &&
                  "border-sev-high/30 bg-sev-bg-high text-sev-high",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  chip.tone === "live" && "bg-up",
                  chip.tone === "sim" && "bg-ink-400",
                  chip.tone === "degraded" && "bg-sev-high",
                )}
              />
              <span className="hidden sm:inline">{chip.label}</span>
            </span>
          )}
          {source?.demo_mode && (
            <Button
              size="sm"
              onClick={onDemo}
              disabled={demoBusy}
              className="whitespace-nowrap"
            >
              {demoBusy ? "Seeding…" : "Demo"}
            </Button>
          )}
          <button
            onClick={onSignOut}
            className="whitespace-nowrap text-xs font-medium text-ink-400 transition-colors hover:text-ink-700"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
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

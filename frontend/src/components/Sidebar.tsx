import { useEffect } from "react";
import type { MarketSource } from "@/types";
import { sourceCopy } from "@/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";

export type NavId = "brief" | "watchlist" | "history" | "manage";

const GROUPS: { label: string; items: { id: NavId; label: string }[] }[] = [
  {
    label: "Monitor",
    items: [
      { id: "brief", label: "Brief" },
      { id: "watchlist", label: "Watchlist" },
      { id: "history", label: "History" },
    ],
  },
  { label: "Configure", items: [{ id: "manage", label: "Manage" }] },
];

/**
 * Compact left sidebar. Persistent from `lg`; below that it is an off-canvas
 * drawer opened from the slim mobile top bar. Brief is the primary destination.
 */
export function Sidebar({
  active,
  onNav,
  source,
  onDemo,
  demoBusy,
  onSignOut,
  open,
  onClose,
}: {
  active: NavId;
  onNav: (id: NavId) => void;
  source: MarketSource | null;
  onDemo: () => void;
  demoBusy: boolean;
  onSignOut: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const chip = source ? sourceCopy(source) : null;

  // Close the drawer on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* backdrop (drawer only) */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-ink-900/25 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-line bg-surface transition-transform duration-200",
          "lg:sticky lg:top-0 lg:z-0 lg:h-screen lg:w-[232px] lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* logo */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
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
          <span className="text-sm font-semibold tracking-tight text-ink-900">
            Watchlist
          </span>
        </div>

        {/* nav */}
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-400">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const is = active === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        onClick={() => onNav(item.id)}
                        aria-current={is ? "page" : undefined}
                        className={cn(
                          "relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                          is
                            ? "bg-sunk text-ink-900"
                            : "text-ink-500 hover:bg-sunk/50 hover:text-ink-700",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute left-0 top-1.5 h-[calc(100%-0.75rem)] w-0.5 rounded-full bg-ink-900 transition-opacity",
                            is ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <NavIcon id={item.id} active={is} />
                        {item.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* utility */}
        <div className="shrink-0 space-y-2 border-t border-line px-3 py-3">
          {chip && (
            <span
              title={chip.help}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] font-medium",
                chip.tone === "live" && "border-up/30 bg-up/10 text-up",
                chip.tone === "sim" && "border-line bg-surface text-ink-500",
                chip.tone === "degraded" &&
                  "border-sev-high/30 bg-sev-bg-high text-sev-high",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  chip.tone === "live" && "bg-up",
                  chip.tone === "sim" && "bg-ink-400",
                  chip.tone === "degraded" && "bg-sev-high",
                )}
              />
              <span className="truncate">{chip.label}</span>
            </span>
          )}
          {source?.demo_mode && (
            <Button
              size="sm"
              onClick={onDemo}
              disabled={demoBusy}
              className="w-full"
            >
              {demoBusy ? "Seeding…" : "Demo"}
            </Button>
          )}
          <button
            onClick={onSignOut}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-ink-400 transition-colors hover:bg-sunk/50 hover:text-ink-700"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}

/** Slim top bar shown below `lg`, with the drawer toggle. */
export function MobileTopBar({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:hidden">
      <button
        onClick={onOpen}
        aria-label="Open navigation"
        className="grid h-8 w-8 place-items-center rounded-lg text-ink-600 hover:bg-sunk"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      <span className="flex items-center gap-2 text-sm font-semibold tracking-tight text-ink-900">
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
        Watchlist
      </span>
    </div>
  );
}

function NavIcon({ id, active }: { id: NavId; active: boolean }) {
  const cls = cn(
    "h-4 w-4 shrink-0",
    active ? "text-ink-700" : "text-ink-400",
  );
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: cls,
  };
  if (id === "brief")
    return (
      <svg {...common}>
        <path d="M3 12h4l3 8 4-16 3 8h4" />
      </svg>
    );
  if (id === "watchlist")
    return (
      <svg {...common}>
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
    );
  if (id === "history")
    return (
      <svg {...common}>
        <path d="M3 3v5h5" />
        <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

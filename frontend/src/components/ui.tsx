/**
 * Small presentational primitives for the light design system.
 *
 * Hand-built and dependency-free rather than pulled from a component library:
 * the set the product needs is tiny, and every one of these is a few lines of
 * Tailwind. Interactive/accessible primitives that are genuinely hard to get
 * right (the sensitivity sliders) use the native control instead.
 */
import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import type { Freshness, Severity } from "@/types";

/* --- Card ------------------------------------------------------------- */

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-card border border-line bg-surface shadow-card",
        className,
      )}
      {...props}
    />
  );
}

export function CardBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400",
        className,
      )}
    >
      {children}
    </h2>
  );
}

/* --- Button --------------------------------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        variant === "primary" &&
          "bg-ink-900 text-white hover:bg-ink-700",
        variant === "secondary" &&
          "border border-line-strong bg-surface text-ink-700 hover:bg-sunk",
        variant === "ghost" && "text-ink-500 hover:bg-sunk hover:text-ink-700",
        className,
      )}
      {...props}
    />
  );
}

/* --- Listbox (custom "select") ----------------------------------------- */

export interface ListboxOption<T extends string | number> {
  value: T;
  label: string;
}

interface ListboxProps<T extends string | number> {
  value: T;
  onChange: (value: T) => void;
  options: ListboxOption<T>[];
  /** Sizes the trigger; menu rows keep a comfortable size regardless. */
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

/**
 * A hand-rolled dropdown standing in for a native `<select>`.
 *
 * A native select can only ever be half-styled: the closed trigger is a real
 * element in the page and takes CSS fine, but the instant it opens, the
 * option list is drawn by the OS/browser shell *outside* the page — no CSS
 * reaches it, which is why it always shows the platform's own font and its
 * own (usually bright, OS-blue) highlight no matter how the control itself
 * is styled. This renders the open menu in-page instead, so every pixel of
 * it — background, border, hover state — is ours.
 *
 * Follows the ARIA "collapsible dropdown listbox" pattern: a `button` with
 * `aria-haspopup="listbox"`/`aria-expanded`, and while open,
 * `aria-activedescendant` tracks the highlighted option without ever moving
 * DOM focus off the button — so Escape, the arrow keys, and Enter all just
 * work without a separate focus-trap.
 */
export function Listbox<T extends string | number>({
  value,
  onChange,
  options,
  size = "md",
  className,
  disabled,
  "aria-label": ariaLabel,
}: ListboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openUpward, setOpenUpward] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = options[selectedIndex] ?? options[0];

  // Close on an outside click. `mousedown`, not `click`, so that clicking a
  // *different* row's trigger closes this one before that row's own click
  // handler opens it — two of these never end up open at once from a single
  // click, and one row's menu never reaches into another's.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Flip above the trigger when there isn't room below. A rough pre-paint
  // estimate of the menu's height is enough here — the option list is short
  // and a fixed row height — and avoids the flicker of a measure-then-move
  // second pass.
  useEffect(() => {
    if (!open || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const estimatedMenuHeight = options.length * 32 + 10;
    setOpenUpward(
      rect.bottom + estimatedMenuHeight > window.innerHeight &&
        rect.top > estimatedMenuHeight,
    );
  }, [open, options.length]);

  function openMenu() {
    setActiveIndex(Math.max(0, selectedIndex));
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        // Let focus move on as normal; just don't leave the menu hanging open.
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={cn(
          "flex w-full items-center justify-between gap-1.5 rounded-lg border border-line-strong bg-surface font-medium text-ink-700 shadow-card outline-none transition-colors",
          "hover:border-ink-400/70 hover:bg-sunk/40",
          "focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25",
          "active:bg-sunk/70",
          "disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "py-1 pl-2.5 pr-2 text-xs" : "py-2 pl-3 pr-2.5 text-sm",
        )}
      >
        <span className="truncate">{selected?.label}</span>
        <svg
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-400 transition-transform",
            open && "rotate-180 text-accent",
            size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5",
          )}
        >
          <path
            d="M3 4.5L6 7.25L9 4.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "absolute inset-x-0 z-20 max-h-56 overflow-auto rounded-lg border border-line bg-surface py-1 shadow-pop",
            openUpward ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {options.map((option, i) => (
            <li
              key={option.value}
              id={optionId(i)}
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => commit(i)}
              className={cn(
                "cursor-pointer px-3 py-1.5 text-sm text-ink-700 transition-colors",
                i === activeIndex && "bg-sunk",
                option.value === value && "font-semibold text-ink-900",
              )}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --- Chips & dots --------------------------------------------------- */

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  notable: "Notable",
  quiet: "Quiet",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        severity === "critical" && "bg-sev-bg-critical text-sev-critical",
        severity === "high" && "bg-sev-bg-high text-sev-high",
        severity === "notable" && "bg-sev-bg-notable text-sev-notable",
        severity === "quiet" && "bg-sev-bg-quiet text-sev-quiet",
      )}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

const FRESHNESS_DOT: Record<Freshness, string> = {
  fresh: "bg-up",
  delayed: "bg-sev-high",
  stale: "bg-down",
};

export function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "muted";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        tone === "neutral"
          ? "border-line bg-surface text-ink-500"
          : "border-transparent bg-sunk text-ink-400",
      )}
    >
      {children}
    </span>
  );
}

export function FreshnessChip({
  freshness,
  label,
  title,
}: {
  freshness: Freshness;
  label: string;
  title?: string;
}) {
  return (
    <Chip title={title}>
      <span className={cn("h-1.5 w-1.5 rounded-full", FRESHNESS_DOT[freshness])} />
      {label}
    </Chip>
  );
}

/* --- Progressive disclosure --------------------------------------- */

export function Disclosure({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: (open: boolean) => ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-ink-500 transition-colors hover:text-ink-700"
      >
        {summary(open)}
      </button>
      {open && (
        <div id={id} className="mt-3">
          {children}
        </div>
      )}
    </div>
  );
}

/* --- Skeleton ----------------------------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-sunk", className)} />
  );
}

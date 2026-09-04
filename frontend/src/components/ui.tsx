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
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
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

/* --- Select ----------------------------------------------------------- */

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  /** Sizes the control itself; the wrapping element still takes `className`. */
  size?: "sm" | "md";
};

/**
 * A native `<select>` restyled to look like a purpose-built control rather
 * than a browser default — same value/onChange/option semantics as a plain
 * select, just with a custom chevron and finished states layered on top.
 */
export function Select({ className, size = "md", ...props }: SelectProps) {
  return (
    <div className={cn("relative inline-flex", className)}>
      <select
        {...props}
        className={cn(
          "peer w-full appearance-none rounded-lg border border-line-strong bg-surface font-medium text-ink-700 shadow-card outline-none transition-colors",
          "hover:border-ink-400/70 hover:bg-sunk/40",
          "focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25",
          "active:bg-sunk/70",
          "disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "py-1 pl-2.5 pr-6 text-xs" : "py-2 pl-3 pr-8 text-sm",
        )}
      />
      <svg
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-400 transition-colors peer-hover:text-ink-600 peer-focus-visible:text-accent",
          size === "sm" ? "right-2 h-3 w-3" : "right-2.5 h-3.5 w-3.5",
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
